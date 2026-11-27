/**
 * @file firmware_update.cpp
 * @brief Sequential inactive-slot OTA, transport hash verification and atomic boot selection.
 * @details A single bounded chunk is decoded at a time. The first app header and FCPLCn identity
 * are checked before erase/write; ESP-IDF verifies the complete image before changing otadata.
 * Lost connections leave the running application selected. No partial upload is resumed or
 * replayed.
 */
#include "system/firmware_update.h"
#include "config/settings_json.h"
#include "config/settings_store.h"
#include "platform/operation_context.h"
#include "product_identity.h"
#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_ota_ops.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "psa/crypto.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace {
constexpr std::int64_t kUploadIdleUs = 60'000'000;
constexpr std::size_t kAppPrefixBytes =
    sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) + sizeof(esp_app_desc_t);
std::mutex update_mutex;
enum class UploadState { Idle, Receiving, Ready, Error };
UploadState state = UploadState::Idle;
const esp_partition_t* target = nullptr;
esp_ota_handle_t handle = 0;
bool handle_open = false, restart_reserved = false;
std::string upload_id, version, image_id, diagnostic;
std::size_t expected_size = 0, received = 0;
std::int64_t touched_us = 0;
std::array<unsigned char, 32> expected_sha{};
psa_hash_operation_t hash_operation = PSA_HASH_OPERATION_INIT;

/**
 * @brief Create an owned HTTP-compatible error response.
 * @param[in] status HTTP-compatible failure classification.
 * @param[in] message Borrowed public diagnostic copied into JSON.
 * @return Owned error JSON for the transport to release.
 */
FirmwareUpdateResult failure(int status, const char* message)
{
    auto* data = cJSON_CreateObject();
    cJSON_AddStringToObject(data, "error", message);
    return {status, data, false};
}

/**
 * @brief Create an owned successful upload acknowledgement with its committed byte count.
 * @return Owned ok/received JSON while update_mutex is held.
 */
FirmwareUpdateResult acknowledgement()
{
    auto* data = cJSON_CreateObject();
    cJSON_AddBoolToObject(data, "ok", true);
    cJSON_AddNumberToObject(data, "received", received);
    return {200, data, false};
}

/** @brief Release SDK/hash handles without touching the currently selected boot partition. */
void discard()
{
    if (handle_open)
        esp_ota_abort(handle);
    handle_open = false;
    psa_hash_abort(&hash_operation);
}

/**
 * @brief Abort an incomplete image and retain a user-visible diagnostic.
 * @param[in] status HTTP-compatible failure classification.
 * @param[in] message Public diagnostic retained in upload state and copied into JSON.
 * @return Owned diagnostic; no active app or configuration is changed.
 */
FirmwareUpdateResult abort_error(int status, const char* message)
{
    discard();
    state = UploadState::Error;
    diagnostic = message;
    return failure(status, message);
}

/** @brief Drop abandoned resources while holding update_mutex. */
void expire()
{
    if (state == UploadState::Receiving && esp_timer_get_time() - touched_us >= kUploadIdleUs) {
        discard();
        state = UploadState::Error;
        diagnostic = "Загрузка прервана: более 60 секунд нет данных";
    }
}

/**
 * @brief Decode one hexadecimal digit without accepting whitespace or prefixes.
 * @param[in] ch Candidate hexadecimal character.
 * @return Value zero through 15, or -1 for invalid input.
 */
int hex_digit(char ch)
{
    if (ch >= '0' && ch <= '9')
        return ch - '0';
    if (ch >= 'a' && ch <= 'f')
        return ch - 'a' + 10;
    return ch >= 'A' && ch <= 'F' ? ch - 'A' + 10 : -1;
}

/**
 * @brief Format the ELF fingerprint identifying an exact build even when versions are equal.
 * @param[in] bytes Borrowed 32-byte SDK build fingerprint.
 * @return Exactly 64 lowercase hexadecimal characters.
 */
std::string fingerprint(const unsigned char* bytes)
{
    char formatted[65]{};
    for (std::size_t i = 0; i < 32; ++i)
        std::snprintf(formatted + 2 * i, 3, "%02x", bytes[i]);
    return formatted;
}

/**
 * @brief Decode exactly one declared full-file SHA-256.
 * @param[in] body Borrowed declaration containing sha256.
 * @param[out] output Binary digest filled from bounded hexadecimal input.
 * @return True for exactly 64 valid hexadecimal characters.
 */
