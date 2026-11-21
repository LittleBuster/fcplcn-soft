/**
 * @file controller_meteo.cpp
 * @brief Meteo bindings, source acquisition configuration and reading serialization.
 */
#include "controllers/controller_internal.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <vector>

#include "hardware/board_profile.h"
#include "cJSON.h"
#include "hardware/hardware_io.h"
#include "sensors/meteo_sensors.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "config/settings_json.h"
#include "config/model.h"
#include "system/runtime_supervisor.h"
#include "util/checksum.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {

/**
 * @brief Publish one acquisition configuration per distinct saved sensor port.
 * @pre The caller holds controller_mutex and has initialized the sensor service.
 * @note Disabled or wrong-profile Meteo settings disable acquisition; OneWire rows sharing a port
 * produce a single bus configuration. This function does not persist or poll measurements.
 */
void apply_meteo_config()
{
    const auto& config = configurations[index(ControllerKind::Meteo)];
    std::vector<MeteoSensorConfig> ports;
    for (const auto& item : config.items) {
        if (std::none_of(ports.begin(), ports.end(), [&](const auto& port) {
                return port.portId == item.portId;
            }))
            ports.push_back({item.portId,
                             item.sensorType == SensorProtocol::Dht22 ? MeteoSensorType::Dht22
                                                                      : MeteoSensorType::OneWire});
    }
    meteo_sensors_configure(config.enabled && config.boardId == board_profile_active().id, ports);
}

/**
 * @brief Check the coarse 15-second freshness window of a monotonic sample timestamp.
 * @param[in] last Last successful sample time in uptime milliseconds, or a negative missing marker.
 * @param[in] now Current monotonic uptime milliseconds.
 * @return True for a nonfuture timestamp no more than 15 seconds old.
 * @note Thermostat actuation additionally rechecks the precise absolute expiry before its hardware
 * write.
 */
bool fresh_measurement(std::int64_t last, std::int64_t now)
{
    return last >= 0 && last <= now && now - last <= kMeteoStaleMs;
}

/**
 * @brief Add a trustworthy monotonic sample age or JSON null to a reading object.
 * @param[in,out] json Borrowed destination object receiving ageMs and sampledAtUptimeMs.
 * @param[in] last Successful sample time in uptime milliseconds, or a negative missing marker.
 * @param[in] now Current uptime milliseconds.
 * @return True when the numeric age or null was allocated and attached successfully.
 */
bool add_age(cJSON* json, std::int64_t last, std::int64_t now)
{
    return last >= 0 && last <= now
               ? cJSON_AddNumberToObject(json, "ageMs", now - last) != nullptr
                     && cJSON_AddNumberToObject(json, "sampledAtUptimeMs", last) != nullptr
               : cJSON_AddNullToObject(json, "ageMs") != nullptr
                     && cJSON_AddNullToObject(json, "sampledAtUptimeMs") != nullptr;
}

/**
 * @brief Serialize one discovered DS18B20 with its ROM, freshness and diagnostic.
 * @param[in] device Borrowed per-device acquisition snapshot.
 * @param[in] enabled Effective module availability for this report.
 * @param[in] now Current monotonic time in milliseconds for freshness/age calculation.
 * @return Owned JSON object, or nullptr on allocation failure; unavailable temperatures are null.
 */
cJSON* device_reading_json(const MeteoDeviceReading& device, bool enabled, std::int64_t now)
{
    const bool available = enabled && device.available
                           && fresh_measurement(device.lastSuccessMs, now)
                           && std::isfinite(device.temperatureC);
    const std::string error = !enabled                ? "Модуль выключен"
                              : available             ? ""
                              : !device.error.empty() ? device.error
                                                      : "Нет свежего измерения";
    Json json(cJSON_CreateObject(), cJSON_Delete);
    if (!json || !cJSON_AddStringToObject(json.get(), "address", device.address.c_str())
        || !cJSON_AddBoolToObject(json.get(), "available", available)
        || !cJSON_AddStringToObject(json.get(), "error", error.c_str())
        || !add_age(json.get(), device.lastSuccessMs, now)
        || !(available ? cJSON_AddNumberToObject(json.get(), "temperatureC", device.temperatureC)
                       : cJSON_AddNullToObject(json.get(), "temperatureC")))
        return nullptr;
    return json.release();
}

/**
 * @brief Build selected Meteo readings, discovered OneWire devices and the sensor-port catalog.
 * @return Newly allocated JSON object owned by the caller, or nullptr on allocation failure.
 * @pre The caller holds controller_mutex.
 * @note Missing, stale, nonfinite, disabled or service-failed samples remain unavailable and
 * serialize as null.
 */
