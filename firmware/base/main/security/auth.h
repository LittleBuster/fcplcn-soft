/**
 * @file auth.h
 * @brief Password-verifier authentication, bounded RAM sessions and account updates.
 * @details A salted PBKDF2-HMAC-SHA256 verifier is durable; session tokens are RAM-only.
 * Password work runs outside the credential mutex and uses generation checks before commit.
 */
#pragma once
#include <array>
#include <optional>
#include <string>
#include "esp_err.h"
#include "esp_http_server.h"
#include "config/settings_store.h"
struct cJSON;

/** @brief Authentication/account-change outcome, without exposing verifier details. */
enum class AuthResult {
    Ok,  ///< Login or durable account change succeeded.
    InvalidCredentials,  ///< Username/current password did not verify.
    InvalidInput,  ///< Invalid length, UTF-8 username or embedded NUL.
    RateLimited,  ///< Retry delay is active or another password derivation is running.
    StorageError,  ///< Account persistence failed or restore has frozen mutations.
    InternalError,  ///< Authentication is uninitialized or cryptography/headers failed.
};

/**
 * @brief Caller-owned storage for the non-copying ESP-IDF Set-Cookie header.
 * @details Keep this object alive until httpd_resp_send() or the final response chunk
 * completes. The authentication functions set headers but never send a response.
 */
struct AuthCookie {
    std::array<char, 192> value{};  ///< Header bytes borrowed by the HTTP response.
};

/** @brief Load the verifier or initialize the default admin account with an empty password.
 * @return ESP_OK or a cryptographic/storage error; corrupt records fail closed.
 * @pre NVS and settings_store_init() have completed. Call during startup before serving HTTP.
 * @note Idempotent after success; never erases NVS or silently replaces a corrupt account.
 */
esp_err_t auth_init();

/** @brief Check a fixed-lifetime session without sending an HTTP response.
 * @param[in] request Borrowed HTTP request; nullptr or ambiguous/invalid cookies are rejected.
 * @return True only for an unexpired initialized RAM session.
 * @note Thread-safe; updates session LRU usage but does not extend its fixed lifetime.
 */
bool auth_check_request(httpd_req_t* request);

/** @brief Verify credentials and issue or rotate a RAM session cookie.
 * @param[in] request Borrowed HTTP request, valid through response completion.
 * @param[in] username UTF-8 account name, 1..64 bytes without controls.
 * @param[in] password Password bytes, 0..128 bytes without embedded NUL.
 * @param[out] cookie Header storage that must outlive the final response send.
 * @param[in] secure_cookie True only for an actual TLS request, never an untrusted proxy header.
 * @return Login outcome; no response is sent by this function.
 * @note Thread-safe, rate-limited and task-context only; password derivation can be expensive.
 */
AuthResult auth_login(httpd_req_t* request,
                      const std::string& username,
                      const std::string& password,
                      AuthCookie& cookie,
                      bool secure_cookie = false);

/** @brief Revoke the presented session and set an expired browser cookie.
 * @param[in] request Borrowed HTTP request; must not be nullptr.
 * @param[out] cookie Header storage retained through response completion.
 * @param[in] secure_cookie True only when the actual connection is TLS.
 * @return ESP_OK or an invalid argument/header error. No response body is sent.
 * @note Thread-safe; the HTTP layer authenticates and checks Origin/Host before mutation.
 */
esp_err_t auth_logout(httpd_req_t* request, AuthCookie& cookie, bool secure_cookie = false);

/** @brief Verify the current password and atomically replace account settings.
 * @param[in] current_password Current account password, including an explicitly empty value.
 * @param[in] new_username Valid UTF-8 account name.
 * @param[in] new_password nullopt preserves the password; an empty string clears it.
 * @return Outcome. Successful persistence invalidates all sessions, including the caller.
 * @pre The HTTP layer first requires a valid session and matching Origin/Host.
 * @note Thread-safe; takes a SettingsWriteGuard before authentication/store locks.
 */
AuthResult auth_change_user(const std::string& current_password,
                            const std::string& new_username,
                            const std::optional<std::string>& new_password);

/** @brief Copy the public account name.
 * @return Username, or an empty string before successful initialization. Thread-safe.
 */
std::string auth_get_username();

/** @brief Validate a complete portable password-verifier backup section.
 * @param[in] json Borrowed object; all five verifier fields are required and duplicates rejected.
 * @param[out] record Caller-owned encoded bytes; cleared before validation.
 * @param[out] error Failure diagnostic; cleared on success.
 * @return True on success. Pure codec, with no password derivation or persistent mutation.
 */
bool auth_backup_record(const cJSON* json, SettingsBytes& record, std::string& error);

/** @brief Decode a stored verifier for an authenticated complete backup.
 * @param[in] record Borrowed account section.
 * @param[out] error Failure diagnostic; cleared on success.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on invalid record/allocation failure.
 * @note The result is sensitive: it restores the password without containing its plaintext.
 */
cJSON* auth_backup_json(const SettingsBytes& record, std::string& error);
#ifdef FCPLCN_SETTINGS_TESTING
/** @brief Reset authentication RAM while preserving fake NVS.
 * @pre All fake tasks and concurrent authentication calls have stopped.
 */
void auth_test_reset();
#endif
