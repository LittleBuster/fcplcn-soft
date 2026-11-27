/**
 * @file controller_states.cpp
 * @brief state-memory operative states bound to the exact durable controller configuration.
 * @details Flash holds configuration and a unique identity. Only user switch states and
 * thermostat, tank and irrigation permissions enter this journal; derived relay demand is always
 * RAM-only.
 */
#include "controllers/controller_internal.h"
#include "hardware/state_memory.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {
namespace {
StateJournalKey active_key{};
bool active_key_valid = false;
std::uint8_t active_version = 0;
std::string storage_error;
bool storage_available = false;
esp_err_t storage_result = ESP_ERR_INVALID_STATE;
}  // namespace

/**
 * @brief Extract the nonzero state identity from a CRC-checked configuration with an
 * operative-state identity.
 * @param[in] record Complete durable configuration bytes.
 * @param[out] key Replaced on success; unchanged for older or invalid records.
 * @return True only for a complete current-format record with a nonzero identity.
 */
bool state_record_key(const SettingsBytes& record, StateJournalKey& key)
{
    constexpr std::size_t offset = 10;
    if (record.size() < offset + key.size() + 5
        || !((std::equal(kControllerMagic.begin(), kControllerMagic.end(), record.begin())
              && record[8] == kControllerStorageVersion)
             || (std::equal(kV10Magic.begin(), kV10Magic.end(), record.begin()) && record[8] == 10)
             || (std::equal(kV9Magic.begin(), kV9Magic.end(), record.begin()) && record[8] == 9)
             || (std::equal(kV8Magic.begin(), kV8Magic.end(), record.begin()) && record[8] == 8))
        || record[9] != 0)
        return false;
    const auto end = record.size() - 4;
    std::uint32_t checksum = 0;
    for (unsigned i = 0; i < 4; ++i)
        checksum |= static_cast<std::uint32_t>(record[end + i]) << (8 * i);
    if (checksum != crc32(record.data(), end))
        return false;
    StateJournalKey parsed{};
    std::copy_n(record.begin() + offset, parsed.size(), parsed.begin());
    if (std::all_of(parsed.begin(), parsed.end(), [](auto value) {
            return value == 0;
        }))
        return false;
    key = parsed;
    return true;
}

/**
 * @brief Encode compact operative flags in stable module and row order.
 * @param[in] configs Configuration owning the row order and current confirmed flags.
 * @return Versioned states and per-module counts; no names, bindings or measurements.
 */
StateJournalPayload encode_states(const Configurations& configs)
{
    StateJournalPayload payload{4};
    for (std::size_t module = 0; module < kControllerCount; ++module) {
        if (module == index(ControllerKind::Security)) {
            payload.push_back(2);
            payload.push_back(configs[module].armed);
            payload.push_back(configs[module].triggered);
            continue;
        }
        const bool operative = module != index(ControllerKind::Meteo);
        payload.push_back(static_cast<std::uint8_t>(operative ? configs[module].items.size() : 0));
        if (operative)
            for (const auto& item : configs[module].items)
                payload.push_back((module == index(ControllerKind::Thermostats)
                                   || module == index(ControllerKind::Irrigation)
                                   || module == index(ControllerKind::Tanks))
                                      ? item.enabled
                                      : item.state);
    }
    return payload;
}

/**
 * @brief Validate a whole state payload before replacing any operative flag.
 * @param[in] payload Complete journal payload with version and module row counts.
 * @param[in,out] configs Same-key configuration; unchanged on validation failure.
 * @param recordVersion Version of the CRC-checked record owning this journal.
 * @return ESP_OK or INVALID_RESPONSE for a schema/count/value mismatch.
 */
