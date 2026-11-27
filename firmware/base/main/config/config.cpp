/**
 * @file config.cpp
 * @brief Validated configuration loading, redaction and optimistic persistence.
 * @details Patches are applied to a copy and become active RAM settings only after a durable save.
 * A known saved hardware ID survives network recovery defaults; an unknown explicit ID
 * fails closed before any GPIO mapping is activated. Revisions never wrap.
 */
#include "config/config.h"
#include "platform/operation_context.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <vector>
#include "esp_log.h"
#include "esp_mac.h"
#include "nvs.h"
#include "config/settings_json.h"

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
std::mutex mutex;
DeviceConfig current;
std::string identity;
constexpr const char* kTag = "FCPLCn.config";

/**
 * @brief Read an optional object section from a configuration patch.
 * @param[in] parent Borrowed patch object.
 * @param[in] key Case-sensitive section name.
 * @param[out] out Borrowed object, or nullptr for an omitted section.
 * @param[out] error Failure diagnostic when a present section is not an object.
 * @return True for an omitted or correctly typed section.
 */
bool section(const cJSON* parent, const char* key, const cJSON*& out, std::string& error)
{
    out = cJSON_GetObjectItemCaseSensitive(parent, key);
    if (out != nullptr && !cJSON_IsObject(out)) {
        error = std::string(key) + ": ожидается объект";
        return false;
    }
    return true;
}

/**
 * @brief Apply an optional boolean member to a candidate configuration.
 * @param[in] obj Borrowed section object.
 * @param[in] key Case-sensitive member name.
 * @param[in,out] target Replaced only when a present member is a JSON boolean.
 * @param[out] error Failure diagnostic for a wrong member type.
 * @return True for an omitted or valid member; false leaves target unchanged.
 */
bool boolean(const cJSON* obj, const char* key, bool& target, std::string& error)
{
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (item == nullptr)
        return true;
    if (!cJSON_IsBool(item)) {
        error = std::string(key) + ": ожидается true/false";
        return false;
    }
    target = cJSON_IsTrue(item);
    return true;
}

/**
 * @brief Apply an optional bounded string member to a candidate configuration.
 * @param[in] obj Borrowed section object.
 * @param[in] key Case-sensitive member name.
 * @param[in,out] target Replaced only after the present value passes type and length checks.
 * @param[in] max Maximum accepted byte count, excluding the trailing NUL.
 * @param[out] error Failure diagnostic for an invalid or oversized string.
 * @return True for an omitted or valid member; false leaves target unchanged.
 * @pre The complete raw JSON has passed supported_json_text() before parsing.
 */
bool string(
    const cJSON* obj, const char* key, std::string& target, std::size_t max, std::string& error)
{
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (item == nullptr)
        return true;
    if (!cJSON_IsString(item) || item->valuestring == nullptr
        || std::strlen(item->valuestring) > max) {
        error = std::string(key) + ": неверная или слишком длинная строка";
        return false;
    }
    target = item->valuestring;
    return true;
}

/**
 * @brief Apply an optional finite integer member within a closed range.
 * @param[in] obj Borrowed section object.
 * @param[in] key Case-sensitive member name.
 * @param[in,out] target Replaced only after successful validation.
 * @param[in] minimum Inclusive lower bound.
 * @param[in] maximum Inclusive upper bound.
 * @param[out] error Failure diagnostic for type, fractional or range errors.
 * @return True for an omitted or valid member; false leaves target unchanged.
 */
bool integer(
    const cJSON* obj, const char* key, int& target, int minimum, int maximum, std::string& error)
{
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (item == nullptr)
        return true;
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble)
        || std::floor(item->valuedouble) != item->valuedouble || item->valuedouble < minimum
        || item->valuedouble > maximum) {
        error = std::string(key) + ": неверное число";
        return false;
    }
    target = static_cast<int>(item->valuedouble);
    return true;
}

/**
 * @brief Apply a hardware section and normalize its board identifier through the registry.
 * @param[in] json Borrowed configuration patch.
 * @param[in,out] hardware Candidate hardware settings; may be partially changed on failure.
 * @param[out] error Diagnostic for an invalid section or unknown board identifier.
 * @return True when the resulting candidate references a known canonical board.
 * @note Changes only the candidate; active GPIO mapping and persistent settings are untouched.
 */
