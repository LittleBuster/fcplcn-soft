/**
 * @file controller_thermostat.cpp
 * @brief Autonomous thermostat regulation, dwell protection and operative flags.
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
 * @brief Resolve a Meteo reference to its selected, fresh physical measurement.
 * @details Names are cosmetic. Port/protocol/ROM edits require a sample newer
 * than their binding epoch; absent/disabled/stale sources remain fault OFF.
 * expiresAtUs travels to the final hardware write, closing lock/I2C wait races.
 * @param[in] id Saved Meteo item identifier, reusable by multiple thermostats.
 * @return Owned temperature/source snapshot with an absolute expiry or a specific unavailable
 * reason.
 * @pre The caller holds controller_mutex while reading Meteo configuration and binding epochs.
 * @note Failed current acquisition reuses only a previously observed valid value of the same
 * binding until its original 15-second expiry. A failure never renews that timestamp.
 */
TemperatureSample temperature_sample(std::string_view id)
{
    TemperatureSample sample;
    const auto module = index(ControllerKind::Meteo);
    const auto& config = configurations[module];
    const auto found =
        std::find_if(config.items.begin(), config.items.end(), [&](const auto& item) {
            return item.id == id;
        });
    if (found == config.items.end()) {
        sample.error = "Источник Метео удалён или не найден";
        return sample;
    }
    auto& cache = runtimes[module][static_cast<std::size_t>(found - config.items.begin())];
    sample.name = found->name;
    sample.signature = found->portId + "|" + sensor_id(found->sensorType) + "|" + found->address;
    if (!config.enabled || config.boardId != board_profile_active().id
        || !known_sensor_port(found->portId)) {
        cache.cachedTemperature = false;
        sample.error = "Источник Метео выключен или порт недоступен";
        return sample;
    }
    const auto reading = meteo_sensors_read(found->portId);
    const auto now = esp_timer_get_time() / 1000;
    std::int64_t last = reading.lastSuccessMs;
    sample.error = reading.error;
    if (found->sensorType == SensorProtocol::Dht22) {
        sample.value = reading.temperatureC;
        sample.available = reading.available && fresh_measurement(last, now)
                           && std::isfinite(sample.value) && std::isfinite(reading.humidityPct);
    } else {
        const auto device =
            std::find_if(reading.devices.begin(), reading.devices.end(), [&](const auto& value) {
                return value.address == found->address;
            });
        if (device != reading.devices.end()) {
            last = device->lastSuccessMs;
            sample.value = device->temperatureC;
            sample.available =
                device->available && fresh_measurement(last, now) && std::isfinite(sample.value);
            if (!device->error.empty())
                sample.error = device->error;
        } else
            sample.error = "Выбранный DS18B20 не найден";
    }
    if (last <= cache.bindingChangedAtMs)
        sample.available = false;
    if (sample.available) {
        const auto maximum = std::numeric_limits<std::int64_t>::max();
        const auto expiry =
            last > maximum / 1000 - kMeteoStaleMs ? maximum : (last + kMeteoStaleMs) * 1000;
        if (esp_timer_get_time() < expiry) {
            cache.cachedTemperature = true;
            cache.lastTemperatureC = sample.value;
            cache.lastTemperatureMs = last;
            cache.lastTemperatureExpiryUs = expiry;
            cache.cachedSensorSignature = sample.signature;
        } else
            sample.available = false;
    }
    // A failed acquisition may overwrite the driver's numerical fields. Never
    // treat those fields as a good sample merely because lastSuccessMs survived.
    // Reuse only the exact successful value previously observed for this binding.
    if (!sample.available && cache.cachedTemperature
        && cache.cachedSensorSignature == sample.signature
        && cache.lastTemperatureMs > cache.bindingChangedAtMs
        && fresh_measurement(cache.lastTemperatureMs, now)
        && esp_timer_get_time() < cache.lastTemperatureExpiryUs) {
        sample.value = cache.lastTemperatureC;
        sample.available = true;
        sample.cached = true;
    }
    if (sample.available) {
        sample.expiresAtUs = cache.lastTemperatureExpiryUs;
        sample.error.clear();
    } else {
        cache.cachedTemperature = false;
        if (cache.bindingChangedAtMs >= 0 && last <= cache.bindingChangedAtMs)
            sample.error = "Ожидается новое измерение после изменения источника";
        else if (sample.error.empty())
            sample.error = "Нет свежей температуры Метео";
    }
    return sample;
}

/**
 * @brief Compare the fields that preserve a thermostat's current regulation state.
 * @param[in] a Existing row.
 * @param[in] b Candidate row.
 * @return True when item ID, output relay, Meteo reference and heat/cool mode match.
 * @note Button assignment, display name and thresholds do not define this regulation binding.
 */