esp_err_t apply_states(const StateJournalPayload& payload,
                       Configurations& configs,
                       std::uint8_t recordVersion)
{
    // FCCTRL08 introduced the four-module journal. Each subsequent version
    // appends one module and increments both versions together.
    if (payload.empty() || recordVersion < 8 || recordVersion > kControllerStorageVersion
        || payload[0] != recordVersion - 7)
        return ESP_ERR_INVALID_RESPONSE;
    auto next = configs;
    std::size_t position = 1;
    const auto moduleCount = static_cast<std::size_t>(recordVersion - 4);
    for (std::size_t module = 0; module < moduleCount; ++module) {
        if (module == index(ControllerKind::Security)) {
            if (payload.size() - position < 3 || payload[position++] != 2 || payload[position] > 1
                || payload[position + 1] > 1)
                return ESP_ERR_INVALID_RESPONSE;
            next[module].armed = payload[position++] != 0;
            next[module].triggered = payload[position++] != 0;
            if (!valid_configuration(next[module], true, ControllerKind::Security))
                return ESP_ERR_INVALID_RESPONSE;
            continue;
        }
        const auto count = module == index(ControllerKind::Meteo) ? 0 : next[module].items.size();
        if (position >= payload.size() || payload[position++] != count)
            return ESP_ERR_INVALID_RESPONSE;
        for (std::size_t row = 0; row < count; ++row) {
            if (position >= payload.size() || payload[position] > 1)
                return ESP_ERR_INVALID_RESPONSE;
            auto& item = next[module].items[row];
            ((module == index(ControllerKind::Thermostats)
              || module == index(ControllerKind::Irrigation)
              || module == index(ControllerKind::Tanks))
                 ? item.enabled
                 : item.state) = payload[position++] != 0;
        }
    }
    if (position != payload.size())
        return ESP_ERR_INVALID_RESPONSE;
    configs = std::move(next);
    return ESP_OK;
}

/**
 * @brief Revoke all stored ON states and autonomous-loop permissions after an unreadable journal.
 * @param[in,out] configs Configured rows whose bindings and module settings remain intact.
 */
void clear_states(Configurations& configs)
{
    for (auto& config : configs) {
        config.armed = false;
        config.triggered = false;
        for (auto& item : config.items) {
            item.state = false;
            item.enabled = false;
        }
    }
    // An unreadable alarm state must not silently disarm configured zones,
    // including during migration of a previous state-memory journal.
    auto& security = configs[index(ControllerKind::Security)];
    if (security.enabled && !security.items.empty()) {
        security.armed = true;
        security.triggered = true;
    }
}

/**
 * @brief Select the state identity after the corresponding flash commit succeeds.
 * @param[in] record Authoritative current-format flash record.
 * @pre The controller mutex is held, or startup has not published controller services.
 */
void activate_state_record(const SettingsBytes& record)
{
    active_key_valid = state_record_key(record, active_key);
    active_version = active_key_valid ? record[8] : 0;
    storage_available = active_key_valid;
    storage_result = active_key_valid ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (active_key_valid)
        storage_error.clear();
}

/**
 * @brief Load operative flags for the active identity and retain a servicing diagnostic.
 * @param[in,out] configs Same-key configuration; unchanged if no valid snapshot can be read.
 * @return ESP_OK or an identity, transport or payload-validation error.
 * @pre Hold the controller mutex during startup before commands are accepted.
 */
esp_err_t load_states(Configurations& configs)
{
    StateJournalPayload payload;
    auto result =
        active_key_valid ? state_journal_load(active_key, payload) : ESP_ERR_INVALID_STATE;
    if (result == ESP_OK)
        result = apply_states(payload, configs, active_version);
    storage_error = result == ESP_OK ? "" : "Состояния памяти недоступны или повреждены";
    storage_available = result == ESP_OK;
    storage_result = result;
    return result;
}

/**
 * @brief Check whether the active operative flags have a confirmed state-memory snapshot.
 * @return True after a successful state load or commit without a later storage failure.
 * @pre Hold the controller mutex; no I2C access occurs.
 */
bool state_storage_healthy()
{
    return active_key_valid && active_version == kControllerStorageVersion && storage_error.empty();
}

/**
 * @brief Persist a frequently changing state snapshot without accessing flash.
 * @param[in] configs Proposed confirmed states with the active configuration's bindings.
 * @return ESP_OK after verified state-memory commit, or an identity/storage error.
 * @pre Hold the controller mutex and an outer settings write guard.
 * @note On ambiguous failure, attempt to restore the previously confirmed payload. Failure
 * never falls back to flash. The caller retains RAM and applies its physical fault policy.
 */
