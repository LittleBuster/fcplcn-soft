/**
 * @file auth.cpp
 * @brief Credential verification, rate-limited fixed-lifetime sessions and durable account changes.
 * @details PBKDF2 runs outside the credential mutex. A single verification slot bounds CPU work,
 * and a generation check rejects a result computed for replaced credentials. Account
 * mutation enters the global settings gate before taking module/store locks.
 */
#include "security/auth.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string_view>

#include "esp_random.h"
#include "esp_timer.h"
#include "cJSON.h"
#include "nvs.h"
#include "psa/crypto.h"

namespace {
constexpr char kDefaultUsername[] = "admin";
constexpr char kCookieName[] = "fcplcn_session";
constexpr std::size_t kMaxUsernameBytes = 64;
constexpr std::size_t kMaxPasswordBytes = 128;
constexpr std::size_t kSaltBytes = 16;
constexpr std::size_t kHashBytes = 32;
constexpr std::size_t kTokenBytes = 32;
constexpr std::size_t kMaxSessions = 4;
constexpr std::size_t kMaxCookieHeader = 1024;
constexpr std::uint32_t kRecordMagic = 0x46434131U;
constexpr std::uint32_t kRecordVersion = 1;
constexpr std::uint32_t kIterations = 20000;
constexpr std::uint32_t kMinStoredIterations = 20000;
constexpr std::uint32_t kMaxStoredIterations = 1000000;
constexpr std::size_t kRecordBytes = 16 + kSaltBytes + kHashBytes + kMaxUsernameBytes;
constexpr std::int64_t kSecondUs = 1000000;
constexpr std::int64_t kSessionLifetimeUs = 8LL * 60 * 60 * kSecondUs;
constexpr unsigned kSessionLifetimeSeconds = 8 * 60 * 60;

using Salt = std::array<std::uint8_t, kSaltBytes>;
using Hash = std::array<std::uint8_t, kHashBytes>;
using Token = std::array<std::uint8_t, kTokenBytes>;
using Record = std::array<std::uint8_t, kRecordBytes>;

/** @brief Owned account name and password-verifier material copied for off-lock derivation. */
struct Credentials {
    std::string username;
    Salt salt{};
    Hash hash{};
    std::uint32_t iterations = kIterations;
};

/** @brief RAM-only session token with a fixed expiry and LRU replacement timestamp. */
struct Session {
    Token token{};
    std::int64_t expires_us = 0;
    std::int64_t last_used_us = 0;
    bool active = false;
};

std::mutex g_mutex;
Credentials g_credentials;
std::array<Session, kMaxSessions> g_sessions{};
std::uint64_t g_generation = 0;
std::int64_t g_next_attempt_us = 0;
unsigned g_failures = 0;
bool g_initialized = false;
bool g_kdf_busy = false;

/**
 * @brief Overwrite temporary secret bytes through volatile stores.
 * @param[in,out] memory Writable buffer; may be nullptr only when length is zero.
 * @param[in] length Number of bytes to clear.
 * @note Does not free the buffer or clear other copies of the same secret.
 */
void wipe(void* memory, std::size_t length)
{
    auto* bytes = static_cast<volatile std::uint8_t*>(memory);
    while (length-- != 0) {
        *bytes++ = 0;
    }
}

/**
 * @brief Compare fixed-size secret values without early exit on the first differing byte.
 * @param[in] left Borrowed token-sized secret.
 * @param[in] right Borrowed token-sized secret.
 * @return True only if every byte matches.
 * @note Also accepts Hash because hash and token use the same fixed-size array type.
 */
bool equal_secret(const Token& left, const Token& right)
{
    volatile std::uint8_t difference = 0;
    for (std::size_t i = 0; i < left.size(); ++i) {
        difference = static_cast<std::uint8_t>(difference | (left[i] ^ right[i]));
    }
    return difference == 0;
}

/**
 * @brief Check the supported password byte length and embedded-NUL restriction.
 * @param[in] password Borrowed candidate; an empty password is supported.
 * @return True for at most 128 bytes without an embedded NUL.
 * @note Password bytes are not normalized or required to be UTF-8.
 */
bool valid_password(const std::string& password)
{
    return password.size() <= kMaxPasswordBytes && password.find('\0') == std::string::npos;
}

/**
 * @brief Validate an account name as bounded UTF-8 without ASCII control bytes.
 * @param[in] value Borrowed candidate, 1 through 64 encoded bytes.
 * @return True for valid UTF-8 without overlong forms, surrogates, C0 controls or DEL.
 * @note Pure byte validation; does not compare against the configured account name.
 */
bool valid_username(const std::string& value)
{
    if (value.empty() || value.size() > kMaxUsernameBytes) {
        return false;
    }
    // Validate UTF-8, including overlong encodings, surrogates and U+10FFFF.
    for (std::size_t i = 0; i < value.size();) {
        const auto first = static_cast<std::uint8_t>(value[i]);
        if (first < 0x80) {
            if (first < 0x20 || first == 0x7f) {
                return false;
            }
            ++i;
            continue;
        }
        unsigned continuation = 0;
        std::uint32_t codepoint = 0;
        std::uint32_t minimum = 0;
        if (first >= 0xc2 && first <= 0xdf) {
            continuation = 1;
            codepoint = first & 0x1f;
            minimum = 0x80;
        } else if (first >= 0xe0 && first <= 0xef) {
            continuation = 2;
            codepoint = first & 0x0f;
            minimum = 0x800;
        } else if (first >= 0xf0 && first <= 0xf4) {
            continuation = 3;
            codepoint = first & 0x07;
            minimum = 0x10000;
        } else {
            return false;
        }
        if (i + continuation >= value.size()) {
            return false;
        }
        for (unsigned n = 0; n < continuation; ++n) {
            const auto next = static_cast<std::uint8_t>(value[++i]);
            if ((next & 0xc0) != 0x80) {
                return false;
            }
            codepoint = (codepoint << 6) | (next & 0x3f);
        }
        if (codepoint < minimum || codepoint > 0x10ffff
            || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
            return false;
        }
        ++i;
    }
    return true;
}

/**
 * @brief Derive the stored PBKDF2-HMAC-SHA256 verifier through PSA Crypto.
 * @param[in] password Borrowed password bytes, including an allowed empty password.
 * @param[in] salt Fixed-size per-account salt.
 * @param[in] iterations Positive PBKDF2 work factor validated by the caller.
 * @param[out] output Derived verifier on success; cleared on setup, derivation or cleanup failure.
 * @return True only when derivation and PSA operation cleanup both succeed.
 * @pre PSA Crypto is initialized; the caller bounds iterations and serializes expensive attempts.
 * @note Performs CPU-intensive work in task context; acquires no authentication mutex itself.
 */
bool derive_password(const std::string& password,
                     const Salt& salt,
                     std::uint32_t iterations,
                     Hash& output)
{
    psa_key_derivation_operation_t operation = PSA_KEY_DERIVATION_OPERATION_INIT;
    psa_status_t status =
        psa_key_derivation_setup(&operation, PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256));
    if (status == PSA_SUCCESS) {
        status =
            psa_key_derivation_input_integer(&operation, PSA_KEY_DERIVATION_INPUT_COST, iterations);
    }
    if (status == PSA_SUCCESS) {
        status = psa_key_derivation_input_bytes(
            &operation, PSA_KEY_DERIVATION_INPUT_SALT, salt.data(), salt.size());
    }
    if (status == PSA_SUCCESS) {
        status =
            psa_key_derivation_input_bytes(&operation,
                                           PSA_KEY_DERIVATION_INPUT_PASSWORD,
                                           reinterpret_cast<const std::uint8_t*>(password.data()),
                                           password.size());
    }
    if (status == PSA_SUCCESS) {
        status = psa_key_derivation_output_bytes(&operation, output.data(), output.size());
    }
    const psa_status_t cleanup_status = psa_key_derivation_abort(&operation);
    if (status != PSA_SUCCESS || cleanup_status != PSA_SUCCESS) {
        wipe(output.data(), output.size());
        return false;
    }
    return true;
}