bool thermostat_binding(const Item& a, const Item& b)
{
    return a.id == b.id && a.relayId == b.relayId && a.meteoId == b.meteoId && a.mode == b.mode;
}

/**
 * @brief Resolve a thermostat's optional button input independently of its sensor/output health.
 * @param[in] item Thermostat row with an optional input binding.
 * @param[out] input Physical input snapshot when a binding exists and can be read.
 * @param[out] error Input-specific diagnostic, cleared for an absent or healthy input.
 * @return True for no button or an exclusive, valid and fresh input; false disables only button
 * toggling.
 * @pre The caller holds controller_mutex while inspecting shared input claims.
 */
bool thermostat_input(const Item& item, HardwareIoChannelState& input, std::string& error)
{
    if (item.inputId.empty()) {
        error.clear();
        return true;
    }
    if (claim_count(configurations, ResourceKind::Input, item.inputId) > 1) {
        error = "Вход назначен нескольким элементам; кнопка отключена";
        return false;
    }
    if (hardware_io_read_input(item.inputId, input) != ESP_OK || !input.valid || !input.fresh) {
        error = "Нет свежих данных кнопочного входа";
        return false;
    }
    error.clear();
    return true;
}

/**
 * @brief Remember a confirmed output transition without refreshing an unchanged state epoch.
 * @param[in,out] runtime Thermostat transient state.
 * @param[in] value Confirmed physical relay level.
 * @param[in] now Monotonic confirmation time in microseconds.
 * @param[in] restart Force a new conservative epoch after startup/recovery/binding change.
 * @note A failed or unknown output must invalidate transitionAtUs rather than call this helper.
 */
void confirmed_transition(Runtime& runtime, bool value, std::int64_t now, bool restart)
{
    if (restart || runtime.transitionAtUs < 0 || runtime.transitionValue != value) {
        runtime.transitionAtUs = now;
        runtime.transitionValue = value;
    }
}

/**
 * @brief Latch a RAM-only control inhibit and request safe output OFF after a command failure.
 * @param[in] item_index Thermostat row index in the current module.
 * @param[in] error Failure text retained until an explicit successful operative-flag command.
 * @pre The caller holds controller_mutex and the row/runtime indices exist.
 * @note The confirmed durable enabled flag is unchanged; an OFF request does not imply physical
 * confirmation.
 */
void inhibit_thermostat(std::size_t item_index, const std::string& error)
{
    const auto module = index(ControllerKind::Thermostats);
    auto& runtime = runtimes[module][item_index];
    runtime.inhibited = true;
    runtime.inhibitError = error;
    runtime.holdUntilUs = 0;
    runtime.holdReason.clear();
    runtime.thermostatDemand = false;
    runtime.sensorHealthy = false;
    runtime.lastAttemptUs = -1;
    runtime.error = error;
    if (hardware_io_set_relay(configurations[module].items[item_index].relayId, false) == ESP_OK)
        confirmed_transition(runtime, false, esp_timer_get_time(), true);
    else
        runtime.transitionAtUs = -1;
}

/**
 * @brief Confirm an operative flag under the controller lock and one outer writer guard.
 * @details This path never requests ON. It confirms OFF before a permission
 * transition, rechecks delivery expiry before FRAM, and clears inhibit only after
 * success. Storage/I/O failure preserves the confirmed flag but holds RAM OFF.
 * Button debounce fields are untouched, so persistence cannot replay held LOW.
 * @param[in] item_index Existing thermostat row/runtime index.
 * @param[in] enabled Requested durable permission for local regulation.
 * @param[out] error Failure diagnostic, cleared on successful confirmation.
 * @param[in] deadlineUs Optional absolute uptime delivery deadline in microseconds; zero is
 * unlimited.
 * @return Confirmation, unavailable/expiry conflict or storage failure.
 * @pre The caller holds controller_mutex after obtaining the outer settings writer guard.
 */
