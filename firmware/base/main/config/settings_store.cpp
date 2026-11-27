/**
 * @file settings_store.cpp
 * @brief CRC-protected whole-device settings and restore/mutation synchronization.
 * @details Three opaque sections share a versioned, length-delimited little-endian NVS blob.
 * Decode validates bounds and CRC before publishing RAM state. Migration keeps legacy
 * bytes until the authoritative bundle is committed; staging closes the writer gate,
 * waits without holding a module/store mutex, then commits with generation CAS.
 */
#include "config/settings_store.h"
#include "platform/operation_context.h"
#include "platform/checksum.h"
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <limits>
#include <mutex>
#include "nvs.h"

namespace {
constexpr std::uint8_t kMagic[] = {'F', 'C', 'S', 'T', 'A', 'T', 'E', '1'};
std::mutex store_mutex, gate_mutex;
std::condition_variable gate_condition;
SettingsSnapshot current;
bool initialized = false;
bool staging = false;
unsigned writers = 0;
std::atomic<bool> pending{false};

using fcplcn::util::crc32;

/**
 * @brief Append the low bytes of an integer in little-endian record order.
 * @param[in,out] bytes Destination record bytes.
 * @param[in] value Unsigned integer to encode.
 * @param[in] count Number of bytes to append, at most sizeof(value).
 * @pre count is at most 8; callers use the fixed schema widths.
 */
void number(SettingsBytes& bytes, std::uint64_t value, unsigned count)
{
    for (unsigned i = 0; i < count; ++i)
        bytes.push_back(static_cast<std::uint8_t>(value >> (i * 8)));
}

/**
 * @brief Decode a bounded little-endian unsigned integer and advance the record cursor.
 * @param[in] bytes Borrowed record bytes.
 * @param[in,out] offset Cursor advanced by count only when the range fits.
 * @param[out] value Decoded integer on success; unchanged when the range is truncated.
 * @param[in] count Number of bytes to read, at most 8.
 * @return True if the entire encoded integer fits in the record.
 * @pre count does not exceed sizeof(value).
 */
bool read_number(const SettingsBytes& bytes,
                 std::size_t& offset,
                 std::uint64_t& value,
                 unsigned count)
{
    if (offset > bytes.size() || count > bytes.size() - offset)
        return false;
    value = 0;
    for (unsigned i = 0; i < count; ++i)
        value |= static_cast<std::uint64_t>(bytes[offset++]) << (i * 8);
    return true;
}

/**
 * @brief Encode a versioned settings bundle with section lengths and trailing CRC.
 * @param[in] snapshot Borrowed coherent snapshot to serialize.
 * @param[out] bytes Complete encoded record on success; unchanged when the size limit is rejected.
 * @return ESP_OK or ESP_ERR_INVALID_SIZE if the record exceeds the NVS bundle budget.
 * @note The codec does not increment generations, access Flash or publish global state.
 */
esp_err_t encode(const SettingsSnapshot& snapshot, SettingsBytes& bytes)
{
    std::size_t size = 34;
    for (const auto& section : snapshot.sections) {
        if (section.size() > kSettingsMaxBlobBytes - size)
            return ESP_ERR_INVALID_SIZE;
        size += section.size();
    }
    bytes.assign(std::begin(kMagic), std::end(kMagic));
    number(bytes, 1, 2);
    number(bytes, snapshot.generation, 8);
    for (const auto& section : snapshot.sections)
        number(bytes, section.size(), 4);
    for (const auto& section : snapshot.sections)
        bytes.insert(bytes.end(), section.begin(), section.end());
    number(bytes, crc32(bytes.data(), bytes.size()), 4);
    return ESP_OK;
}

/**
 * @brief Validate and decode a complete settings bundle before publishing any result.
 * @param[in] bytes Borrowed encoded record with magic, version, generation, lengths and CRC.
 * @param[out] result Owned snapshot assigned only after every validation succeeds.
 * @return ESP_OK or ESP_ERR_INVALID_RESPONSE for invalid bounds, format, generation or CRC.
 * @note A corrupt authoritative bundle must not trigger fallback to stale legacy records.
 */
esp_err_t decode(const SettingsBytes& bytes, SettingsSnapshot& result)
{
    if (bytes.size() < 34 || bytes.size() > kSettingsMaxBlobBytes
        || std::memcmp(bytes.data(), kMagic, sizeof(kMagic)) != 0)
        return ESP_ERR_INVALID_RESPONSE;
    std::size_t offset = 8;
    std::uint64_t version, generation;
    if (!read_number(bytes, offset, version, 2) || version != 1
        || !read_number(bytes, offset, generation, 8) || generation == 0)
        return ESP_ERR_INVALID_RESPONSE;
    std::array<std::uint64_t, 3> lengths{};
    std::size_t total = 34;
    for (auto& length : lengths) {
        if (!read_number(bytes, offset, length, 4) || length > bytes.size() - total)
            return ESP_ERR_INVALID_RESPONSE;
        total += static_cast<std::size_t>(length);
    }
    if (total != bytes.size())
        return ESP_ERR_INVALID_RESPONSE;
    SettingsSnapshot snapshot;
    snapshot.generation = generation;
    for (std::size_t i = 0; i < lengths.size(); ++i) {
        snapshot.sections[i].assign(bytes.begin() + offset, bytes.begin() + offset + lengths[i]);
        offset += static_cast<std::size_t>(lengths[i]);
    }
    std::uint64_t checksum;
    if (!read_number(bytes, offset, checksum, 4)
        || checksum != crc32(bytes.data(), bytes.size() - 4))
        return ESP_ERR_INVALID_RESPONSE;
    result = std::move(snapshot);
    return ESP_OK;
}

/**
 * @brief Read a bounded NVS blob or a legacy NUL-terminated configuration string.
 * @param[in] space Non-null NVS namespace.
 * @param[in] key Non-null NVS record key.
 * @param[out] bytes Record payload; a failed read may leave resized or partially filled bytes.
 * @param[in] string Read a legacy string and remove its verified trailing NUL when true.
 * @return ESP_OK, an NVS error, ESP_ERR_INVALID_SIZE for an invalid length, or INVALID_RESPONSE.
 * @note Always closes an opened NVS handle; accepts records of at most 8192 stored bytes.
 */
esp_err_t read_blob(const char* space, const char* key, SettingsBytes& bytes, bool string = false)
{
    nvs_handle_t handle;
    esp_err_t result = nvs_open(space, NVS_READONLY, &handle);
    if (result != ESP_OK)
        return result;
    std::size_t length = 0;
    result = string ? nvs_get_str(handle, key, nullptr, &length)
                    : nvs_get_blob(handle, key, nullptr, &length);
    if (result == ESP_OK && (length == 0 || length > 8192))
        result = ESP_ERR_INVALID_SIZE;
    if (result == ESP_OK) {
        bytes.resize(length);
        result = string ? nvs_get_str(handle, key, reinterpret_cast<char*>(bytes.data()), &length)
                        : nvs_get_blob(handle, key, bytes.data(), &length);
        if (result == ESP_OK && string) {
            if (bytes.back() != 0)
                result = ESP_ERR_INVALID_RESPONSE;
            else
                bytes.pop_back();
        }
    }
    nvs_close(handle);
    return result;
}

/**
 * @brief Encode and commit one complete settings snapshot to the authoritative NVS key.
 * @param[in] snapshot Borrowed replacement bundle, including its chosen generation.
 * @return ESP_OK or an encoding, NVS-open, write or commit error.
 * @pre The caller holds store_mutex and has validated the intended replacement.
 * @note Does not replace the RAM snapshot; callers publish it only after successful commit.
 */
esp_err_t persist(const SettingsSnapshot& snapshot)
{
    SettingsBytes bytes;
    auto result = encode(snapshot, bytes);
    if (result != ESP_OK)
        return result;
    nvs_handle_t handle;
    result = nvs_open(kSettingsNvsNamespace, NVS_READWRITE, &handle);
    if (result != ESP_OK)
        return result;
    result = nvs_set_blob(handle, kSettingsNvsKey, bytes.data(), bytes.size());
    if (result == ESP_OK)
        result = nvs_commit(handle);
    nvs_close(handle);
    return result;
}

/**
 * @brief Best-effort erase migrated legacy keys after their authoritative bundle is durable.
 * @param[in] snapshot Committed snapshot whose nonempty sections identify migrated legacy keys.
 * @pre The caller holds store_mutex and has loaded or committed a valid authoritative bundle.
 * @note Failed erases/commits are tolerated; empty sections keep their legacy keys for later use.
 */
void cleanup_legacy(const SettingsSnapshot& snapshot)
{
    constexpr const char* spaces[] = {"fcplcn_cfg", "fcplcn_auth", "fcplcn_sockets"};
    constexpr const char* keys[] = {"config", "account", "runtime"};
    for (std::size_t i = 0; i < snapshot.sections.size(); ++i) {
        if (snapshot.sections[i].empty())
            continue;
        nvs_handle_t handle;
        if (nvs_open(spaces[i], NVS_READWRITE, &handle) != ESP_OK)
            continue;
        if (nvs_erase_key(handle, keys[i]) == ESP_OK)
            nvs_commit(handle);
        nvs_close(handle);
    }
}

/**
 * @brief Load the authoritative bundle or durably migrate the available legacy sections.
 * @return ESP_OK after publishing an initialized RAM snapshot, or the storage/validation error.
 * @pre The caller holds store_mutex and NVS has been initialized.
 * @details Migration runs only when the authoritative key is absent. Corrupt or unreadable
 * existing bundles fail closed. Legacy bytes are erased only after a valid bundle is durable.
 */
esp_err_t initialize_locked()
{
    if (initialized)
        return ESP_OK;
    SettingsBytes bytes;
    auto result = read_blob(kSettingsNvsNamespace, kSettingsNvsKey, bytes);
    if (result == ESP_OK) {
        result = decode(bytes, current);
        if (result != ESP_OK)
            return result;  // Never resurrect stale legacy keys after a bad bundle.
        initialized = true;
        cleanup_legacy(current);
        return ESP_OK;
    }
    if (result != ESP_ERR_NVS_NOT_FOUND)
        return result;
    SettingsSnapshot migrated;
    migrated.generation = 1;
    constexpr const char* spaces[] = {"fcplcn_cfg", "fcplcn_auth", "fcplcn_sockets"};
    constexpr const char* keys[] = {"config", "account", "runtime"};
    for (std::size_t i = 0; i < migrated.sections.size(); ++i) {
        result = read_blob(spaces[i], keys[i], migrated.sections[i], i == 0);
        if (result != ESP_OK && result != ESP_ERR_NVS_NOT_FOUND)
            return result;
    }
    result = persist(migrated);
    if (result != ESP_OK)
        return result;
    current = std::move(migrated);
    initialized = true;
    cleanup_legacy(current);
    return ESP_OK;
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Enter the mutation gate; inspect operator bool() before mutation.
 * @endcond
 */
SettingsWriteGuard::SettingsWriteGuard()
{
    std::unique_lock<std::mutex> lock(gate_mutex);
    gate_condition.wait(lock, [] {
        return !staging;
    });
    if (!pending.load()) {
        ++writers;
        entered_ = true;
    }
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Release an entered writer and wake a waiting restore when it was the last one.
 * @endcond
 */
SettingsWriteGuard::~SettingsWriteGuard()
{
    if (!entered_)
        return;
    std::lock_guard<std::mutex> lock(gate_mutex);
    --writers;
    if (writers == 0)
        gate_condition.notify_all();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Check whether a successful full restore is waiting for reboot.
 * @return True after durable staging. Thread-safe, lock-free observation.
 * @endcond
 */
bool settings_restore_pending()
{
    return pending.load();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Load the CRC-checked bundle or durably migrate legacy section keys.
 * @return ESP_OK or a storage/record error. Corruption never resurrects stale legacy keys.
 * @pre NVS is initialized; invoke before any module loads its settings.
 * @note Thread-safe and idempotent. Legacy keys are removed only after the bundle is durable.
 * @endcond
 */
esp_err_t settings_store_init()
{
    std::lock_guard<std::mutex> lock(store_mutex);
    return initialize_locked();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy the entire authoritative bundle under the store mutex.
 * @param[out] snapshot Independent section copies and their common generation.
 * @return ESP_OK or an initialization/storage error. Thread-safe.
 * @endcond
 */
esp_err_t settings_store_snapshot(SettingsSnapshot& snapshot)
{
    std::lock_guard<std::mutex> lock(store_mutex);
    const auto result = initialize_locked();
    if (result == ESP_OK)
        snapshot = current;
    return result;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy one section from a coherent store snapshot.
 * @param[in] section Stable section slot.
 * @param[out] bytes Owned section copy on success.
 * @return ESP_OK, NVS_NOT_FOUND for an empty section, or a storage/argument error.
 * @note Thread-safe; the caller validates the opaque section with its codec.
 * @endcond
 */
esp_err_t settings_store_get(SettingsSection section, SettingsBytes& bytes)
{
    SettingsSnapshot snapshot;
    const auto result = settings_store_snapshot(snapshot);
    if (result != ESP_OK)
        return result;
    const auto index = static_cast<std::size_t>(section);
    if (index >= snapshot.sections.size())
        return ESP_ERR_INVALID_ARG;
    bytes = std::move(snapshot.sections[index]);
    return bytes.empty() ? ESP_ERR_NVS_NOT_FOUND : ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Atomically replace one nonempty section without changing the others.
 * @param[in] section Stable section slot.
 * @param[in] bytes Borrowed replacement bytes; copied into the next bundle.
 * @return ESP_OK or a size/storage/freeze/generation-exhaustion error; RAM changes only on commit.
 * @pre The caller holds a SettingsWriteGuard before its module mutex and this call.
 * @note Thread-safe; persistence increments the bundle generation, not module revisions.
 * @endcond
 */
esp_err_t settings_store_set(SettingsSection section, const SettingsBytes& bytes)
{
    std::lock_guard<std::mutex> lock(store_mutex);
    if (!operation_permitted())
        return ESP_ERR_INVALID_STATE;
    auto result = initialize_locked();
    if (result != ESP_OK)
        return result;
    const auto index = static_cast<std::size_t>(section);
    if (index >= current.sections.size() || bytes.empty())
        return ESP_ERR_INVALID_ARG;
    if (pending.load() || current.generation == std::numeric_limits<std::uint64_t>::max())
        return ESP_ERR_INVALID_STATE;
    SettingsSnapshot next = current;
    next.sections[index] = bytes;
    ++next.generation;
    if (!operation_permitted())
        return ESP_ERR_INVALID_STATE;
    result = persist(next);
    if (result == ESP_OK)
        current = std::move(next);
    return result;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Commit a full validated replacement and freeze further writes until reboot.
 * @param[in] replacement Borrowed replacement sections; its generation is ignored.
 * @param[in] expectedGeneration CAS token from the snapshot used for validation.
 * @param[in] prepare Optional durable preparation after writers drain and generation CAS passes.
 * @return ESP_OK, INVALID_STATE on conflict/freeze, or a size/storage error.
 * @pre The caller validated all sections and holds no write guard or module mutex.
 * @note Thread-safe. Existing guarded writers drain before the store lock is acquired.
 * @endcond
 */
esp_err_t settings_store_stage(const SettingsSnapshot& replacement,
                               std::uint64_t expectedGeneration,
                               SettingsRestorePrepare prepare)
{
    std::unique_lock<std::mutex> gate(gate_mutex);
    gate_condition.wait(gate, [] {
        return !staging;
    });
    if (pending.load() || !operation_permitted())
        return ESP_ERR_INVALID_STATE;
    staging = true;  // New guards wait while existing mutations finish.
    gate_condition.wait(gate, [] {
        return writers == 0;
    });
    gate.unlock();
    esp_err_t result;
    {
        std::lock_guard<std::mutex> lock(store_mutex);
        result = operation_permitted() ? initialize_locked() : ESP_ERR_INVALID_STATE;
        if (result == ESP_OK
            && (current.generation != expectedGeneration
                || current.generation == std::numeric_limits<std::uint64_t>::max()))
            result = ESP_ERR_INVALID_STATE;
        if (result == ESP_OK && !operation_permitted())
            result = ESP_ERR_INVALID_STATE;
        if (result == ESP_OK && prepare != nullptr)
            result = prepare(replacement, current);
        if (result == ESP_OK && !operation_permitted())
            result = ESP_ERR_INVALID_STATE;
        if (result == ESP_OK) {
            SettingsSnapshot next = replacement;
            next.generation = current.generation + 1;
            result = persist(next);
            if (result == ESP_OK) {
                current = std::move(next);
                pending.store(true);
            }
        }
    }
    gate.lock();
    staging = false;
    gate_condition.notify_all();
    return result;
}
#ifdef FCPLCN_SETTINGS_TESTING
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Reset store RAM and gate state, preserving fake NVS.
 * @pre Fake tasks and all concurrent store/guard calls have stopped.
 * @endcond
 */
void settings_store_test_reset()
{
    std::lock_guard<std::mutex> gate(gate_mutex);
    std::lock_guard<std::mutex> lock(store_mutex);
    current = SettingsSnapshot{};
    initialized = false;
    pending.store(false);
    staging = false;
    writers = 0;
}
#endif