bool parse_sha(const cJSON* body, std::array<unsigned char, 32>& output)
{
    const auto* sha = cJSON_GetObjectItemCaseSensitive(body, "sha256");
    if (!cJSON_IsString(sha) || !sha->valuestring || std::strlen(sha->valuestring) != 64)
        return false;
    for (std::size_t i = 0; i < output.size(); ++i) {
        const auto a = hex_digit(sha->valuestring[2 * i]);
        const auto b = hex_digit(sha->valuestring[2 * i + 1]);
        if (a < 0 || b < 0)
            return false;
        output[i] = static_cast<unsigned char>((a << 4) | b);
    }
    return true;
}

/**
 * @brief Validate a finite, nonnegative JSON integer before converting it to size_t.
 * @param[in] value Borrowed candidate JSON number.
 * @param[in] maximum Inclusive conversion and operation bound.
 * @param[out] result Converted size only when validation succeeds.
 * @return True for an integral nonnegative value within the bound.
 */
bool unsigned_size(const cJSON* value, std::size_t maximum, std::size_t& result)
{
    if (!cJSON_IsNumber(value) || !std::isfinite(value->valuedouble) || value->valuedouble < 0
        || value->valuedouble > static_cast<double>(maximum)
        || std::floor(value->valuedouble) != value->valuedouble)
        return false;
    result = static_cast<std::size_t>(value->valuedouble);
    return true;
}

/**
 * @brief Check the unpredictable session identifier under the OTA mutex.
 * @param[in] body Borrowed request containing uploadId.
 * @return True only for the current nonempty session token.
 */
bool matching_upload(const cJSON* body)
{
    const auto* id = cJSON_GetObjectItemCaseSensitive(body, "uploadId");
    return cJSON_IsString(id) && id->valuestring && upload_id == id->valuestring
           && !upload_id.empty();
}

/**
 * @brief Convert one regular Base64 alphabet byte; padding is handled separately.
 * @param[in] ch Candidate Base64 alphabet byte.
 * @return Six-bit value, or -1 for invalid input or padding.
 */
int base64_digit(char ch)
{
    if (ch >= 'A' && ch <= 'Z')
        return ch - 'A';
    if (ch >= 'a' && ch <= 'z')
        return ch - 'a' + 26;
    if (ch >= '0' && ch <= '9')
        return ch - '0' + 52;
    return ch == '+' ? 62 : ch == '/' ? 63 : -1;
}

/**
 * @brief Decode canonical padded Base64 into at most one bounded chunk.
 * @param[in] body Borrowed JSON containing encoded data.
 * @param[out] output Owned decoded bytes, bounded by kFirmwareChunkBytes.
 * @return True for canonical, nonempty Base64 with valid final padding bits.
 */
bool decode_chunk(const cJSON* body, std::vector<unsigned char>& output)
{
    const auto* data = cJSON_GetObjectItemCaseSensitive(body, "data");
    if (!cJSON_IsString(data) || !data->valuestring)
        return false;
    const std::string_view text(data->valuestring);
    if (text.empty() || text.size() % 4 != 0 || text.size() > kFirmwareChunkBytes / 3 * 4)
        return false;
    output.reserve(text.size() / 4 * 3);
    for (std::size_t i = 0; i < text.size(); i += 4) {
        const auto a = base64_digit(text[i]), b = base64_digit(text[i + 1]);
        const auto c = base64_digit(text[i + 2]), d = base64_digit(text[i + 3]);
        const bool pad_c = text[i + 2] == '=', pad_d = text[i + 3] == '=';
        if (a < 0 || b < 0 || (c < 0 && !pad_c) || (d < 0 && !pad_d) || (pad_c && !pad_d)
            || ((pad_c || pad_d) && i + 4 != text.size()) || (pad_c && (b & 15))
            || (pad_d && !pad_c && (c & 3)))
            return false;
        output.push_back(static_cast<unsigned char>((a << 2) | (b >> 4)));
        if (!pad_c)
            output.push_back(static_cast<unsigned char>((b << 4) | (c >> 2)));
        if (!pad_d)
            output.push_back(static_cast<unsigned char>((c << 6) | d));
    }
    return output.size() <= kFirmwareChunkBytes;
}