ControllerResult set_thermostat_enabled_locked(std::size_t item_index,
                                               bool enabled,
                                               std::string& error,
                                               std::int64_t deadlineUs)
{
    if (deadline_expired(deadlineUs))
        return expired(error);
    const auto module = index(ControllerKind::Thermostats);
    auto& config = configurations[module];
    auto& item = config.items[item_index];
    auto& runtime = runtimes[module][item_index];
    if (config.boardId != board_profile_active().id)
        return unavailable(error, "Термостат относится к другой плате");
    if (item.enabled == enabled && enabled && !runtime.inhibited && state_storage_healthy()) {
        error.clear();
        return SocketResult::Ok;
    }
    // A flag command never directly energizes the relay. OFF is confirmed before
    // persisting a new operative state or clearing a previous storage inhibit.
    HardwareIoChannelState relay;
    const bool ready =
        hardware_io_read_relay(item.relayId, relay) == ESP_OK && relay.valid && relay.fresh;
    if (deadline_expired(deadlineUs))
        return expired(error);
    if (!ready || relay.value) {
        if (hardware_io_set_relay(item.relayId, false) != ESP_OK) {
            error = "Выключение реле не подтверждено; термостат заблокирован до успешной команды";
            inhibit_thermostat(item_index, error);
            return SocketResult::Unavailable;
        }
    }
    confirmed_transition(runtime, false, esp_timer_get_time(), !ready || relay.value);
    if (deadline_expired(deadlineUs)) {
        error = "Срок команды истёк до сохранения; удерживается безопасный OFF";
        inhibit_thermostat(item_index, error);
        return SocketResult::Conflict;
    }
    const bool must_save = item.enabled != enabled || runtime.inhibited || !state_storage_healthy();
    if (must_save) {
        Configurations next = configurations;
        next[module].items[item_index].enabled = enabled;
        // The deadline limits acceptance, not the life of the enabled flag.
        // Once the FRAM operation starts in time it may finish after the deadline.
        if (deadline_expired(deadlineUs)) {
            error = "Срок команды истёк до сохранения; удерживается безопасный OFF";
            inhibit_thermostat(item_index, error);
            return SocketResult::Conflict;
        }
        if (save_states(next) != ESP_OK) {
            error =
                "Не удалось сохранить выключатель; термостат заблокирован в OFF до успешной команды";
            inhibit_thermostat(item_index, error);
            return SocketResult::StorageError;
        }
    }
    item.enabled = enabled;
    runtime.inhibited = false;
    runtime.inhibitError.clear();
    runtime.holdUntilUs = 0;
    runtime.holdReason.clear();
    runtime.thermostatDemand = false;
    runtime.sensorHealthy = false;
    runtime.lastAttemptUs = -1;
    runtime.error.clear();
    // Keep baseline/armed/lockout intact: a held LOW must not toggle twice.
    error.clear();
    return SocketResult::Ok;
}

/**
 * @brief Run local heat/cool regulation without writing NVS.
 * @details Heating turns ON at T<=S-H and OFF at T>=S; cooling turns ON at
 * T>=S+H and OFF at T<=S. Healthy samples inside the band hold demand. Startup,
 * generation/source changes, stale data or drift reset OFF; only a fresh sample
 * at the ON threshold can restart. ON uses the sample's absolute expiry under
 * the final hardware mutex; OFF is never prevented by that delivery deadline.
 * @pre The caller holds controller_mutex and an outer settings write guard.
 * @note Fixed 60-second minimum ON/OFF dwell starts at confirmed physical transitions. Disabled
 * permissions, stale/missing sources, output faults and restore staging bypass minimum ON for
 * safety OFF.
 * @note Optional button faults affect only toggling permission. Regulation depends on the local
 * sensor/output health, master/item flags and inhibit; its automatic demand is RAM-only.
 */