esp_err_t save_states(const Configurations& configs)
{
    if (!active_key_valid || active_version != kControllerStorageVersion) {
        storage_error = "Состояния памяти не привязаны к сохранённой конфигурации";
        storage_result = ESP_ERR_INVALID_STATE;
        return ESP_ERR_INVALID_STATE;
    }
    const auto result = state_journal_save(active_key, encode_states(configs));
    storage_available = result == ESP_OK;
    storage_result = result;
    if (result == ESP_OK)
        storage_error.clear();
    else {
        state_journal_save(active_key, encode_states(configurations));
        storage_error = "Не удалось подтвердить сохранение состояний в памяти";
    }
    return result;
}

/**
 * @brief Return the current state-transaction diagnostic without I2C traffic.
 * @return Borrowed diagnostic, valid until the next controller storage operation.
 * @pre Hold the controller mutex.
 */
const std::string& state_storage_error()
{
    return storage_error;
}

/**
 * @brief Describe the fitted state-memory and its last confirmed operative-state transaction.
 * @return Owned diagnostic JSON without operative payload bytes, or nullptr on allocation failure.
 * @pre Hold the controller mutex; cached journal diagnostics require no I2C traffic.
 */
cJSON* state_storage_json_locked()
{
    Json root(cJSON_CreateObject(), cJSON_Delete);
    const auto& memory = board_profile_active().stateMemory;
    const auto journal = state_journal_status();
    const auto capacity = memory ? memory->capacityBytes : 0;
    const auto reserved = std::min<std::size_t>(capacity, kStateJournalReservedBytes);
    if (!root
        || !cJSON_AddStringToObject(root.get(),
                                    "type",
                                    !memory                                 ? "none"
                                    : memory->kind == BoardMemoryKind::Fram ? "FRAM"
                                                                            : "EEPROM")
        || !cJSON_AddStringToObject(root.get(), "model", memory ? memory->model : "")
        || !cJSON_AddBoolToObject(root.get(), "available", storage_available)
        || !cJSON_AddBoolToObject(root.get(), "valid", state_storage_healthy() && journal.valid)
        || !cJSON_AddNumberToObject(root.get(), "lastError", storage_result)
        || !cJSON_AddNumberToObject(
            root.get(), "generation", static_cast<double>(journal.generation))
        || !cJSON_AddStringToObject(root.get(), "busId", memory ? memory->i2cBusId : "")
        || !cJSON_AddNumberToObject(root.get(), "address", memory ? memory->address : 0)
        || !cJSON_AddNumberToObject(root.get(), "capacityBytes", capacity)
        || !cJSON_AddNumberToObject(root.get(), "reservedBytes", reserved)
        || !cJSON_AddNumberToObject(root.get(), "usedBytes", reserved)
        || !cJSON_AddNumberToObject(root.get(), "freeBytes", capacity - reserved)
        || !cJSON_AddNumberToObject(
            root.get(),
            "payloadBytes",
            state_storage_healthy() && journal.valid ? encode_states(configurations).size() : 0)
        || !cJSON_AddStringToObject(root.get(), "error", storage_error.c_str()))
        return nullptr;
    return root.release();
}

/**
 * @brief Clear volatile state storage identity for a simulated reboot.
 * @pre No controller or journal operation runs concurrently; state-memory itself is retained.
 */
void reset_state_storage()
{
    active_key = {};
    active_key_valid = false;
    active_version = 0;
    storage_error.clear();
    storage_available = false;
    storage_result = ESP_ERR_INVALID_STATE;
}
}  // namespace fcplcn::controllers::detail

/** @endcond */

using namespace fcplcn::controllers::detail;

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy state-memory state-storage health for service diagnostics without touching I2C.
 * @return Owned JSON object, or nullptr on allocation failure.
 * @note Thread-safe; does not expose saved operative payload bytes.
 * @endcond
 */