/**
 * @brief Write one credential-record uint32 in little-endian order.
 * @param[in,out] record Fixed-size destination record.
 * @param[in] offset First byte of the four-byte field.
 * @param[in] value Unsigned value to encode.
 * @pre offset plus four does not exceed record.size().
 */
void write_u32(Record& record, std::size_t offset, std::uint32_t value)
{
    for (unsigned i = 0; i < 4; ++i) {
        record[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
    }
}

/**
 * @brief Read one credential-record uint32 from little-endian bytes.
 * @param[in] record Borrowed fixed-size record.
 * @param[in] offset First byte of the four-byte field.
 * @return Decoded unsigned integer.
 * @pre offset plus four does not exceed record.size().
 */
std::uint32_t read_u32(const Record& record, std::size_t offset)
{
    std::uint32_t value = 0;
    for (unsigned i = 0; i < 4; ++i) {
        value |= static_cast<std::uint32_t>(record[offset + i]) << (8 * i);
    }
    return value;
}

/**
 * @brief Encode the account name, KDF parameters, salt and verifier into a fixed record.
 * @param[in] credentials Borrowed validated account settings.
 * @return Owned binary record containing sensitive verifier material.
 * @pre The username fits kMaxUsernameBytes and all KDF parameters have been validated.
 * @note Does not write Flash; callers clear temporary record copies after use.
 */
Record encode_credentials(const Credentials& credentials)
{
    Record record{};
    write_u32(record, 0, kRecordMagic);
    write_u32(record, 4, kRecordVersion);
    write_u32(record, 8, credentials.iterations);
    write_u32(record, 12, static_cast<std::uint32_t>(credentials.username.size()));
    std::copy(credentials.salt.begin(), credentials.salt.end(), record.begin() + 16);
    std::copy(credentials.hash.begin(), credentials.hash.end(), record.begin() + 32);
    std::copy(credentials.username.begin(), credentials.username.end(), record.begin() + 64);

    return record;
}

/**
 * @brief Decode and validate a fixed-size persisted credential record.
 * @param[in] bytes Borrowed account section with the exact supported record length.
 * @param[out] credentials Decoded account on success; may be assigned before final name validation.
 * @return True for supported magic/version, bounded KDF work factor and a valid username.
 * @note Clears the local binary copy before returning; the borrowed input remains unchanged.
 */
bool decode_credentials(const SettingsBytes& bytes, Credentials& credentials)
{
    if (bytes.size() != kRecordBytes)
        return false;
    Record record{};
    std::copy(bytes.begin(), bytes.end(), record.begin());
    const std::uint32_t length = read_u32(record, 12);
    const std::uint32_t iterations = read_u32(record, 8);
    if (read_u32(record, 0) != kRecordMagic || read_u32(record, 4) != kRecordVersion || length == 0
        || length > kMaxUsernameBytes || iterations < kMinStoredIterations
        || iterations > kMaxStoredIterations) {
        wipe(record.data(), record.size());
        return false;
    }
    credentials.username.assign(reinterpret_cast<const char*>(record.data() + 64), length);
    std::copy_n(record.begin() + 16, kSaltBytes, credentials.salt.begin());
    std::copy_n(record.begin() + 32, kHashBytes, credentials.hash.begin());
    credentials.iterations = iterations;
    wipe(record.data(), record.size());
    return valid_username(credentials.username);
}

/**
 * @brief Commit a verifier record as the authentication section of the settings bundle.
 * @param[in] credentials Borrowed validated account settings.
 * @return ESP_OK or the settings-store persistence/freeze error.
 * @pre The caller holds g_mutex; runtime account mutations also hold SettingsWriteGuard.
 * @note Clears temporary encoded buffers and leaves publishing credentials/sessions to the caller.
 */
esp_err_t save_credentials(const Credentials& credentials)
{
    auto record = encode_credentials(credentials);
    SettingsBytes bytes(record.begin(), record.end());
    const auto result = settings_store_set(SettingsSection::Auth, bytes);
    wipe(record.data(), record.size());
    wipe(bytes.data(), bytes.size());
    return result;
}

/**
 * @brief Load and validate the persisted authentication section.
 * @param[out] credentials Decoded account on success; may change on a final decode failure.
 * @return ESP_OK, the settings-store read error, or ESP_ERR_INVALID_STATE for malformed bytes.
 * @pre The caller serializes authentication initialization with g_mutex.
 * @note Clears the temporary section bytes and never creates or repairs a missing account.
 */
esp_err_t load_credentials(Credentials& credentials)
{
    SettingsBytes bytes;
    const auto result = settings_store_get(SettingsSection::Auth, bytes);
    if (result != ESP_OK)
        return result;
    const bool valid = decode_credentials(bytes, credentials);
    wipe(bytes.data(), bytes.size());
    return valid ? ESP_OK : ESP_ERR_INVALID_STATE;
}

/**
 * @brief Revoke every RAM session whose fixed lifetime has elapsed.
 * @param[in] now Current monotonic microseconds from esp_timer_get_time().
 * @pre The caller holds g_mutex.
 * @note Clears token and LRU metadata; active sessions are never extended by this function.
 */
void expire_sessions(std::int64_t now)
{
    for (auto& session : g_sessions) {
        if (session.active && now >= session.expires_us) {
            session = Session{};
        }
    }
}

/**
 * @brief Decode one case-insensitive hexadecimal digit.
 * @param[in] value Candidate ASCII byte.
 * @return Integer 0 through 15, or -1 for a non-hexadecimal byte.
 */
int hex_value(char value)
{
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    if (value >= 'A' && value <= 'F') {
        return value - 'A' + 10;
    }
    return -1;
}

/**
 * @brief Decode the single unambiguous FCPLCn session cookie from a bounded HTTP header.
 * @param[in] request Borrowed request; nullptr or an unreadable/oversized Cookie header is
 * rejected.
 * @param[out] token Decoded bytes on success; cleared after a parsed missing or malformed cookie.
 * @return True only for exactly one correctly named cookie with a complete hexadecimal token.
 * @note Early request/header failures leave token unchanged. Temporary header storage is cleared
 * when populated; this parser does not authenticate the decoded token or acquire g_mutex.
 */
bool request_token(httpd_req_t* request, Token& token)
{
    if (request == nullptr) {
        return false;
    }
    const std::size_t length = httpd_req_get_hdr_value_len(request, "Cookie");
    if (length == 0 || length > kMaxCookieHeader) {
        return false;
    }
    std::array<char, kMaxCookieHeader + 1> header{};
    if (httpd_req_get_hdr_value_str(request, "Cookie", header.data(), header.size()) != ESP_OK) {
        return false;
    }
    std::string_view remaining(header.data(), length);
    bool found = false;
    bool valid = true;
    while (!remaining.empty()) {
        const auto separator = remaining.find(';');
        auto item = remaining.substr(0, separator);
        while (!item.empty() && (item.front() == ' ' || item.front() == '\t')) {
            item.remove_prefix(1);
        }
        while (!item.empty() && (item.back() == ' ' || item.back() == '\t')) {
            item.remove_suffix(1);
        }
        const auto equals = item.find('=');
        if (equals != std::string_view::npos && item.substr(0, equals) == kCookieName) {
            if (found) {
                valid = false;  // Reject ambiguous duplicate session cookies.
                break;
            }
            found = true;
            const auto value = item.substr(equals + 1);
            if (value.size() != token.size() * 2) {
                valid = false;
                break;
            }
            for (std::size_t i = 0; i < token.size(); ++i) {
                const int high = hex_value(value[2 * i]);
                const int low = hex_value(value[2 * i + 1]);
                if (high < 0 || low < 0) {
                    valid = false;
                    break;
                }
                token[i] = static_cast<std::uint8_t>((high << 4) | low);
            }
        }
        if (separator == std::string_view::npos) {
            break;
        }
        remaining.remove_prefix(separator + 1);
    }
    wipe(header.data(), header.size());
    if (!found || !valid) {
        wipe(token.data(), token.size());
    }
    return found && valid;
}

/**
 * @brief Advance the bounded authentication failure counter and retry backoff.
 * @param[in] now Current monotonic microseconds at the failed verification.
 * @pre The caller holds g_mutex.
 * @note Starting with the third failure, the delay doubles from one second up to 30 seconds.
 * This records a future admission deadline and does not block or sleep the calling task.
 */
void failed_attempt(std::int64_t now)
{
    g_failures = std::min(g_failures + 1, 12U);
    if (g_failures >= 3) {
        const unsigned delay_seconds = std::min(1U << std::min(g_failures - 3, 5U), 30U);
        g_next_attempt_us = now + delay_seconds * kSecondUs;
    }
}

/** @brief RAII ownership of the single admitted expensive password-verification slot. */
struct VerificationGuard {
    bool owns = false;

    /**
     * @brief Release an owned password-verification slot on every function-exit path.
     * @note Acquires g_mutex only when owns is true; destruction must occur without that mutex
     * held.
     */
    ~VerificationGuard()
    {
        if (owns) {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_kdf_busy = false;
        }
    }
};

/**
 * @brief Reserve the single expensive-verification slot and snapshot the current account.
 * @param[out] credentials Independent verifier snapshot for derivation outside g_mutex.
 * @param[out] generation Account-generation token for rejecting results after credential changes.
 * @param[in,out] guard Receives slot ownership only on success.
 * @return Ok, RateLimited for a busy slot/backoff, or InternalError before initialization.
 * @pre guard does not already own a slot; the caller does not hold g_mutex.
 * @note Locks g_mutex briefly and leaves expensive password derivation to the caller.
 */
AuthResult
start_verification(Credentials& credentials, std::uint64_t& generation, VerificationGuard& guard)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_initialized) {
        return AuthResult::InternalError;
    }
    if (g_kdf_busy || esp_timer_get_time() < g_next_attempt_us) {
        return AuthResult::RateLimited;
    }
    credentials = g_credentials;
    generation = g_generation;
    g_kdf_busy = true;
    guard.owns = true;
    return AuthResult::Ok;
}