void thermostats_step_locked()
{
    const auto module = index(ControllerKind::Thermostats);
    const auto& config = configurations[module];
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& item = config.items[i];
        auto& runtime = runtimes[module][i];
        if (!config.enabled || config.boardId != board_profile_active().id || item.inputId.empty())
            runtime.baseline = false;
        else {
            HardwareIoChannelState input;
            std::string input_error;
            if (!thermostat_input(item, input, input_error))
                runtime.baseline = false;
            else if (button_press(runtime, input, item.inputId)) {
                std::string command_error;
                set_thermostat_enabled_locked(i, !item.enabled, command_error);
            }
        }
        auto sample = temperature_sample(item.meteoId);
        HardwareIoChannelState relay;
        const bool relay_ready =
            hardware_io_read_relay(item.relayId, relay) == ESP_OK && relay.valid && relay.fresh;
        const auto now = esp_timer_get_time();
        if (sample.available && now >= sample.expiresAtUs) {
            sample.available = false;
            sample.error = "Температура Метео устарела";
        }
        const bool generation_changed =
            relay_ready && (!runtime.seenRelay || runtime.relayGeneration != relay.generation);
        if (relay_ready) {
            runtime.seenRelay = true;
            runtime.relayGeneration = relay.generation;
        }
        const bool source_changed = runtime.sensorSignature != sample.signature;
        runtime.holdUntilUs = 0;
        runtime.holdReason.clear();
        const bool drift =
            relay_ready && runtime.sensorHealthy && relay.value != runtime.thermostatDemand;
        if (generation_changed || source_changed || drift) {
            runtime.thermostatDemand = false;
            runtime.sensorHealthy = false;
            runtime.transitionAtUs = -1;
        }
        if (relay_ready)
            confirmed_transition(runtime, relay.value, now);
        else
            runtime.transitionAtUs = -1;
        runtime.sensorSignature = sample.signature;
        const bool enabled = config.enabled && item.enabled && !runtime.inhibited
                             && config.boardId == board_profile_active().id;
        const bool healthy = enabled && sample.available && relay_ready;
        if (!healthy) {
            runtime.thermostatDemand = false;
            runtime.sensorHealthy = false;
            runtime.error = runtime.inhibited   ? runtime.inhibitError
                            : !config.enabled   ? "Термостаты выключены"
                            : !item.enabled     ? "Термостат выключен"
                            : !sample.available ? sample.error
                                                : "Нет свежих данных реле";
            if ((!relay_ready || relay.value)
                && (generation_changed || runtime.lastAttemptUs < 0
                    || now - runtime.lastAttemptUs >= kRetryUs)) {
                runtime.lastAttemptUs = now;
                if (hardware_io_set_relay(item.relayId, false) == ESP_OK) {
                    runtime.lastAttemptUs = -1;
                    confirmed_transition(runtime, false, esp_timer_get_time(), !relay_ready);
                } else {
                    runtime.transitionAtUs = -1;
                    runtime.error += "; выключение реле не подтверждено";
                }
            }
            continue;
        }
        if (!runtime.sensorHealthy) {
            runtime.thermostatDemand = false;
            // Startup/recovery/drift begins OFF even when the temperature lies
            // inside the dead band. Never restore an old runtime ON demand.
            if (relay.value) {
                runtime.lastAttemptUs = now;
                if (hardware_io_set_relay(item.relayId, false) != ESP_OK) {
                    runtime.error = "Реле не подтвердило безопасное выключение";
                    continue;
                }
                relay.value = false;
                confirmed_transition(runtime, false, esp_timer_get_time());
                runtime.lastAttemptUs = -1;
            }
        }
        if (runtime.lastAttemptUs >= 0 && now - runtime.lastAttemptUs < kRetryUs) {
            runtime.thermostatDemand = false;
            runtime.sensorHealthy = false;
            continue;  // Safety OFF takes priority over the ON retry backoff.
        }
        bool desired = runtime.thermostatDemand;
        constexpr double epsilon = 1e-9;
        if (item.mode == ThermostatMode::Heating) {
            if (sample.value >= item.setpointC - epsilon)
                desired = false;
            else if (sample.value <= item.setpointC - item.hysteresisC + epsilon)
                desired = true;
        } else {
            if (sample.value <= item.setpointC + epsilon)
                desired = false;
            else if (sample.value >= item.setpointC + item.hysteresisC - epsilon)
                desired = true;
        }
        if (relay.value != desired) {
            const auto seconds = kThermostatMinimumCycleSeconds;
            const auto hold_until =
                runtime.transitionAtUs + static_cast<std::int64_t>(seconds) * 1'000'000;
            if (now < hold_until) {
                desired = relay.value;
                runtime.holdUntilUs = hold_until;
                runtime.holdReason = relay.value ? "minimum_on" : "minimum_off";
            }
        }
        if (relay.value != desired) {
            runtime.lastAttemptUs = now;
            const auto result =
                desired ? hardware_io_set_relay_until(item.relayId, true, sample.expiresAtUs)
                        : hardware_io_set_relay(item.relayId, false);
            if (result != ESP_OK) {
                runtime.thermostatDemand = false;
                runtime.sensorHealthy = false;
                runtime.transitionAtUs = -1;
                // A failed readback can follow an applied ON write.
                if (desired)
                    hardware_io_set_relay(item.relayId, false);
                runtime.error = result == ESP_ERR_TIMEOUT
                                    ? "Температура устарела до включения; задано OFF"
                                    : "Реле не подтвердило переключение; задано аварийное OFF";
                continue;
            }
        }
        confirmed_transition(runtime, desired, esp_timer_get_time());
        runtime.lastAttemptUs = -1;
        runtime.thermostatDemand = desired;
        runtime.sensorHealthy = true;
        runtime.error.clear();
    }
}