/**
 * @brief Reject non-app, merged, wrong-chip and foreign-product files before flash is erased.
 * @param[in] bytes Borrowed first chunk beginning at image offset zero.
 * @return True for a FCPLCn ESP32-S3 app prefix, retaining its bounded metadata.
 */
bool valid_prefix(const std::vector<unsigned char>& bytes)
{
    if (bytes.size() < kAppPrefixBytes)
        return false;
    esp_image_header_t image{};
    esp_image_segment_header_t segment{};
    esp_app_desc_t description{};
    std::memcpy(&image, bytes.data(), sizeof(image));
    std::memcpy(&segment, bytes.data() + sizeof(image), sizeof(segment));
    std::memcpy(&description, bytes.data() + sizeof(image) + sizeof(segment), sizeof(description));
    if (image.magic != ESP_IMAGE_HEADER_MAGIC || image.chip_id != ESP_CHIP_ID_ESP32S3
        || image.segment_count == 0 || image.segment_count > ESP_IMAGE_MAX_SEGMENTS
        || segment.data_len < sizeof(description)
        || description.magic_word != ESP_APP_DESC_MAGIC_WORD
        || std::strncmp(
               description.project_name, FCPLCN_PRODUCT_NAME, sizeof(description.project_name))
               != 0
        || !std::memchr(description.version, '\0', sizeof(description.version)))
        return false;
    version = description.version;
    if (version == "0.0.0" || version.find("tooling-check") != std::string::npos)
        return false;
    image_id = fingerprint(description.app_elf_sha256);
    return true;
}

/**
 * @brief Expose bounded metadata without any firmware bytes, secrets or session identifier.
 * @return Owned public upload and running-build metadata.
 */
FirmwareUpdateResult snapshot()
{
    auto* data = cJSON_CreateObject();
    const auto* partition = esp_ota_get_next_update_partition(nullptr);
    const auto* running = esp_ota_get_running_partition();
    cJSON_AddBoolToObject(data, "supported", partition != nullptr);
    cJSON_AddNumberToObject(data, "maxSize", partition ? partition->size : 0);
    cJSON_AddNumberToObject(data, "chunkSize", kFirmwareChunkBytes);
    const auto* name = state == UploadState::Receiving ? "receiving"
                       : state == UploadState::Ready   ? "ready"
                       : state == UploadState::Error   ? "error"
                                                       : "idle";
    cJSON_AddStringToObject(data, "state", name);
    cJSON_AddNumberToObject(data, "received", received);
    cJSON_AddNumberToObject(data, "size", expected_size);
    cJSON_AddStringToObject(data, "version", esp_app_get_description()->version);
    cJSON_AddStringToObject(
        data, "imageId", fingerprint(esp_app_get_description()->app_elf_sha256).c_str());
    cJSON_AddStringToObject(data, "targetVersion", version.c_str());
    cJSON_AddStringToObject(data, "targetImageId", image_id.c_str());
    cJSON_AddStringToObject(data, "targetPartition", target ? target->label : "");
    cJSON_AddStringToObject(data, "runningPartition", running ? running->label : "unknown");
    cJSON_AddBoolToObject(data, "pendingReboot", state == UploadState::Ready);
    if (!diagnostic.empty())
        cJSON_AddStringToObject(data, "error", diagnostic.c_str());
    return {200, data, false};
}

/**
 * @brief Reserve a fresh hash/session without erasing any flash until the first valid app chunk.
 * @param[in] body Borrowed exact size/sha256 declaration.
 * @return Owned session acknowledgement with token/chunk limit, or an error.
 */