bool patch_hardware(const cJSON* json, HardwareConfig& hardware, std::string& error)
{
    const cJSON* section_json = nullptr;
    if (!section(json, "hardware", section_json, error)
        || (section_json != nullptr
            && !string(section_json, "boardId", hardware.boardId, 64, error)))
        return false;
    const auto canonical_id = board_profile_canonical_id(hardware.boardId);
    if (canonical_id.empty()) {
        error = "Неизвестный аппаратный профиль платы";
        return false;
    }
    hardware.boardId = canonical_id;
    return true;
}

/**
 * @brief Merge supported optional sections and validate the resulting complete candidate.
 * @param[in] json Borrowed configuration patch object.
 * @param[in,out] c Candidate copy; may be partially changed if a later field fails.
 * @param[out] error First validation diagnostic; cleared by complete successful validation.
 * @return True when the merged configuration is supported.
 * @note Performs no persistence, revision increment or live network/hardware apply.
 */
bool patch_config(const cJSON* json, DeviceConfig& c, std::string& error)
{
    const cJSON *device = nullptr, *wifi = nullptr, *ap = nullptr, *sta = nullptr, *eth = nullptr,
                *linux = nullptr, *time = nullptr;
    if (!cJSON_IsObject(json) || !patch_hardware(json, c.hardware, error)
        || !section(json, "device", device, error) || !section(json, "wifi", wifi, error)
        || !section(json, "ethernet", eth, error) || !section(json, "linux", linux, error)
        || !section(json, "time", time, error))
        return false;
    if (device != nullptr && !string(device, "name", c.device.name, 64, error))
        return false;
    if (wifi != nullptr) {
        if (!boolean(wifi, "enabled", c.wifi.enabled, error) || !section(wifi, "ap", ap, error)
            || !section(wifi, "sta", sta, error))
            return false;
        if (ap != nullptr
            && (!boolean(ap, "enabled", c.wifi.ap.enabled, error)
                || !string(ap, "ssid", c.wifi.ap.ssid, 32, error)
                || !string(ap, "password", c.wifi.ap.password, 63, error)
                || !integer(ap, "channel", c.wifi.ap.channel, 1, 11, error)
                || !string(ap, "ip", c.wifi.ap.ip, 15, error)
                || !string(ap, "netmask", c.wifi.ap.netmask, 15, error)))
            return false;
        if (sta != nullptr
            && (!boolean(sta, "enabled", c.wifi.sta.enabled, error)
                || !string(sta, "ssid", c.wifi.sta.ssid, 32, error)
                || !string(sta, "password", c.wifi.sta.password, 63, error)))
            return false;
    }
    if (eth != nullptr
        && (!boolean(eth, "enabled", c.ethernet.enabled, error)
            || !boolean(eth, "dhcp", c.ethernet.dhcp, error)
            || !string(eth, "ip", c.ethernet.ip, 15, error)
            || !string(eth, "netmask", c.ethernet.netmask, 15, error)
            || !string(eth, "gateway", c.ethernet.gateway, 15, error)
            || !string(eth, "dns", c.ethernet.dns, 15, error)))
        return false;
    if (linux != nullptr
        && (!string(linux, "host", c.linux.host, 253, error)
            || !integer(linux, "port", c.linux.port, 1, 65535, error)
            || !string(linux, "username", c.linux.username, 128, error)
            || !string(linux, "password", c.linux.password, 128, error)))
        return false;
    if (time != nullptr
        && (!string(time, "timezone", c.time.timezone, 96, error)
            || !boolean(time, "ntpEnabled", c.time.ntpEnabled, error)
            || !string(time, "ntpServer", c.time.ntpServer, 253, error)))
        return false;
    return validate_config(c, error);
}

/**
 * @brief Serialize a complete configuration with canonical board identity.
 * @param[in] c Borrowed settings snapshot; not modified.
 * @param[in] secrets Whether to include Wi-Fi and MQTT password values.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr for an unknown board or allocation
 * failure.
 * @note passwordSet indicators are emitted in both forms; the secret form must not be logged.
 */