/**
 * @brief Build thermostat settings, regulation state and independent sensor/output/button
 * diagnostics.
 * @return Newly allocated JSON object owned by the caller, or nullptr on allocation failure.
 * @pre The caller holds controller_mutex.
 * @note Reads current sensor and hardware caches and rechecks freshness; no control action or
 * persistence occurs.
 */
cJSON* thermostats_status_locked()
{
    const auto module = index(ControllerKind::Thermostats);
    const auto& config = configurations[module];
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddNumberToObject(root.get(), "revision", config.revision)
        || !cJSON_AddBoolToObject(root.get(), "enabled", config.enabled))
        return nullptr;
    auto* items = cJSON_AddArrayToObject(root.get(), "items");
    auto* ports = cJSON_AddObjectToObject(root.get(), "ports");
    auto* relays = ports ? cJSON_AddArrayToObject(ports, "relays") : nullptr;
    auto* inputs = ports ? cJSON_AddArrayToObject(ports, "inputs") : nullptr;
    if (!items || !relays || !inputs)
        return nullptr;
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& item = config.items[i];
        const auto& runtime = runtimes[module][i];
        auto sample = temperature_sample(item.meteoId);
        HardwareIoChannelState relay;
        const bool relay_ready =
            hardware_io_read_relay(item.relayId, relay) == ESP_OK && relay.valid && relay.fresh;
        HardwareIoChannelState input;
        std::string input_error;
        const bool input_available = thermostat_input(item, input, input_error);
        if (sample.available && esp_timer_get_time() >= sample.expiresAtUs) {
            sample.available = false;
            sample.error = "Температура Метео устарела";
        }
        const bool available = initialized && worker_error == ESP_OK && !settings_restore_pending()
                               && config.enabled && item.enabled && !runtime.inhibited
                               && config.boardId == board_profile_active().id && relay_ready
                               && sample.available;
        std::string error = runtime.error;
        if (runtime.inhibited)
            error = runtime.inhibitError;
        else if (!config.enabled)
            error = "Термостаты выключены";
        else if (!item.enabled)
            error = "Термостат выключен";
        else if (!sample.available)
            error = sample.error;
        else if (!relay_ready)
            error = "Нет свежих данных реле";
        const auto hold_remaining =
            std::max<std::int64_t>(0, runtime.holdUntilUs - esp_timer_get_time());
        Json json(cJSON_CreateObject(), cJSON_Delete);
        if (!json || !cJSON_AddStringToObject(json.get(), "id", item.id.c_str())
            || !cJSON_AddStringToObject(json.get(), "name", item.name.c_str())
            || !cJSON_AddStringToObject(json.get(), "meteoId", item.meteoId.c_str())
            || !cJSON_AddStringToObject(json.get(), "relayId", item.relayId.c_str())
            || !cJSON_AddStringToObject(json.get(), "inputId", item.inputId.c_str())
            || !cJSON_AddBoolToObject(json.get(), "enabled", item.enabled)
            || !cJSON_AddBoolToObject(json.get(), "inhibited", runtime.inhibited)
            || !cJSON_AddBoolToObject(json.get(), "inputAvailable", input_available)
            || !cJSON_AddStringToObject(json.get(), "inputError", input_error.c_str())
            || !(!item.inputId.empty() && input_available
                     ? cJSON_AddBoolToObject(json.get(), "inputLevel", input.value)
                     : cJSON_AddNullToObject(json.get(), "inputLevel"))
            || !cJSON_AddStringToObject(json.get(), "mode", mode_id(item.mode))
            || !cJSON_AddNumberToObject(json.get(), "setpointC", item.setpointC)
            || !cJSON_AddNumberToObject(json.get(), "hysteresisC", item.hysteresisC)
            || !cJSON_AddStringToObject(json.get(), "holdReason", runtime.holdReason.c_str())
            || !cJSON_AddNumberToObject(
                json.get(), "holdRemainingSeconds", (hold_remaining + 999'999) / 1'000'000)
            || !cJSON_AddBoolToObject(json.get(), "usingCachedTemperature", sample.cached)
            || !cJSON_AddStringToObject(json.get(), "sensorName", sample.name.c_str())
            || !cJSON_AddBoolToObject(json.get(), "state", runtime.thermostatDemand)
            || !cJSON_AddBoolToObject(json.get(), "sensorAvailable", sample.available)
            || !cJSON_AddBoolToObject(json.get(), "available", available)
            || !cJSON_AddStringToObject(json.get(), "error", error.c_str())
            || !(sample.available
                     ? cJSON_AddNumberToObject(json.get(), "temperatureC", sample.value)
                     : cJSON_AddNullToObject(json.get(), "temperatureC"))
            || !(relay_ready ? cJSON_AddBoolToObject(json.get(), "actual", relay.value)
                             : cJSON_AddNullToObject(json.get(), "actual"))
            || !cJSON_AddItemToArray(items, json.get()))
            return nullptr;
        json.release();
    }
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.relayCount; ++i) {
        Json relay(cJSON_CreateString(board.relays[i].name), cJSON_Delete);
        if (!relay || !cJSON_AddItemToArray(relays, relay.get()))
            return nullptr;
        relay.release();
    }
    for (std::size_t i = 0; i < board.inputCount; ++i) {
        Json input(cJSON_CreateString(board.inputs[i].name), cJSON_Delete);
        if (!input || !cJSON_AddItemToArray(inputs, input.get()))
            return nullptr;
        input.release();
    }
    return root.release();
}