/**
 * @brief Format and attach a fixed-lifetime, HttpOnly session cookie header.
 * @param[in] request Borrowed live HTTP request.
 * @param[in] token Session token to encode as lowercase hexadecimal.
 * @param[out] cookie Header storage that must remain valid through the final response send.
 * @param[in] secure Whether the actual request uses TLS and requires the Secure attribute.
 * @return ESP_OK, ESP_ERR_INVALID_SIZE, or the HTTP header-setting error.
 * @note Sets SameSite=Strict and Path=/, clears temporary token text and sends no response body.
 */
esp_err_t
set_session_cookie(httpd_req_t* request, const Token& token, AuthCookie& cookie, bool secure)
{
    std::array<char, kTokenBytes * 2 + 1> encoded{};
    constexpr char digits[] = "0123456789abcdef";
    for (std::size_t i = 0; i < token.size(); ++i) {
        encoded[2 * i] = digits[token[i] >> 4];
        encoded[2 * i + 1] = digits[token[i] & 0x0f];
    }
    const int count = std::snprintf(cookie.value.data(),
                                    cookie.value.size(),
                                    "%s=%s; Max-Age=%u; HttpOnly; SameSite=Strict; Path=/%s",
                                    kCookieName,
                                    encoded.data(),
                                    kSessionLifetimeSeconds,
                                    secure ? "; Secure" : "");
    wipe(encoded.data(), encoded.size());
    if (count < 0 || static_cast<std::size_t>(count) >= cookie.value.size()) {
        return ESP_ERR_INVALID_SIZE;
    }
    return httpd_resp_set_hdr(request, "Set-Cookie", cookie.value.data());
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Load the verifier or initialize the default admin account with an empty password.
 * @return ESP_OK or a cryptographic/storage error; corrupt records fail closed.
 * @pre NVS and settings_store_init() have completed. Call during startup before serving HTTP.
 * @note Idempotent after success; never erases NVS or silently replaces a corrupt account.
 * @endcond
 */
esp_err_t auth_init()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_initialized) {
        return ESP_OK;
    }
    if (psa_crypto_init() != PSA_SUCCESS) {
        return ESP_FAIL;
    }
    Credentials credentials;
    esp_err_t result = load_credentials(credentials);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        credentials.username = kDefaultUsername;
        esp_fill_random(credentials.salt.data(), credentials.salt.size());
        if (!derive_password("", credentials.salt, credentials.iterations, credentials.hash)) {
            return ESP_FAIL;
        }
        result = save_credentials(credentials);
    }
    if (result != ESP_OK) {
        return result;
    }
    g_credentials = credentials;
    g_generation = 1;
    g_sessions = {};
    g_initialized = true;
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Check a fixed-lifetime session without sending an HTTP response.
 * @param[in] request Borrowed HTTP request; nullptr or ambiguous/invalid cookies are rejected.
 * @return True only for an unexpired initialized RAM session.
 * @note Thread-safe; updates session LRU usage but does not extend its fixed lifetime.
 * @endcond
 */