cJSON* serialize(const DeviceConfig& c, bool secrets)
{
    const auto board_id = board_profile_canonical_id(c.hardware.boardId);
    if (board_id.empty())
        return nullptr;
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root)
        return nullptr;
    if (!cJSON_AddNumberToObject(root.get(), "schemaVersion", 1)
        || !cJSON_AddNumberToObject(root.get(), "revision", c.revision))
        return nullptr;
    auto* device = cJSON_AddObjectToObject(root.get(), "device");
    if (!device || !cJSON_AddStringToObject(device, "name", c.device.name.c_str()))
        return nullptr;
    auto* hardware = cJSON_AddObjectToObject(root.get(), "hardware");
    if (!hardware || !cJSON_AddStringToObject(hardware, "boardId", board_id.data()))
        return nullptr;
    auto* wifi = cJSON_AddObjectToObject(root.get(), "wifi");
    if (!wifi || !cJSON_AddBoolToObject(wifi, "enabled", c.wifi.enabled))
        return nullptr;
    auto* ap = cJSON_AddObjectToObject(wifi, "ap");
    if (!ap || !cJSON_AddBoolToObject(ap, "enabled", c.wifi.ap.enabled)
        || !cJSON_AddStringToObject(ap, "ssid", c.wifi.ap.ssid.c_str())
        || !cJSON_AddNumberToObject(ap, "channel", c.wifi.ap.channel)
        || !cJSON_AddStringToObject(ap, "ip", c.wifi.ap.ip.c_str())
        || !cJSON_AddStringToObject(ap, "netmask", c.wifi.ap.netmask.c_str())
        || !cJSON_AddBoolToObject(ap, "passwordSet", !c.wifi.ap.password.empty())
        || (secrets && !cJSON_AddStringToObject(ap, "password", c.wifi.ap.password.c_str())))
        return nullptr;
    auto* sta = cJSON_AddObjectToObject(wifi, "sta");
    if (!sta || !cJSON_AddBoolToObject(sta, "enabled", c.wifi.sta.enabled)
        || !cJSON_AddStringToObject(sta, "ssid", c.wifi.sta.ssid.c_str())
        || !cJSON_AddBoolToObject(sta, "passwordSet", !c.wifi.sta.password.empty())
        || (secrets && !cJSON_AddStringToObject(sta, "password", c.wifi.sta.password.c_str())))
        return nullptr;
    auto* eth = cJSON_AddObjectToObject(root.get(), "ethernet");
    if (!eth || !cJSON_AddBoolToObject(eth, "enabled", c.ethernet.enabled)
        || !cJSON_AddBoolToObject(eth, "dhcp", c.ethernet.dhcp)
        || !cJSON_AddStringToObject(eth, "ip", c.ethernet.ip.c_str())
        || !cJSON_AddStringToObject(eth, "netmask", c.ethernet.netmask.c_str())
        || !cJSON_AddStringToObject(eth, "gateway", c.ethernet.gateway.c_str())
        || !cJSON_AddStringToObject(eth, "dns", c.ethernet.dns.c_str()))
        return nullptr;
    auto* linux = cJSON_AddObjectToObject(root.get(), "linux");
    if (!linux || !cJSON_AddStringToObject(linux, "host", c.linux.host.c_str())
        || !cJSON_AddNumberToObject(linux, "port", c.linux.port)
        || !cJSON_AddStringToObject(linux, "username", c.linux.username.c_str())
        || !cJSON_AddBoolToObject(linux, "passwordSet", !c.linux.password.empty())
        || (secrets && !cJSON_AddStringToObject(linux, "password", c.linux.password.c_str())))
        return nullptr;
    auto* time = cJSON_AddObjectToObject(root.get(), "time");
    if (!time || !cJSON_AddStringToObject(time, "timezone", c.time.timezone.c_str())
        || !cJSON_AddBoolToObject(time, "ntpEnabled", c.time.ntpEnabled)
        || !cJSON_AddStringToObject(time, "ntpServer", c.time.ntpServer.c_str()))
        return nullptr;
    return root.release();
}

/**
 * @brief Encode a settings snapshot as compact JSON including its secrets.
 * @param[in] c Borrowed complete configuration.
 * @return Owned compact JSON text, or an empty string if serialization/allocation fails.
 * @note Releases temporary cJSON allocations; the returned text contains credentials.
 */
std::string compact(const DeviceConfig& c)
{
    Json json(serialize(c, true), cJSON_Delete);
    char* text = json ? cJSON_PrintUnformatted(json.get()) : nullptr;
    std::string result = text ? text : "";
    cJSON_free(text);
    return result;
}

/**
 * @brief Durably replace the configuration section of the atomic settings bundle.
 * @param[in] c Borrowed configuration snapshot including its revision and secrets.
 * @return ESP_OK, ESP_ERR_NO_MEM for encoding failure, or the store error.
 * @pre The caller serializes configuration access; runtime mutations hold SettingsWriteGuard.
 * @note Used during startup before concurrent mutations as well. It does not publish RAM state.
 */