/**
 * @brief Decode the strict thermostat row schema used by configuration or full backup.
 * @param[in] json Borrowed row object.
 * @param[in,out] item Destination row populated field by field; may be partial on failure.
 * @param[in] backup True requires portable enabled/inputId and rejects obsolete duration fields.
 * Ordinary older editors may supply validated legacy durations, which are ignored.
 * @return True for the correct schema and finite numeric fields; ranges/claims are validated
 * afterward.
 */
bool parse_thermostat_item(const cJSON* json, Item& item, bool backup)
{
    const auto* setpoint = cJSON_GetObjectItemCaseSensitive(json, "setpointC");
    const auto* hysteresis = cJSON_GetObjectItemCaseSensitive(json, "hysteresisC");
    const bool schema = settings_json_fields(
        json,
        {"id", "name", "meteoId", "relayId", "mode", "setpointC", "hysteresisC"},
        backup ? std::initializer_list<const char*>{"inputId", "enabled"}
               : std::initializer_list<const char*>{"inputId", "minOnSeconds", "minOffSeconds"});
    const auto* enabled = cJSON_GetObjectItemCaseSensitive(json, "enabled");
    std::string mode;
    if (!schema || (backup && (!cJSON_IsBool(enabled) || !cJSON_HasObjectItem(json, "inputId")))
        || !text_field(json, "id", item.id, kSocketMaxIdBytes)
        || !text_field(json, "name", item.name, kSocketMaxNameBytes)
        || !text_field(json, "meteoId", item.meteoId, kSocketMaxIdBytes)
        || !text_field(json, "relayId", item.relayId, 32)
        || !text_field(json, "inputId", item.inputId, 32, !backup)
        || !text_field(json, "mode", mode, 16) || (mode != "heating" && mode != "cooling")
        || !cJSON_IsNumber(setpoint) || !std::isfinite(setpoint->valuedouble)
        || !cJSON_IsNumber(hysteresis) || !std::isfinite(hysteresis->valuedouble))
        return false;
    item.mode = mode == "heating" ? ThermostatMode::Heating : ThermostatMode::Cooling;
    // Accept the former editor's fields for compatibility, without changing the fixed policy.
    for (const char* field : {"minOnSeconds", "minOffSeconds"}) {
        const auto* value = cJSON_GetObjectItemCaseSensitive(json, field);
        if (value
            && (!cJSON_IsNumber(value) || !std::isfinite(value->valuedouble)
                || value->valuedouble < 0 || value->valuedouble > kLegacyMaxDwellSeconds
                || std::floor(value->valuedouble) != value->valuedouble))
            return false;
    }
    item.setpointC = setpoint->valuedouble;
    item.hysteresisC = hysteresis->valuedouble;
    if (backup)
        item.enabled = cJSON_IsTrue(enabled);
    return true;
}

/**
 * @brief Validate claims and commit thermostat settings with conservative OFF rollback.
 * @details The latest per-item flag/inhibit is retained by ID, independent of
 * config revision and web drafts. Relay/mode/source edits confirm OFF before
 * commit. Failed saves never restore old ON; successful release updates hardware
 * recovery metadata only after the new configuration becomes authoritative.
 * @param[in] request Borrowed strict replacement document with baseRevision, enabled and items.
 * @param[out] error Failure diagnostic, cleared on success.
 * @return Confirmation, schema/claim/revision conflict, hardware failure or storage failure.
 * @pre The caller holds controller_mutex after entering the settings writer gate.
 */