cJSON* meteo_status_locked()
{
    const auto& config = configurations[index(ControllerKind::Meteo)];
    const auto& board = board_profile_active();
    const auto now = esp_timer_get_time() / 1000;
    const bool enabled = initialized && config.enabled && config.boardId == board.id;
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddNumberToObject(root.get(), "revision", config.revision)
        || !cJSON_AddBoolToObject(root.get(), "enabled", config.enabled))
        return nullptr;
    auto* items = cJSON_AddArrayToObject(root.get(), "items");
    auto* ports = cJSON_AddObjectToObject(root.get(), "ports");
    auto* sensors = ports ? cJSON_AddArrayToObject(ports, "sensors") : nullptr;
    if (!items || !sensors)
        return nullptr;
    for (const auto& item : config.items) {
        const auto reading = meteo_sensors_read(item.portId);
        bool available = false;
        double temperature = 0, humidity = 0;
        std::int64_t last = reading.lastSuccessMs;
        std::string error = reading.error;
        if (item.sensorType == SensorProtocol::Dht22) {
            available = enabled && reading.available && fresh_measurement(last, now)
                        && std::isfinite(reading.temperatureC)
                        && std::isfinite(reading.humidityPct);
            temperature = reading.temperatureC;
            humidity = reading.humidityPct;
        } else {
            last = -1;
            const auto found = std::find_if(
                reading.devices.begin(), reading.devices.end(), [&](const auto& device) {
                    return device.address == item.address;
                });
            if (found != reading.devices.end()) {
                last = found->lastSuccessMs;
                temperature = found->temperatureC;
                available = enabled && reading.available && found->available
                            && fresh_measurement(last, now) && std::isfinite(temperature);
                if (!found->error.empty())
                    error = found->error;
            } else
                error = "Выбранный DS18B20 не найден";
        }
        if (!service_error.empty()) {
            error = service_error;
            available = false;
        } else if (!enabled)
            error = "Модуль выключен";
        else if (available)
            error.clear();
        else if (error.empty())
            error = "Нет свежего измерения";
        Json json(cJSON_CreateObject(), cJSON_Delete);
        if (!json || !cJSON_AddStringToObject(json.get(), "id", item.id.c_str())
            || !cJSON_AddStringToObject(json.get(), "name", item.name.c_str())
            || !cJSON_AddStringToObject(json.get(), "portId", item.portId.c_str())
            || !cJSON_AddStringToObject(json.get(), "sensorType", sensor_id(item.sensorType))
            || !cJSON_AddStringToObject(json.get(), "address", item.address.c_str())
            || !cJSON_AddBoolToObject(json.get(), "available", available)
            || !cJSON_AddStringToObject(json.get(), "error", error.c_str())
            || !add_age(json.get(), last, now)
            || !(available ? cJSON_AddNumberToObject(json.get(), "temperatureC", temperature)
                           : cJSON_AddNullToObject(json.get(), "temperatureC"))
            || !(available && item.sensorType == SensorProtocol::Dht22
                     ? cJSON_AddNumberToObject(json.get(), "humidityPct", humidity)
                     : cJSON_AddNullToObject(json.get(), "humidityPct")))
            return nullptr;
        auto* devices = cJSON_AddArrayToObject(json.get(), "devices");
        if (!devices)
            return nullptr;
        if (item.sensorType == SensorProtocol::OneWire)
            for (const auto& device : reading.devices) {
                Json value(device_reading_json(device, enabled, now), cJSON_Delete);
                if (!value || !cJSON_AddItemToArray(devices, value.get()))
                    return nullptr;
                value.release();
            }
        if (!cJSON_AddItemToArray(items, json.get()))
            return nullptr;
        json.release();
    }
    for (std::size_t i = 0; i < board.sensorPortCount; ++i) {
        Json value(cJSON_CreateString(board.sensorPorts[i].name), cJSON_Delete);
        if (!value || !cJSON_AddItemToArray(sensors, value.get()))
            return nullptr;
        value.release();
    }
    if (!service_error.empty()
        && !cJSON_AddStringToObject(root.get(), "error", service_error.c_str()))
        return nullptr;
    return root.release();
}

/**
 * @brief Decode a strict Meteo row and normalize its optional DS18B20 ROM.
 * @param[in] json Borrowed row object containing only the supported Meteo fields.
 * @param[in,out] item Destination populated field by field; may be partial on failure.
 * @return True for bounded text fields and, for OneWire, a normalized valid DS18B20 address.
 * @note Port existence, name validity and resource compatibility are validated by the complete
 * configuration path.
 */