cJSON* controllers_state_storage_json()
{
    std::lock_guard<std::mutex> lock(controller_mutex);
    return state_storage_json_locked();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read and validate state-memory for an explicit hardware-page snapshot.
 * @return Owned health/allocation JSON, or nullptr on allocation failure.
 * @note Thread-safe. Bounded I2C reads validate the active identity and confirmed RAM flags;
 * this diagnostic never writes memory, restores outputs or changes configured operative flags.
 * @endcond
 */
cJSON* controllers_probe_state_storage_json()
{
    std::lock_guard<std::mutex> lock(controller_mutex);
    StateJournalPayload payload;
    std::uint8_t byte = 0;
    auto result = state_memory_read(0, &byte, 1);
    const bool available = result == ESP_OK;
    storage_available = available;
    if (available && active_key_valid) {
        result = state_journal_load(active_key, payload);
        auto checked = configurations;
        if (result == ESP_OK)
            result = apply_states(payload, checked, active_version);
        if (result == ESP_OK && active_version == kControllerStorageVersion
            && payload != encode_states(configurations))
            result = ESP_ERR_INVALID_RESPONSE;
    } else if (available)
        result = ESP_ERR_INVALID_STATE;
    storage_result = result;
    storage_error = result == ESP_OK ? ""
                    : !available     ? "Нет связи с памятью состояний"
                    : !active_key_valid
                        ? "Состояния памяти не привязаны к сохранённой конфигурации"
                        : "Записи памяти повреждены или не соответствуют подтверждённым состояниям";
    Json root(state_storage_json_locked(), cJSON_Delete);
    if (!root)
        return nullptr;
    cJSON_SetBoolValue(cJSON_GetObjectItemCaseSensitive(root.get(), "available"), available);
    cJSON_SetBoolValue(cJSON_GetObjectItemCaseSensitive(root.get(), "valid"), result == ESP_OK);
    cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(root.get(), "lastError"), result);
    return root.release();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Stage replacement states in state-memory while preserving the current flash identity.
 * @param[in] replacement Validated new current-format controller record.
 * @param[in] current Current flash controller section, possibly empty or legacy.
 * @return ESP_OK after verified state-memory staging, or a record/transport error.
 * @note Does not publish controller RAM or write flash. Call with all controller writers
 * excluded, before committing the replacement flash record. Repeated failed commits keep
 * the current identity's last valid state slot intact.
 * @endcond
 */
esp_err_t controllers_prepare_restore_states(const SettingsBytes& replacement,
                                             const SettingsBytes& current)
{
    Configurations parsed;
    StateJournalKey key{}, protected_key{};
    if (decode_record(replacement, parsed) != ESP_OK || !state_record_key(replacement, key))
        return ESP_ERR_INVALID_RESPONSE;
    const bool protect = state_record_key(current, protected_key);
    return state_journal_save(key, encode_states(parsed), protect ? &protected_key : nullptr);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Export coherent flash settings together with their latest state-memory operative states.
 * @param[out] snapshot Complete flash snapshot used for the returned controller data.
 * @param[out] error Failure diagnostic, cleared on success.
 * @return Owned controller JSON, or nullptr if flash/state-memory cannot be read coherently.
 * @note A writer guard prevents restore staging during the snapshot. The controller mutex
 * serializes state/config changes; after a completed restore, its staged identity is exported.
 * @endcond
 */
cJSON* controllers_backup_snapshot(SettingsSnapshot& snapshot, std::string& error)
{
    SettingsWriteGuard reader;
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (settings_store_snapshot(snapshot) != ESP_OK) {
        error = "Не удалось прочитать полные настройки";
        return nullptr;
    }
    Configurations parsed;
    const auto& record = snapshot.sections[static_cast<std::size_t>(SettingsSection::Controllers)];
    if (decode_record(record, parsed) != ESP_OK) {
        error = "Настройки контроллеров повреждены";
        return nullptr;
    }
    StateJournalKey key{};
    if (state_record_key(record, key)) {
        StateJournalPayload payload;
        if (state_journal_load(key, payload) != ESP_OK
            || apply_states(payload, parsed, record[8]) != ESP_OK) {
            error = "Не удалось прочитать актуальные состояния из памяти";
            storage_error = error;
            storage_result = ESP_ERR_INVALID_RESPONSE;
            return nullptr;
        }
    }
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root)
        return nullptr;
    for (std::size_t module = 0; module < kControllerCount; ++module) {
        const auto kind = static_cast<ControllerKind>(module);
        Json object(backup_module_json(parsed[module], kind), cJSON_Delete);
        if (!object || !cJSON_AddItemToObject(root.get(), controller_id(kind), object.get()))
            return nullptr;
        object.release();
    }
    error.clear();
    return root.release();
}