FirmwareUpdateResult begin(const cJSON* body)
{
    if (state == UploadState::Receiving || state == UploadState::Ready || restart_reserved
        || settings_restore_pending())
        return failure(409, "Уже выполняется загрузка или ожидается перезагрузка");
    const auto* partition = esp_ota_get_next_update_partition(nullptr);
    std::size_t size = 0;
    std::array<unsigned char, 32> sha{};
    if (!partition)
        return failure(503, "Нет свободного раздела для обновления");
    if (!settings_json_fields(body, {"size", "sha256"})
        || !unsigned_size(cJSON_GetObjectItemCaseSensitive(body, "size"), partition->size, size)
        || size < kAppPrefixBytes || !parse_sha(body, sha))
        return failure(400, "Укажите бинарник приложения FCPLCn подходящего размера и SHA-256");
    discard();
    if (psa_crypto_init() != PSA_SUCCESS
        || psa_hash_setup(&hash_operation, PSA_ALG_SHA_256) != PSA_SUCCESS)
        return abort_error(503, "Не удалось подготовить проверку прошивки");
    std::array<unsigned char, 16> random{};
    esp_fill_random(random.data(), random.size());
    char token[33]{};
    for (std::size_t i = 0; i < random.size(); ++i)
        std::snprintf(token + 2 * i, 3, "%02x", random[i]);
    target = partition;
    expected_sha = sha;
    expected_size = size;
    received = 0;
    upload_id = token;
    diagnostic.clear();
    version.clear();
    image_id.clear();
    touched_us = esp_timer_get_time();
    state = UploadState::Receiving;
    auto result = acknowledgement();
    cJSON_AddStringToObject(result.data, "uploadId", upload_id.c_str());
    cJSON_AddNumberToObject(result.data, "chunkSize", kFirmwareChunkBytes);
    return result;
}

/**
 * @brief Persist exactly the next bounded app chunk after checking its offset and remote deadline.
 * @param[in] body Borrowed exact uploadId/offset/data object.
 * @return Owned acknowledgement of bytes persisted, or an error without boot selection.
 */
FirmwareUpdateResult chunk(const cJSON* body)
{
    if (!settings_json_fields(body, {"uploadId", "offset", "data"}))
        return failure(400, "Некорректные поля фрагмента прошивки");
    if (state != UploadState::Receiving || !matching_upload(body))
        return failure(409, "Загрузка завершена, прервана или принадлежит другой сессии");
    std::size_t offset = 0;
    std::vector<unsigned char> bytes;
    if (!unsigned_size(cJSON_GetObjectItemCaseSensitive(body, "offset"), expected_size, offset)
        || offset != received)
        return failure(409, "Неверный порядок фрагментов; начните загрузку заново");
    if (!decode_chunk(body, bytes) || bytes.size() > expected_size - received)
        return failure(400, "Некорректный или слишком большой фрагмент прошивки");
    if (received == 0) {
        if (!valid_prefix(bytes))
            return abort_error(
                400, "Нужен FCPLCn.bin для ESP32-S3; полный образ и чужая прошивка не подходят");
        if (!operation_permitted())
            return failure(409, "Срок запроса истёк или соединение сменилось");
        if (esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &handle) != ESP_OK)
            return abort_error(503, "Не удалось открыть свободный раздел прошивки");
        handle_open = true;
    }
    if (!operation_permitted())
        return abort_error(409, "Срок запроса истёк или соединение сменилось; загрузка прервана");
    if (esp_ota_write(handle, bytes.data(), bytes.size()) != ESP_OK)
        return abort_error(503, "Ошибка записи прошивки; текущая версия сохранена");
    if (psa_hash_update(&hash_operation, bytes.data(), bytes.size()) != PSA_SUCCESS)
        return abort_error(503, "Не удалось проверить фрагмент прошивки");
    received += bytes.size();
    touched_us = esp_timer_get_time();
    return acknowledgement();
}

/**
 * @brief Verify the complete file and SDK image, then change the boot slot exactly once.
 * @param[in] body Borrowed exact uploadId object.
 * @param[in] reserveReboot Nonactuating worker reservation before changing the boot slot.
 * @return Owned verified image metadata and deferred reboot, or a failure retaining the old slot.
 */
FirmwareUpdateResult finish(const cJSON* body, bool (*reserveReboot)())
{
    if (!settings_json_fields(body, {"uploadId"}))
        return failure(400, "Укажите сессию загрузки");
    if (state != UploadState::Receiving || !matching_upload(body) || received != expected_size
        || !handle_open)
        return failure(409, "Бинарник ещё не загружен полностью или сессия устарела");
    if (!reserveReboot || !reserveReboot())
        return failure(503, "Не удалось подготовить перезагрузку; прошивка не активирована");
    std::array<unsigned char, 32> actual{};
    std::size_t length = 0;
    if (psa_hash_finish(&hash_operation, actual.data(), actual.size(), &length) != PSA_SUCCESS
        || length != actual.size() || actual != expected_sha)
        return abort_error(400, "SHA-256 не совпадает; текущая прошивка сохранена");
    const auto valid = esp_ota_end(handle);
    handle_open = false;  // esp_ota_end releases its handle even when validation fails.
    if (valid != ESP_OK)
        return abort_error(400, "Бинарник не прошёл проверку ESP-IDF; текущая прошивка сохранена");
    if (!operation_permitted())
        return abort_error(409, "Срок запроса истёк; прошивка не активирована");
    if (esp_ota_set_boot_partition(target) != ESP_OK)
        return abort_error(503, "Не удалось выбрать новую прошивку для запуска");
    state = UploadState::Ready;
    restart_reserved = true;
    auto result = acknowledgement();
    cJSON_AddBoolToObject(result.data, "rebootRequired", true);
    cJSON_AddStringToObject(result.data, "version", version.c_str());
    cJSON_AddStringToObject(result.data, "imageId", image_id.c_str());
    cJSON_AddStringToObject(result.data, "targetPartition", target->label);
    result.reboot = true;
    return result;
}
}  // namespace