ControllerResult update_thermostats_locked(const cJSON* request, std::string& error)
{
    const auto module = index(ControllerKind::Thermostats);
    const auto& config = configurations[module];
    const auto* revision = cJSON_GetObjectItemCaseSensitive(request, "baseRevision");
    const auto* enabled = cJSON_GetObjectItemCaseSensitive(request, "enabled");
    const auto* items = cJSON_GetObjectItemCaseSensitive(request, "items");
    if (!settings_json_fields(request, {"baseRevision", "enabled", "items"})
        || !cJSON_IsNumber(revision) || !std::isfinite(revision->valuedouble)
        || revision->valuedouble < 1 || revision->valuedouble > UINT32_MAX
        || std::floor(revision->valuedouble) != revision->valuedouble || !cJSON_IsBool(enabled)
        || !cJSON_IsArray(items) || cJSON_GetArraySize(items) > static_cast<int>(kSocketMaxItems)) {
        error = "Укажите baseRevision, enabled и не более 16 термостатов";
        return SocketResult::InvalidInput;
    }
    if (static_cast<std::uint32_t>(revision->valuedouble) != config.revision) {
        error = "Настройки термостатов изменились. Обновите страницу";
        return SocketResult::Conflict;
    }
    Configurations next = configurations;
    auto& replacement = next[module];
    replacement = Configuration{};
    replacement.revision = config.revision;
    replacement.boardId = board_profile_active().id;
    replacement.enabled = cJSON_IsTrue(enabled);
    const cJSON* json;
    cJSON_ArrayForEach(json, items)
    {
        Item item;
        if (!parse_thermostat_item(json, item)) {
            error = "Некорректные поля термостата";
            return SocketResult::InvalidInput;
        }
        const auto& sources = configurations[index(ControllerKind::Meteo)].items;
        const bool exists = std::any_of(sources.begin(), sources.end(), [&](const auto& source) {
            return source.id == item.meteoId;
        });
        const bool retained =
            std::any_of(config.items.begin(), config.items.end(), [&](const auto& previous) {
                return previous.id == item.id && previous.meteoId == item.meteoId;
            });
        if (!exists && !retained) {
            error = "Выберите существующий источник Метео";
            return SocketResult::InvalidInput;
        }
        for (const auto& previous : config.items)
            if (previous.id == item.id) {
                item.enabled = previous.enabled;
                break;
            }
        replacement.items.push_back(std::move(item));
    }
    if (!valid_configuration(replacement, true, ControllerKind::Thermostats)) {
        error =
            "Проверьте имя, источник, реле, режим, уставку -55..125 с шагом 0.1 и H 1..20 целых градусов";
        return SocketResult::InvalidInput;
    }
    for (auto& item : replacement.items)
        item.setpointC = std::round(item.setpointC * 10) / 10;
    if (item_count(next) > kSocketMaxItems || resource_conflict(next, true)) {
        error = "Реле или вход уже заняты другим элементом";
        return SocketResult::Conflict;
    }
    if (same_configuration(config, replacement)) {
        error.clear();
        return SocketResult::Ok;
    }
    if (replacement.revision == UINT32_MAX) {
        error = "Исчерпана ревизия термостатов";
        return SocketResult::Conflict;
    }
    ++replacement.revision;
    std::vector<RelayChange> changes;
    const auto rollback_off = [&] {
        // Restoring an old physical ON after waiting for I/O or NVS could use
        // stale temperature. Keep old settings, but let the normal regulator
        // decide again from fresh data; rollback itself may only request OFF.
        for (const auto& change : changes)
            hardware_io_set_relay(change.id, false);
        for (std::size_t i = 0; i < config.items.size(); ++i) {
            if (std::any_of(changes.begin(), changes.end(), [&](const auto& change) {
                    return change.id == config.items[i].relayId;
                })) {
                auto& runtime = runtimes[module][i];
                runtime.thermostatDemand = false;
                runtime.sensorHealthy = false;
                runtime.lastAttemptUs = -1;
                runtime.error = "Изменение не подтверждено; задан безопасный OFF";
            }
        }
    };
    const auto add_off = [&](const std::string& relay) {
        if (std::none_of(changes.begin(), changes.end(), [&](const auto& change) {
                return change.id == relay;
            }))
            changes.push_back({relay, false, false, false});
    };
    const bool module_change =
        config.enabled != replacement.enabled || config.boardId != replacement.boardId;
    for (const auto& previous : config.items) {
        const bool retained = !module_change
                              && std::any_of(replacement.items.begin(),
                                             replacement.items.end(),
                                             [&](const auto& item) {
                                                 return thermostat_binding(previous, item);
                                             });
        if (!retained && config.boardId == board_profile_active().id)
            add_off(previous.relayId);
    }
    for (const auto& item : replacement.items) {
        const bool retained =
            !module_change
            && std::any_of(config.items.begin(), config.items.end(), [&](const auto& previous) {
                   return thermostat_binding(previous, item);
               });
        if (!retained)
            add_off(item.relayId);
    }
    for (auto& change : changes) {
        HardwareIoChannelState relay;
        if (hardware_io_read_relay(change.id, relay) != ESP_OK || !relay.valid || !relay.fresh) {
            rollback_off();
            return unavailable(error, "Нельзя подтвердить безопасное OFF термостата");
        }
        change.previous = relay.value;
        if (!relay.value)
            continue;
        change.changed = true;
        if (hardware_io_set_relay(change.id, false) != ESP_OK) {
            rollback_off();
            return unavailable(error, "Реле не подтвердило OFF перед изменением термостата");
        }
    }
    if (save(next) != ESP_OK) {
        rollback_off();
        error = "Не удалось сохранить термостаты";
        return SocketResult::StorageError;
    }
    std::vector<Runtime> next_runtime(replacement.items.size());
    for (std::size_t i = 0; i < replacement.items.size(); ++i)
        for (std::size_t j = 0; j < config.items.size(); ++j) {
            if (replacement.items[i].id != config.items[j].id)
                continue;
            const auto& previous = runtimes[module][j];
            if (!module_change && thermostat_binding(replacement.items[i], config.items[j]))
                next_runtime[i] = previous;
            else {
                next_runtime[i].inhibited = previous.inhibited;
                next_runtime[i].inhibitError = previous.inhibitError;
                if (!module_change && replacement.items[i].inputId == config.items[j].inputId) {
                    next_runtime[i].baseline = previous.baseline;
                    next_runtime[i].armed = previous.armed;
                    next_runtime[i].highSinceUs = previous.highSinceUs;
                    next_runtime[i].lockoutUntilUs = previous.lockoutUntilUs;
                    next_runtime[i].lastInputUs = previous.lastInputUs;
                    next_runtime[i].inputGeneration = previous.inputGeneration;
                }
            }
            if (module_change || replacement.items[i].inputId != config.items[j].inputId) {
                next_runtime[i].baseline = false;
                next_runtime[i].armed = false;
                next_runtime[i].lastInputUs = -1;
                next_runtime[i].highSinceUs = -1;
                next_runtime[i].lockoutUntilUs = 0;
            }
            break;
        }
    configurations = std::move(next);
    runtimes[module] = std::move(next_runtime);
    const auto policy_error = apply_relay_recovery_policies();
    if (policy_error != ESP_OK) {
        error =
            "Настройки сохранены, но защита восстановления реле недоступна; требуется перезапуск";
        for (std::size_t i = 0; i < configurations[module].items.size(); ++i)
            inhibit_thermostat(i, error);
        worker_error = policy_error;
        service_error = error;
        return SocketResult::Unavailable;
    }
    service_error.clear();
    error.clear();
    return SocketResult::Ok;
}