bool auth_check_request(httpd_req_t* request)
{
    Token token{};
    if (!request_token(request, token)) {
        return false;
    }
    std::lock_guard<std::mutex> lock(g_mutex);
    const auto now = esp_timer_get_time();
    expire_sessions(now);
    bool authenticated = false;
    if (g_initialized) {
        for (auto& session : g_sessions) {
            if (session.active && equal_secret(session.token, token)) {
                session.last_used_us = now;
                authenticated = true;
                break;
            }
        }
    }
    wipe(token.data(), token.size());
    return authenticated;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Verify credentials and issue or rotate a RAM session cookie.
 * @param[in] request Borrowed HTTP request, valid through response completion.
 * @param[in] username UTF-8 account name, 1..64 bytes without controls.
 * @param[in] password Password bytes, 0..128 bytes without embedded NUL.
 * @param[out] cookie Header storage that must outlive the final response send.
 * @param[in] secure_cookie True only for an actual TLS request, never an untrusted proxy header.
 * @return Login outcome; no response is sent by this function.
 * @note Thread-safe, rate-limited and task-context only; password derivation can be expensive.
 * @endcond
 */
AuthResult auth_login(httpd_req_t* request,
                      const std::string& username,
                      const std::string& password,
                      AuthCookie& cookie,
                      bool secure_cookie)
{
    if (request == nullptr || !valid_username(username) || !valid_password(password)) {
        return AuthResult::InvalidInput;
    }
    Credentials credentials;
    std::uint64_t generation = 0;
    VerificationGuard verification;
    const auto begin = start_verification(credentials, generation, verification);
    if (begin != AuthResult::Ok) {
        return begin;
    }
    Hash derived{};
    if (!derive_password(password, credentials.salt, credentials.iterations, derived)) {
        return AuthResult::InternalError;
    }
    const bool password_matches = equal_secret(derived, credentials.hash);
    wipe(derived.data(), derived.size());
    std::lock_guard<std::mutex> lock(g_mutex);
    if (generation != g_generation) {
        return AuthResult::InvalidCredentials;
    }
    const auto now = esp_timer_get_time();
    if (!password_matches || username != credentials.username) {
        failed_attempt(now);
        return AuthResult::InvalidCredentials;
    }

    expire_sessions(now);
    Token previous_token{};
    const bool has_previous = request_token(request, previous_token);
    std::size_t chosen = kMaxSessions;
    if (has_previous) {
        for (std::size_t i = 0; i < g_sessions.size(); ++i) {
            if (g_sessions[i].active && equal_secret(g_sessions[i].token, previous_token)) {
                chosen = i;
                break;
            }
        }
    }
    if (chosen == kMaxSessions) {
        for (std::size_t i = 0; i < g_sessions.size(); ++i) {
            if (!g_sessions[i].active) {
                chosen = i;
                break;
            }
        }
    }
    wipe(previous_token.data(), previous_token.size());
    if (chosen == kMaxSessions) {
        chosen = static_cast<std::size_t>(
            std::min_element(g_sessions.begin(),
                             g_sessions.end(),
                             [](const Session& left, const Session& right) {
                                 return left.last_used_us < right.last_used_us;
                             })
            - g_sessions.begin());
    }
    Session replacement{};
    esp_fill_random(replacement.token.data(), replacement.token.size());
    replacement.active = true;
    replacement.last_used_us = now;
    replacement.expires_us = now + kSessionLifetimeUs;
    if (set_session_cookie(request, replacement.token, cookie, secure_cookie) != ESP_OK) {
        wipe(replacement.token.data(), replacement.token.size());
        return AuthResult::InternalError;
    }
    g_sessions[chosen] = replacement;
    wipe(replacement.token.data(), replacement.token.size());
    g_failures = 0;
    g_next_attempt_us = 0;
    return AuthResult::Ok;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Revoke the presented session and set an expired browser cookie.
 * @param[in] request Borrowed HTTP request; must not be nullptr.
 * @param[out] cookie Header storage retained through response completion.
 * @param[in] secure_cookie True only when the actual connection is TLS.
 * @return ESP_OK or an invalid argument/header error. No response body is sent.
 * @note Thread-safe; the HTTP layer authenticates and checks Origin/Host before mutation.
 * @endcond
 */
esp_err_t auth_logout(httpd_req_t* request, AuthCookie& cookie, bool secure_cookie)
{
    if (request == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    Token token{};
    if (request_token(request, token)) {
        std::lock_guard<std::mutex> lock(g_mutex);
        for (auto& session : g_sessions) {
            if (session.active && equal_secret(session.token, token)) {
                session = Session{};
            }
        }
    }
    wipe(token.data(), token.size());
    const int count = std::snprintf(cookie.value.data(),
                                    cookie.value.size(),
                                    "%s=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/%s",
                                    kCookieName,
                                    secure_cookie ? "; Secure" : "");
    if (count < 0 || static_cast<std::size_t>(count) >= cookie.value.size()) {
        return ESP_ERR_INVALID_SIZE;
    }
    return httpd_resp_set_hdr(request, "Set-Cookie", cookie.value.data());
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Verify the current password and atomically replace account settings.
 * @param[in] current_password Current account password, including an explicitly empty value.
 * @param[in] new_username Valid UTF-8 account name.
 * @param[in] new_password nullopt preserves the password; an empty string clears it.
 * @return Outcome. Successful persistence invalidates all sessions, including the caller.
 * @pre The HTTP layer first requires a valid session and matching Origin/Host.
 * @note Thread-safe; takes a SettingsWriteGuard before authentication/store locks.
 * @endcond
 */
AuthResult auth_change_user(const std::string& current_password,
                            const std::string& new_username,
                            const std::optional<std::string>& new_password)
{
    SettingsWriteGuard write;
    if (!write)
        return AuthResult::StorageError;
    if (!valid_username(new_username) || !valid_password(current_password)
        || (new_password.has_value() && !valid_password(*new_password))) {
        return AuthResult::InvalidInput;
    }
    Credentials credentials;
    std::uint64_t generation = 0;
    VerificationGuard verification;
    const auto begin = start_verification(credentials, generation, verification);
    if (begin != AuthResult::Ok) {
        return begin;
    }
    Hash derived{};
    if (!derive_password(current_password, credentials.salt, credentials.iterations, derived)) {
        return AuthResult::InternalError;
    }
    const bool password_matches = equal_secret(derived, credentials.hash);
    wipe(derived.data(), derived.size());
    if (!password_matches) {
        std::lock_guard<std::mutex> lock(g_mutex);
        failed_attempt(esp_timer_get_time());
        return AuthResult::InvalidCredentials;
    }
    credentials.username = new_username;
    if (new_password.has_value()) {
        credentials.iterations = kIterations;
        esp_fill_random(credentials.salt.data(), credentials.salt.size());
        if (!derive_password(
                *new_password, credentials.salt, credentials.iterations, credentials.hash)) {
            return AuthResult::InternalError;
        }
    }
    std::lock_guard<std::mutex> lock(g_mutex);
    if (generation != g_generation) {
        return AuthResult::InvalidCredentials;
    }
    if (save_credentials(credentials) != ESP_OK) {
        return AuthResult::StorageError;
    }
    g_credentials = credentials;
    ++g_generation;
    g_sessions = {};
    g_failures = 0;
    g_next_attempt_us = 0;
    return AuthResult::Ok;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy the public account name.
 * @return Username, or an empty string before successful initialization. Thread-safe.
 * @endcond
 */
std::string auth_get_username()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_initialized ? g_credentials.username : std::string{};
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate a complete portable password-verifier backup section.
 * @param[in] json Borrowed object; all five verifier fields are required and duplicates rejected.
 * @param[out] record Caller-owned encoded bytes; cleared before validation.
 * @param[out] error Failure diagnostic; cleared on success.
 * @return True on success. Pure codec, with no password derivation or persistent mutation.
 * @endcond
 */
bool auth_backup_record(const cJSON* json, SettingsBytes& record, std::string& error)
{
    record.clear();
    const auto invalid = [&] {
        error = "Некорректная учётная запись в конфигурации";
        return false;
    };
    if (!cJSON_IsObject(json))
        return invalid();
    constexpr std::array<const char*, 5> fields{
        {"username", "algorithm", "iterations", "salt", "hash"}};
    unsigned seen = 0;
    for (const auto* field = json->child; field; field = field->next) {
        unsigned bit = 0;
        for (unsigned i = 0; i < fields.size(); ++i)
            if (field->string && std::strcmp(field->string, fields[i]) == 0)
                bit = 1U << i;
        if (bit == 0 || (seen & bit))
            return invalid();
        seen |= bit;
    }
    if (seen != 31)
        return invalid();
    const auto* username = cJSON_GetObjectItemCaseSensitive(json, "username");
    const auto* algorithm = cJSON_GetObjectItemCaseSensitive(json, "algorithm");
    const auto* iterations = cJSON_GetObjectItemCaseSensitive(json, "iterations");
    const auto* salt = cJSON_GetObjectItemCaseSensitive(json, "salt");
    const auto* hash = cJSON_GetObjectItemCaseSensitive(json, "hash");
    if (!cJSON_IsString(username) || !username->valuestring
        || !valid_username(username->valuestring) || !cJSON_IsString(algorithm)
        || !algorithm->valuestring || std::strcmp(algorithm->valuestring, "PBKDF2-HMAC-SHA256") != 0
        || !cJSON_IsNumber(iterations) || !std::isfinite(iterations->valuedouble)
        || std::floor(iterations->valuedouble) != iterations->valuedouble
        || iterations->valuedouble < kMinStoredIterations
        || iterations->valuedouble > kMaxStoredIterations || !cJSON_IsString(salt)
        || !salt->valuestring || std::strlen(salt->valuestring) != 2 * kSaltBytes
        || !cJSON_IsString(hash) || !hash->valuestring
        || std::strlen(hash->valuestring) != 2 * kHashBytes)
        return invalid();
    Credentials credentials;
    credentials.username = username->valuestring;
    credentials.iterations = static_cast<std::uint32_t>(iterations->valuedouble);
    const auto from_hex = [](const char* text, auto& bytes) {
        for (std::size_t i = 0; i < bytes.size(); ++i) {
            const int hi = hex_value(text[i * 2]), lo = hex_value(text[i * 2 + 1]);
            if (hi < 0 || lo < 0)
                return false;
            bytes[i] = static_cast<std::uint8_t>((hi << 4) | lo);
        }
        return true;
    };
    if (!from_hex(salt->valuestring, credentials.salt)
        || !from_hex(hash->valuestring, credentials.hash))
        return invalid();
    auto encoded = encode_credentials(credentials);
    record.assign(encoded.begin(), encoded.end());
    wipe(encoded.data(), encoded.size());
    error.clear();
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decode a stored verifier for an authenticated complete backup.
 * @param[in] record Borrowed account section.
 * @param[out] error Failure diagnostic; cleared on success.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on invalid record/allocation failure.
 * @note The result is sensitive: it restores the password without containing its plaintext.
 * @endcond
 */
cJSON* auth_backup_json(const SettingsBytes& record, std::string& error)
{
    Credentials credentials;
    if (!decode_credentials(record, credentials)) {
        error = "Сохранённая учётная запись повреждена";
        return nullptr;
    }
    const auto to_hex = [](const auto& bytes) {
        constexpr char hex[] = "0123456789abcdef";
        std::string result(bytes.size() * 2, '0');
        for (std::size_t i = 0; i < bytes.size(); ++i) {
            result[i * 2] = hex[bytes[i] >> 4];
            result[i * 2 + 1] = hex[bytes[i] & 15];
        }
        return result;
    };
    auto* json = cJSON_CreateObject();
    if (!json || !cJSON_AddStringToObject(json, "username", credentials.username.c_str())
        || !cJSON_AddStringToObject(json, "algorithm", "PBKDF2-HMAC-SHA256")
        || !cJSON_AddNumberToObject(json, "iterations", credentials.iterations)
        || !cJSON_AddStringToObject(json, "salt", to_hex(credentials.salt).c_str())
        || !cJSON_AddStringToObject(json, "hash", to_hex(credentials.hash).c_str())) {
        cJSON_Delete(json);
        error = "Недостаточно памяти для резервной копии учётной записи";
        return nullptr;
    }
    error.clear();
    return json;
}

#ifdef FCPLCN_SETTINGS_TESTING
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Reset authentication RAM while preserving fake NVS.
 * @pre All fake tasks and concurrent authentication calls have stopped.
 * @endcond
 */
void auth_test_reset()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_credentials = Credentials{};
    g_sessions = {};
    g_generation = 0;
    g_next_attempt_us = 0;
    g_failures = 0;
    g_initialized = false;
    g_kdf_busy = false;
}
#endif