/** @brief Handle an exact /firmware service route, sharing one inactive-slot upload session.
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @param[in] method Exact GET or POST.
 * @param[in] path Relative route without /api/v1.
 * @param[in] body Borrowed JSON body for mutations.
 * @param[in] reserveReboot Optional nonactuating reboot-worker reservation, required by finish.
 * @return Owned bounded response; successful finish requests a deferred reboot.
 * @note Requires caller authentication. Never writes configuration, FRAM, the active app or
 * bootloader.
 * @endcond
 */
FirmwareUpdateResult firmware_update_request(std::string_view method,
                                             std::string_view path,
                                             const cJSON* body,
                                             bool (*reserveReboot)())
{
    std::lock_guard<std::mutex> lock(update_mutex);
    expire();
    if (!operation_permitted())
        return failure(409, "Срок запроса истёк или соединение сменилось");
    if (method == "GET" && path == "/firmware")
        return snapshot();
    if (method != "POST")
        return failure(405, "Метод не поддерживается");
    if (path == "/firmware/begin")
        return begin(body);
    if (path == "/firmware/chunk")
        return chunk(body);
    if (path == "/firmware/finish")
        return finish(body, reserveReboot);
    if (path == "/firmware/abort") {
        if (!settings_json_fields(body, {"uploadId"}))
            return failure(400, "Укажите сессию загрузки");
        if (state == UploadState::Ready || !matching_upload(body))
            return failure(409, "Загрузка уже активирована или принадлежит другой сессии");
        discard();
        state = UploadState::Idle;
        upload_id.clear();
        diagnostic.clear();
        return acknowledgement();
    }
    return failure(404, "Неизвестная операция обновления");
}

/** @brief Check whether a received or verified update prevents settings/restart changes.
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @return True during receive and after boot selection until restart.
 * @endcond
 */
bool firmware_update_busy()
{
    std::lock_guard<std::mutex> lock(update_mutex);
    expire();
    return state == UploadState::Receiving || state == UploadState::Ready;
}

/** @brief Reserve reboot/restore before its commit, excluding simultaneous OTA begin.
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @return False during receive or another pending restart; otherwise closes the upload gate.
 * @endcond
 */
bool firmware_update_prepare_restart()
{
    std::lock_guard<std::mutex> lock(update_mutex);
    expire();
    if (state == UploadState::Receiving || (restart_reserved && state != UploadState::Ready))
        return false;
    restart_reserved = true;
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Release a failed reboot/restore reservation; a verified image remains reserved.
 * @endcond
 */
void firmware_update_cancel_restart()
{
    std::lock_guard<std::mutex> lock(update_mutex);
    if (state != UploadState::Ready)
        restart_reserved = false;
}

/** @brief Abort a 60-second abandoned upload without blocking the autonomous main supervisor.
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @note Call from the independent main loop; try-lock returns immediately during an active chunk.
 * @endcond
 */
void firmware_update_poll()
{
    std::unique_lock<std::mutex> lock(update_mutex, std::try_to_lock);
    if (lock.owns_lock())
        expire();
}

#ifdef FCPLCN_FIRMWARE_UPDATE_TESTING
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Reset volatile OTA state between isolated host tests; never available in production.
 * @endcond
 */
void firmware_update_test_reset()
{
    std::lock_guard<std::mutex> lock(update_mutex);
    discard();
    state = UploadState::Idle;
    restart_reserved = false;
    upload_id.clear();
    version.clear();
    image_id.clear();
    diagnostic.clear();
    expected_size = received = 0;
    target = nullptr;
}
#endif