esp_err_t save(const DeviceConfig& c)
{
    const std::string text = compact(c);
    if (text.empty())
        return ESP_ERR_NO_MEM;
    return settings_store_set(SettingsSection::Config, SettingsBytes(text.begin(), text.end()));
}

/**
 * @brief Parse and validate a stored schema-v1 device-settings section.
 * @param[in] record Borrowed complete JSON section bytes.
 * @param[in,out] config Candidate defaults to patch; may be partially changed on failure.
 * @param[out] error Validation diagnostic; a generic corruption message fills an empty diagnostic.
 * @return True only for a supported schema, nonzero uint32 revision and valid complete candidate.
 * @note Pure codec; no Flash access, active-state publication or live peripheral apply.
 */
bool decode_record(const SettingsBytes& record, DeviceConfig& config, std::string& error)
{
    const std::string text(record.begin(), record.end());
    Json json(supported_json_text(text)
                  ? cJSON_ParseWithLengthOpts(text.c_str(), text.size() + 1, nullptr, true)
                  : nullptr,
              cJSON_Delete);
    const auto* schema =
        json ? cJSON_GetObjectItemCaseSensitive(json.get(), "schemaVersion") : nullptr;
    const auto* revision =
        json ? cJSON_GetObjectItemCaseSensitive(json.get(), "revision") : nullptr;
    if (!cJSON_IsNumber(schema) || schema->valuedouble != 1 || !cJSON_IsNumber(revision)
        || !std::isfinite(revision->valuedouble)
        || std::floor(revision->valuedouble) != revision->valuedouble || revision->valuedouble < 1
        || revision->valuedouble > UINT32_MAX || !patch_config(json.get(), config, error)) {
        if (error.empty())
            error = "Некорректная сохранённая конфигурация";
        return false;
    }
    config.revision = static_cast<std::uint32_t>(revision->valuedouble);
    return true;
}

/**
 * @brief Require the exact nested field layout of a portable device-settings backup.
 * @param[in] json Borrowed complete device-settings object without runtime metadata.
 * @return True only when every required field exists and unknown/duplicate fields are absent.
 * @note Field value types and ranges are checked separately by patch_config().
 */