/**
 * @brief Enter the mutation gate and resolve a thermostat operative-flag command by ID.
 * @param[in] id Configured thermostat identifier.
 * @param[in] enabled Requested durable permission for autonomous regulation.
 * @param[out] error Failure diagnostic, cleared by a successful confirmation.
 * @param[in] limited True requires an unexpired monotonic delivery deadline.
 * @param[in] deadlineMs Absolute uptime deadline in milliseconds when limited is true.
 * @return Confirmation result, validation/conflict error, missing row or hardware/storage failure.
 * @note Acquires the settings writer gate before controller_mutex. The locked transaction never
 * directly energizes a relay.
 */
ControllerResult thermostat_enabled_command(
    std::string_view id, bool enabled, std::string& error, bool limited, std::int64_t deadlineMs)
{
    SettingsWriteGuard mutation;
    if (!mutation) {
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return SocketResult::Conflict;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    std::int64_t deadlineUs = 0;
    if (limited) {
        if (deadlineMs <= 0)
            return expired(error);
        if (deadlineMs > std::numeric_limits<std::int64_t>::max() / 1000) {
            error = "Некорректный срок команды";
            return SocketResult::InvalidInput;
        }
        deadlineUs = deadlineMs * 1000;
        if (deadline_expired(deadlineUs))
            return expired(error);
    }
    if (!initialized || worker_error != ESP_OK)
        return unavailable(error, "Контроллер термостатов недоступен");
    const auto& config = configurations[index(ControllerKind::Thermostats)];
    for (std::size_t i = 0; i < config.items.size(); ++i)
        if (config.items[i].id == id)
            return set_thermostat_enabled_locked(i, enabled, error, deadlineUs);
    error = "Неизвестный термостат";
    return SocketResult::NotFound;
}

}  // namespace fcplcn::controllers::detail

/** @endcond */