bool parse_meteo_item(const cJSON* json, Item& item)
{
    std::string type;
    if (!settings_json_fields(json, {"id", "name", "portId", "sensorType", "address"})
        || !text_field(json, "id", item.id, kSocketMaxIdBytes)
        || !text_field(json, "name", item.name, kSocketMaxNameBytes)
        || !text_field(json, "portId", item.portId, 32) || !text_field(json, "sensorType", type, 16)
        || (type != "dht22" && type != "onewire") || !text_field(json, "address", item.address, 16))
        return false;
    item.sensorType = type == "dht22" ? SensorProtocol::Dht22 : SensorProtocol::OneWire;
    return item.sensorType != SensorProtocol::OneWire || normalize_address(item.address);
}

/**
 * @brief Commit Meteo metadata and advance only changed physical binding epochs.
 * @details Sensor acquisition is configured after durable success. Cosmetic
 * renames retain measurement continuity; port/protocol/ROM changes invalidate
 * old observations for dependent thermostats until a post-edit sample arrives.
 * @param[in] request Borrowed strict replacement document with baseRevision, enabled and items.
 * @param[out] error Failure diagnostic, cleared on success.
 * @return Confirmation, invalid schema/binding, ownership/revision conflict or storage failure.
 * @pre The caller holds controller_mutex after entering the settings writer gate.
 */
ControllerResult update_meteo_locked(const cJSON* request, std::string& error)
{
    const auto module = index(ControllerKind::Meteo);
    const auto& config = configurations[module];
    const auto* revision = cJSON_GetObjectItemCaseSensitive(request, "baseRevision");
    const auto* enabled = cJSON_GetObjectItemCaseSensitive(request, "enabled");
    const auto* items = cJSON_GetObjectItemCaseSensitive(request, "items");
    if (!settings_json_fields(request, {"baseRevision", "enabled", "items"})
        || !cJSON_IsNumber(revision) || !std::isfinite(revision->valuedouble)
        || revision->valuedouble < 1 || revision->valuedouble > UINT32_MAX
        || std::floor(revision->valuedouble) != revision->valuedouble || !cJSON_IsBool(enabled)
        || !cJSON_IsArray(items) || cJSON_GetArraySize(items) > static_cast<int>(kMeteoMaxItems)) {
        error = "Укажите baseRevision, enabled и не более 16 датчиков";
        return SocketResult::InvalidInput;
    }
    if (static_cast<std::uint32_t>(revision->valuedouble) != config.revision) {
        error = "Настройки Метео изменились. Обновите страницу";
        return SocketResult::Conflict;
    }
    Configurations next = configurations;
    auto& replacement = next[module];
    replacement = Configuration{};
    replacement.boardId = board_profile_active().id;
    replacement.revision = config.revision;
    replacement.enabled = cJSON_IsTrue(enabled);
    const cJSON* json;
    cJSON_ArrayForEach(json, items)
    {
        Item item;
        if (!parse_meteo_item(json, item)) {
            error = "Некорректные поля датчика или ROM DS18B20";
            return SocketResult::InvalidInput;
        }
        replacement.items.push_back(std::move(item));
    }
    if (!valid_configuration(replacement, true, ControllerKind::Meteo)) {
        error = "Проверьте ID, имя, sensor-порт, тип и адрес датчика";
        return SocketResult::InvalidInput;
    }
    if (resource_conflict(next, true)) {
        error = "Конфликт sensor-порта: DHT22 занимает порт целиком, DS18B20 требуют разные ROM";
        return SocketResult::Conflict;
    }
    if (same_configuration(config, replacement)) {
        error.clear();
        return SocketResult::Ok;
    }
    if (replacement.revision == UINT32_MAX) {
        error = "Исчерпан счётчик версий Метео";
        return SocketResult::Conflict;
    }
    ++replacement.revision;
    if (save(next) != ESP_OK) {
        error = "Не удалось сохранить настройки Метео";
        return SocketResult::StorageError;
    }
    std::vector<Runtime> next_runtime(replacement.items.size());
    const auto changed_at = esp_timer_get_time() / 1000;
    for (std::size_t i = 0; i < replacement.items.size(); ++i) {
        bool unchanged = false;
        for (std::size_t j = 0; j < config.items.size(); ++j)
            if (same_binding(replacement.items[i], config.items[j])) {
                next_runtime[i] = runtimes[module][j];
                unchanged = true;
                break;
            }
        if (!unchanged)
            next_runtime[i].bindingChangedAtMs = changed_at;
    }
    configurations = std::move(next);
    runtimes[module] = std::move(next_runtime);
    apply_meteo_config();
    service_error.clear();
    error.clear();
    return SocketResult::Ok;
}

}  // namespace fcplcn::controllers::detail

/** @endcond */