bool backup_schema(const cJSON* json)
{
    const auto get = [](const cJSON* parent, const char* key) {
        return cJSON_GetObjectItemCaseSensitive(parent, key);
    };
    const auto* wifi = get(json, "wifi");
    return settings_json_fields(json, {"device", "hardware", "wifi", "ethernet", "linux", "time"})
           && settings_json_fields(get(json, "device"), {"name"})
           && settings_json_fields(get(json, "hardware"), {"boardId"})
           && settings_json_fields(wifi, {"enabled", "ap", "sta"})
           && settings_json_fields(get(wifi, "ap"),
                                   {"enabled", "ssid", "password", "channel", "ip", "netmask"})
           && settings_json_fields(get(wifi, "sta"), {"enabled", "ssid", "password"})
           && settings_json_fields(get(json, "ethernet"),
                                   {"enabled", "dhcp", "ip", "netmask", "gateway", "dns"})
           && settings_json_fields(get(json, "linux"), {"host", "port", "username", "password"})
           && settings_json_fields(get(json, "time"), {"timezone", "ntpEnabled", "ntpServer"});
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Load settings and derive the immutable MAC-based device identifier.
 * @return ESP_OK, a MAC/storage error, or ESP_ERR_INVALID_ARG for an unknown saved board.
 * @pre NVS and settings_store_init() are initialized; call before hardware/network startup.
 * @note Serialized internally. Missing settings are saved; corrupt network settings use
 * recovery defaults while retaining a recognized board identity. No NVS erasure occurs.
 * @endcond
 */
esp_err_t config_init()
{
    std::lock_guard<std::mutex> lock(mutex);
    std::uint8_t mac[6]{};
    const auto mac_result = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (mac_result != ESP_OK)
        return mac_result;
    char id[32], ssid[32];
    std::snprintf(id,
                  sizeof(id),
                  "fcplcn-%02x%02x%02x%02x%02x%02x",
                  mac[0],
                  mac[1],
                  mac[2],
                  mac[3],
                  mac[4],
                  mac[5]);
    std::snprintf(ssid, sizeof(ssid), "FCPLCn-%02X%02X%02X", mac[3], mac[4], mac[5]);
    identity = id;
    current = DeviceConfig{};
    current.wifi.ap.ssid = ssid;
    SettingsBytes bytes;
    const auto read_result = settings_store_get(SettingsSection::Config, bytes);
    if (read_result == ESP_ERR_NVS_NOT_FOUND)
        return save(current);
    if (read_result != ESP_OK)
        return read_result;
    const std::string text(bytes.begin(), bytes.end());
    Json json(supported_json_text(text)
                  ? cJSON_ParseWithLengthOpts(text.c_str(), text.size() + 1, nullptr, true)
                  : nullptr,
              cJSON_Delete);
    std::string error;
    DeviceConfig loaded = current;
    if (json && cJSON_HasObjectItem(json.get(), "hardware")
        && (!patch_hardware(json.get(), loaded.hardware, error)
            || board_profile_find(loaded.hardware.boardId) == nullptr)) {
        ESP_LOGE(kTag, "Invalid saved hardware profile; refusing to activate GPIO mapping");
        return ESP_ERR_INVALID_ARG;
    }
    current.hardware = loaded.hardware;
    const auto* schema =
        json ? cJSON_GetObjectItemCaseSensitive(json.get(), "schemaVersion") : nullptr;
    const auto* rev = json ? cJSON_GetObjectItemCaseSensitive(json.get(), "revision") : nullptr;
    if (cJSON_IsNumber(schema) && schema->valuedouble == 1 && cJSON_IsNumber(rev)
        && std::isfinite(rev->valuedouble) && std::floor(rev->valuedouble) == rev->valuedouble
        && rev->valuedouble >= 1 && rev->valuedouble <= UINT32_MAX
        && patch_config(json.get(), loaded, error)) {
        loaded.revision = static_cast<std::uint32_t>(rev->valuedouble);
        current = loaded;
    } else
        ESP_LOGE(kTag, "Invalid saved network configuration; using recovery defaults");
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy the current settings, including secrets.
 * @return Independent value snapshot. Thread-safe; do not expose or log its secrets.
 * @endcond
 */
DeviceConfig config_get()
{
    std::lock_guard<std::mutex> lock(mutex);
    return current;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Build the redacted public configuration.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on allocation failure.
 * @note Thread-safe; passwordSet indicators replace password values.
 * @endcond
 */
cJSON* config_public_json()
{
    std::lock_guard<std::mutex> lock(mutex);
    return serialize(current, false);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Persist a partial settings patch using its baseRevision.
 * @param[in] patch Borrowed JSON containing baseRevision and changed sections.
 * @param[out] error Failure diagnostic.
 * @param[out] network_changed True only when a successful change needs a deferred network apply.
 * @return ESP_OK, INVALID_ARG for validation, INVALID_STATE for CAS/freeze/exhaustion,
 * or a persistence/allocation error. Failure leaves RAM and durable settings unchanged.
 * @note Thread-safe; takes a SettingsWriteGuard before the configuration mutex.
 * @endcond
 */
esp_err_t config_update(const cJSON* patch, std::string& error, bool& network_changed)
{
    SettingsWriteGuard mutation;
    if (!mutation) {
        network_changed = false;
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return ESP_ERR_INVALID_STATE;
    }
    std::lock_guard<std::mutex> lock(mutex);
    network_changed = false;
    if (!operation_permitted()) {
        error = "Срок запроса истёк или соединение сменилось";
        return ESP_ERR_INVALID_STATE;
    }
    const cJSON* rev = cJSON_GetObjectItemCaseSensitive(patch, "baseRevision");
    if (!cJSON_IsNumber(rev) || rev->valuedouble != current.revision) {
        error = "Настройки уже изменились: обновите страницу";
        return ESP_ERR_INVALID_STATE;
    }
    DeviceConfig next = current;
    if (!patch_config(patch, next, error)) {
        if (error.empty())
            error = "Неверная конфигурация";
        return ESP_ERR_INVALID_ARG;
    }
    const auto next_record = compact(next);
    const auto current_record = compact(current);
    if (next_record.empty() || current_record.empty()) {
        error = "Недостаточно памяти";
        return ESP_ERR_NO_MEM;
    }
    if (next_record == current_record)
        return ESP_OK;
    if (next.revision == UINT32_MAX) {
        error = "Исчерпана ревизия конфигурации";
        return ESP_ERR_INVALID_STATE;
    }
    next.revision++;
    const esp_err_t result = save(next);
    if (result != ESP_OK) {
        error = "Не удалось сохранить настройки во Flash";
        return result;
    }
    const bool profile_pending = next.hardware.boardId != board_profile_active().id;
    // Profile selection takes effect at startup, never by live interface apply.
    network_changed =
        !profile_pending
        && (cJSON_HasObjectItem(patch, "wifi") || cJSON_HasObjectItem(patch, "ethernet")
            || cJSON_HasObjectItem(patch, "linux"));
    current = std::move(next);
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Restore Wi-Fi/AP and Ethernet recovery defaults while preserving other settings.
 * @return ESP_OK or a freeze, exhausted-revision or storage error; no mutation on failure.
 * @note Thread-safe. The caller requests network apply after a successful save.
 * @endcond
 */
esp_err_t config_reset_networks()
{
    SettingsWriteGuard mutation;
    if (!mutation)
        return ESP_ERR_INVALID_STATE;
    std::lock_guard<std::mutex> lock(mutex);
    if (current.revision == UINT32_MAX)
        return ESP_ERR_INVALID_STATE;
    DeviceConfig next = current;
    const std::string ssid = next.wifi.ap.ssid.empty() ? "FCPLCn-Recovery" : next.wifi.ap.ssid;
    next.wifi = WifiConfig{};
    next.wifi.ap.ssid = ssid;
    next.ethernet = EthernetConfig{};
    next.revision++;
    esp_err_t err = save(next);
    if (err == ESP_OK)
        current = std::move(next);
    return err;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Obtain the immutable hardware-derived identifier.
 * @return Borrowed reference with process lifetime after config_init().
 * @pre Initialization has completed and is not running concurrently.
 * @endcond
 */
const std::string& device_id()
{
    return identity;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Convert a stored device section to a complete backup, including secrets.
 * @param[in] record Borrowed serialized device section.
 * @param[out] error Failure diagnostic.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on invalid record/allocation failure.
 * @note Pure codec; no module locks or persistent mutation.
 * @endcond
 */
cJSON* config_backup_json(const SettingsBytes& record, std::string& error)
{
    DeviceConfig config;
    if (!decode_record(record, config, error))
        return nullptr;
    Json json(serialize(config, true), cJSON_Delete);
    if (!json)
        return nullptr;
    cJSON_DeleteItemFromObjectCaseSensitive(json.get(), "schemaVersion");
    cJSON_DeleteItemFromObjectCaseSensitive(json.get(), "revision");
    auto* wifi = cJSON_GetObjectItemCaseSensitive(json.get(), "wifi");
    cJSON_DeleteItemFromObjectCaseSensitive(cJSON_GetObjectItemCaseSensitive(wifi, "ap"),
                                            "passwordSet");
    cJSON_DeleteItemFromObjectCaseSensitive(cJSON_GetObjectItemCaseSensitive(wifi, "sta"),
                                            "passwordSet");
    cJSON_DeleteItemFromObjectCaseSensitive(cJSON_GetObjectItemCaseSensitive(json.get(), "linux"),
                                            "passwordSet");
    if (!backup_schema(json.get()))
        return nullptr;
    return json.release();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and encode a complete device backup section.
 * @param[in] json Borrowed complete settings object; unknown/missing fields are rejected.
 * @param[in] revision Nonzero revision to assign to the encoded record.
 * @param[out] record Encoded bytes on success; caller retains ownership.
 * @param[out] error Failure diagnostic.
 * @return True on successful validation/encoding. Pure, thread-safe codec.
 * @endcond
 */
bool config_backup_record(const cJSON* json,
                          std::uint32_t revision,
                          SettingsBytes& record,
                          std::string& error)
{
    if (!backup_schema(json) || revision == 0) {
        error = "Неполная или неизвестная схема настроек устройства";
        return false;
    }
    DeviceConfig config;
    config.revision = revision;
    if (!patch_config(json, config, error))
        return false;
    const auto text = compact(config);
    if (text.empty()) {
        error = "Недостаточно памяти";
        return false;
    }
    record.assign(text.begin(), text.end());
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read the revision of a fully validated stored device section.
 * @param[in] record Borrowed serialized section.
 * @param[out] revision Decoded revision on success.
 * @param[out] error Failure diagnostic.
 * @return True on success; no locks or persistent mutation.
 * @endcond
 */
bool config_record_revision(const SettingsBytes& record,
                            std::uint32_t& revision,
                            std::string& error)
{
    DeviceConfig config;
    if (!decode_record(record, config, error))
        return false;
    revision = config.revision;
    return true;
}
