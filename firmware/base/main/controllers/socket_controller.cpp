/**
 * @file socket_controller.cpp
 * @brief Public controller commands and backwards-compatible Sockets facade.
 * @details Dedicated modules implement model validation, storage, switches, Meteo,
 * thermostats and status. This file owns only API orchestration and test adapters.
 */
#include "controllers/controller_internal.h"
#include "controllers/security_sync.h"

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
#include "platform/runtime_supervisor.h"
#include "platform/checksum.h"

using namespace fcplcn::controllers::detail;

// namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Load shared controller storage, register relay recovery policies and start one worker.
 * @return ESP_OK, a recovery-policy error or a worker-allocation error.
 * @details Requires initialized NVS, hardware services and an active board profile.
 * Missing/corrupt controller storage remains diagnostic and starts disabled; cold
 * boot never restores a thermostat ON demand. Call once before serving commands.
 * @endcond
 */
esp_err_t controllers_init()
{
    {
        std::lock_guard<std::mutex> lock(controller_mutex);
        if (initialized)
            return worker_error;
        configurations = defaults();
        auto result = load(configurations);
        if (result == ESP_ERR_NVS_NOT_FOUND)
            result = save(configurations);
        if (result != ESP_OK) {
            service_error = "Настройки контроллеров повреждены или недоступны; модули выключены";
            ESP_LOGW(kTag,
                     "Controller storage unavailable: %s; starting disabled",
                     esp_err_to_name(result));
        } else if (configurations[0].boardId != board_profile_active().id)
            service_error = "Сохранённые контроллеры относятся к другой аппаратной плате";
        for (std::size_t module = 0; module < kControllerCount; ++module)
            runtimes[module].assign(configurations[module].items.size(), Runtime{});
        const auto policy_error = apply_relay_recovery_policies();
        if (policy_error != ESP_OK) {
            worker_error = policy_error;
            initialized = true;
            service_error = "Защита восстановления реле недоступна; контроллеры не запущены";
            return policy_error;
        }
        apply_meteo_config();
        apply_security_config();
        initialized = true;
    }
    if (xTaskCreate(worker, "fcplcn_controls", 8192, nullptr, 3, nullptr) != pdPASS) {
        std::lock_guard<std::mutex> lock(controller_mutex);
        worker_error = ESP_ERR_NO_MEM;
        service_error = "Не удалось запустить автономные контроллеры";
        return worker_error;
    }
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Set and persist a Sockets/Lights item; other kinds reject manual demand writes.
 * @param kind Sockets or Lights.
 * @param id Configured item ID.
 * @param on Logical target state.
 * @param[out] error Failure diagnostic.
 * @return Confirmation, disabled/not-found result, or I/O/storage error.
 * @endcond
 */
ControllerResult
controller_set_state(ControllerKind kind, std::string_view id, bool on, std::string& error)
{
    if (!valid_kind(kind)) {
        error = "Неизвестный контроллер";
        return SocketResult::NotFound;
    }
    if (kind == ControllerKind::Meteo || kind == ControllerKind::Thermostats
        || kind == ControllerKind::Security || kind == ControllerKind::Tanks
        || kind == ControllerKind::Irrigation) {
        error = "Этот контроллер не поддерживает ручное SET";
        return SocketResult::InvalidInput;
    }
    SettingsWriteGuard mutation;
    if (!mutation) {
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return SocketResult::Conflict;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (!initialized)
        return unavailable(error, "Контроллер ещё не запущен");
    const auto& config = configurations[index(kind)];
    for (std::size_t i = 0; i < config.items.size(); ++i)
        if (id == config.items[i].id)
            return set_state_locked(kind, i, on, error);
    error = "Неизвестный элемент контроллера";
    return SocketResult::NotFound;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Execute a switch SET within an absolute delivery deadline.
 * @param kind Sockets or Lights.
 * @param id Configured item ID.
 * @param on Logical target state.
 * @param expiresAtUptimeMs Monotonic deadline in milliseconds, not a state lease.
 * @param[out] error Failure diagnostic.
 * @return Conflict on expiry; otherwise the normal switch SET result.
 * @details Checks expiry after lock waits, observations and immediately before
 * hardware actuation. An expired ON is never queued for a later recovery.
 * @endcond
 */
ControllerResult controller_set_state_until(ControllerKind kind,
                                            std::string_view id,
                                            bool on,
                                            std::int64_t expiresAtUptimeMs,
                                            std::string& error)
{
    if (!valid_kind(kind)) {
        error = "Неизвестный контроллер";
        return SocketResult::NotFound;
    }
    if (kind == ControllerKind::Meteo || kind == ControllerKind::Thermostats
        || kind == ControllerKind::Security || kind == ControllerKind::Tanks
        || kind == ControllerKind::Irrigation) {
        error = "Этот контроллер не поддерживает ручное SET";
        return SocketResult::InvalidInput;
    }
    SettingsWriteGuard mutation;
    if (!mutation) {
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return SocketResult::Conflict;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (expiresAtUptimeMs <= 0)
        return expired(error);
    if (expiresAtUptimeMs > std::numeric_limits<std::int64_t>::max() / 1000) {
        error = "Некорректный срок выполнения команды";
        return SocketResult::InvalidInput;
    }
    const auto deadlineUs = expiresAtUptimeMs * 1000;
    if (deadline_expired(deadlineUs))
        return expired(error);
    if (!initialized)
        return unavailable(error, "Контроллер ещё не запущен");
    const auto& config = configurations[index(kind)];
    for (std::size_t i = 0; i < config.items.size(); ++i)
        if (id == config.items[i].id)
            return set_state_locked(kind, i, on, error, deadlineUs);
    error = "Неизвестный элемент контроллера";
    return SocketResult::NotFound;
}

// namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Confirm a thermostat's durable operative flag without writing its heat/cool demand.
 * @param id Configured thermostat ID.
 * @param enabled Permission for autonomous regulation; master OFF still prevents output ON.
 * @param[out] error Failure diagnostic.
 * @return Confirmation or I/O/storage failure; config revision is unchanged.
 * @details I/O/storage failure inhibits output OFF in RAM, retaining the last
 * confirmed flag. Only an explicit successful flag command clears that inhibit;
 * config editing and a held button cannot clear it. Input/sensor faults do not
 * constitute a manual relay override or an enabled-flag lease.
 * @endcond
 */
ControllerResult
controller_thermostat_set_enabled(std::string_view id, bool enabled, std::string& error)
{
    return thermostat_enabled_command(id, enabled, error, false, 0);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Change an operative flag only if accepted before a monotonic deadline.
 * @param id Configured thermostat ID.
 * @param enabled New durable operative flag.
 * @param expiresAtUptimeMs Delivery deadline in milliseconds; not a regulation lease.
 * @param[out] error Failure diagnostic.
 * @return Conflict on expiry, or the normal operative-flag command result.
 * @details A timely NVS operation may finish after the deadline. If expiry occurs
 * after a safety OFF but before storage acceptance, the flag stays unchanged and
 * RAM inhibit holds OFF. This API never directly energizes the relay.
 * @endcond
 */
ControllerResult controller_thermostat_set_enabled_until(std::string_view id,
                                                         bool enabled,
                                                         std::int64_t expiresAtUptimeMs,
                                                         std::string& error)
{
    return thermostat_enabled_command(id, enabled, error, true, expiresAtUptimeMs);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Route a raw relay request through its owner while holding the ownership lock.
 * @param relayId Profile relay name.
 * @param on Logical target state.
 * @param[out] error Failure diagnostic.
 * @return Switch persistence result, Conflict for thermostat ownership, or driver result.
 * @details Thermostat-owned relays reject manual writes even when disabled.
 * Unowned manual outputs have RAM recovery intent but no durable controller state.
 * @endcond
 */
ControllerResult controllers_set_relay(std::string_view relayId, bool on, std::string& error)
{
    SettingsWriteGuard mutation;
    if (!mutation) {
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return SocketResult::Conflict;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (!operation_permitted())
        return expired(error);
    if (!initialized)
        return unavailable(error, "Контроллеры ещё не запущены");
    if (relayId == configurations[index(ControllerKind::Security)].security.sirenRelayId) {
        error = "Реле принадлежит сирене охраны: ручное управление запрещено";
        return SocketResult::Conflict;
    }
    for (const auto& rule : configurations[index(ControllerKind::Irrigation)].items)
        if (rule.relayId == relayId) {
            error = "Реле принадлежит автоматике полива";
            return SocketResult::Conflict;
        }
    for (const auto& item : configurations[index(ControllerKind::Tanks)].items)
        if (relayId == item.pumpRelayId || relayId == item.valveRelayId) {
            error = "Реле принадлежит автоматике бака";
            return SocketResult::Conflict;
        }
    for (const auto& item : configurations[index(ControllerKind::Thermostats)].items)
        if (relayId == item.relayId) {
            error = "Реле принадлежит термостату: ручное управление запрещено";
            return SocketResult::Conflict;
        }
    for (std::size_t module = 0; module < kRelayControllerCount; ++module)
        for (std::size_t i = 0; i < configurations[module].items.size(); ++i)
            if (relayId == configurations[module].items[i].relayId)
                return set_state_locked(static_cast<ControllerKind>(module), i, on, error);
    const auto result = hardware_io_set_relay(relayId, on);
    if (result == ESP_OK) {
        error.clear();
        return SocketResult::Ok;
    }
    if (result == ESP_ERR_NOT_FOUND || result == ESP_ERR_INVALID_ARG) {
        error = "Неизвестное реле";
        return SocketResult::NotFound;
    }
    return unavailable(error, "Реле не подтвердило новое состояние");
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and persist a revision-checked module configuration.
 * @param kind Module to edit.
 * @param request Borrowed JSON with baseRevision, enabled and items; never mutated.
 * @param[out] error Human-readable failure diagnostic.
 * @return Operation result; claims conflict before any GPIO or NVS mutation.
 * @details New thermostat rows start disabled. Existing IDs preserve the latest
 * confirmed enabled flag and RAM inhibit, so stale web drafts cannot overwrite a
 * button command. Thermostat relay/mode/source changes and removal require OFF;
 * failed storage saves retain settings and never roll output back to ON.
 * @endcond
 */
ControllerResult controller_update(ControllerKind kind, const cJSON* request, std::string& error)
{
    if (!valid_kind(kind)) {
        error = "Неизвестный контроллер";
        return SocketResult::NotFound;
    }
    SettingsWriteGuard mutation;
    if (!mutation) {
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return SocketResult::Conflict;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (!operation_permitted())
        return expired(error);
    if (!initialized || worker_error != ESP_OK)
        return unavailable(error, "Автономные контроллеры недоступны");
    if (kind == ControllerKind::Irrigation)
        return update_irrigation_locked(request, error);
    if (kind == ControllerKind::Tanks)
        return update_tanks_locked(request, error);
    if (kind == ControllerKind::Meteo)
        return update_meteo_locked(request, error);
    if (kind == ControllerKind::Security)
        return update_security_locked(request, error);
    if (kind == ControllerKind::Thermostats)
        return update_thermostats_locked(request, error);
    const auto module = index(kind);
    const auto& config = configurations[module];
    const auto* revision = cJSON_GetObjectItemCaseSensitive(request, "baseRevision");
    const auto* enabled = cJSON_GetObjectItemCaseSensitive(request, "enabled");
    const auto* items = cJSON_GetObjectItemCaseSensitive(request, "items");
    if (!cJSON_IsObject(request) || !cJSON_IsNumber(revision)
        || !std::isfinite(revision->valuedouble) || revision->valuedouble < 1
        || revision->valuedouble > UINT32_MAX
        || std::floor(revision->valuedouble) != revision->valuedouble || !cJSON_IsBool(enabled)
        || !cJSON_IsArray(items) || cJSON_GetArraySize(items) > static_cast<int>(kSocketMaxItems)) {
        error = "Укажите baseRevision, enabled и не более 16 элементов";
        return SocketResult::InvalidInput;
    }
    if (static_cast<std::uint32_t>(revision->valuedouble) != config.revision) {
        error = "Настройки контроллера изменились. Обновите страницу";
        return SocketResult::Conflict;
    }
    Configurations next = configurations;
    auto& replacement = next[module];
    replacement = Configuration{};
    replacement.revision = config.revision;
    replacement.enabled = cJSON_IsTrue(enabled);
    replacement.boardId = board_profile_active().id;
    const cJSON* object;
    cJSON_ArrayForEach(object, items)
    {
        Item item;
        if (!cJSON_IsObject(object) || !text_field(object, "id", item.id, kSocketMaxIdBytes)
            || !text_field(object, "name", item.name, kSocketMaxNameBytes)
            || !text_field(object, "relayId", item.relayId, 32)
            || !text_field(object, "inputId", item.inputId, 32, true)) {
            error = "Некорректные поля элемента";
            return SocketResult::InvalidInput;
        }
        if (replacement.enabled && config.boardId == replacement.boardId)
            for (const auto& previous : config.items)
                if (same_binding(previous, item))
                    item.state = previous.state;
        replacement.items.push_back(std::move(item));
    }
    if (!valid_configuration(replacement, true)) {
        error = "Проверьте имена, ID и доступные порты";
        return SocketResult::InvalidInput;
    }
    // Check while holding the common lock and BEFORE any GPIO or NVS changes.
    if (item_count(next) > kSocketMaxItems || resource_conflict(next, true)) {
        error = "Реле или вход уже назначены другому элементу; назначения должны быть уникальны";
        return SocketResult::Conflict;
    }
    if (same_configuration(config, replacement)) {
        error.clear();
        return SocketResult::Ok;
    }
    if (replacement.revision == UINT32_MAX) {
        error = "Исчерпан счётчик версий настроек";
        return SocketResult::Conflict;
    }
    ++replacement.revision;
    bool binding_change = config.enabled != replacement.enabled
                          || config.boardId != replacement.boardId
                          || config.items.size() != replacement.items.size();
    for (const auto& previous : config.items) {
        bool found = false;
        for (const auto& item : replacement.items)
            found = found || same_binding(previous, item);
        binding_change = binding_change || !found;
    }
    std::vector<RelayChange> changes;
    if (binding_change) {
        if (config.boardId == replacement.boardId)
            for (const auto& previous : config.items)
                changes.push_back({previous.relayId, false, false, false});
        for (const auto& item : replacement.items) {
            auto found =
                std::find_if(changes.begin(), changes.end(), [&](const RelayChange& change) {
                    return change.id == item.relayId;
                });
            if (found == changes.end())
                changes.push_back({item.relayId, item.state, false, false});
            else
                found->target = item.state;
        }
        for (auto& change : changes) {
            HardwareIoChannelState observed;
            if (hardware_io_read_relay(change.id, observed) != ESP_OK || !observed.valid
                || !observed.fresh) {
                rollback(changes);
                return unavailable(error,
                                   "Нельзя подтвердить безопасное состояние назначаемых реле");
            }
            change.previous = observed.value;
            if (observed.value == change.target)
                continue;
            change.changed = true;
            if (hardware_io_set_relay(change.id, change.target) != ESP_OK) {
                rollback(changes);
                return unavailable(error, "Реле не подтвердило безопасное переназначение");
            }
        }
    }
    if (save(next) != ESP_OK) {
        rollback(changes);
        error = "Не удалось сохранить настройки контроллеров в NVS";
        service_error = error;
        return SocketResult::StorageError;
    }
    std::vector<Runtime> next_runtime(replacement.items.size());
    if (config.enabled == replacement.enabled && config.boardId == replacement.boardId)
        for (std::size_t i = 0; i < replacement.items.size(); ++i)
            for (std::size_t j = 0; j < config.items.size(); ++j)
                if (same_binding(replacement.items[i], config.items[j]))
                    next_runtime[i] = runtimes[module][j];
    configurations = std::move(next);
    runtimes[module] = std::move(next_runtime);
    service_error.clear();
    error.clear();
    return SocketResult::Ok;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy one module's config, confirmed state and cached diagnostics under one lock.
 * @param kind Module to inspect.
 * @param includeRemoteTanks Include the bounded private catalogue in an irrigation snapshot.
 * @return Owned JSON snapshot, or nullptr for an invalid kind/allocation failure.
 * @endcond
 */
cJSON* controller_status_json(ControllerKind kind, bool includeRemoteTanks)
{
    if (!valid_kind(kind))
        return nullptr;
    std::lock_guard<std::mutex> lock(controller_mutex);
    Json result(status_locked(kind), cJSON_Delete);
    if (result && kind == ControllerKind::Irrigation && includeRemoteTanks
        && !add_remote_tanks(result.get()))
        return nullptr;
    return result.release();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Capture all module snapshots and the resource-owner catalog atomically.
 * @return Owned JSON object, or nullptr on allocation failure.
 * @details Disabled rows keep their claims. Sensors are shared only by distinct
 * OneWire ROMs on the same Meteo bus; legacy input conflicts remain visible.
 * @endcond
 */
cJSON* controllers_status_json()
{
    std::lock_guard<std::mutex> lock(controller_mutex);
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root)
        return nullptr;
    for (std::size_t module = 0; module < kControllerCount; ++module) {
        const auto kind = static_cast<ControllerKind>(module);
        Json snapshot(status_locked(kind), cJSON_Delete);
        if (!snapshot || !cJSON_AddItemToObject(root.get(), controller_id(kind), snapshot.get()))
            return nullptr;
        snapshot.release();
    }
    Json resources(resources_locked(), cJSON_Delete);
    if (!resources || !cJSON_AddItemToObject(root.get(), "resources", resources.get()))
        return nullptr;
    resources.release();
    Json storage(state_storage_json_locked(), cJSON_Delete);
    if (!storage || !cJSON_AddItemToObject(root.get(), "stateStorage", storage.get()))
        return nullptr;
    storage.release();
    return root.release();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Queue/poll a OneWire discovery without changing saved Meteo configuration.
 * @param portId Profile sensor-port name.
 * @param refresh Request a new scan instead of polling the cached job.
 * @param[out] result Owned JSON result on success; nullptr on failure.
 * @param[out] error Failure diagnostic.
 * @param itemId Optional sole DHT22 owner allowed to probe OneWire before a type edit.
 * @param baseRevision Current Meteo config revision required for that DHT22-owner probe.
 * @return Confirmation, unknown port, ownership/revision conflict or driver failure.
 * @endcond
 */
ControllerResult controller_meteo_scan(std::string_view portId,
                                       bool refresh,
                                       cJSON*& result,
                                       std::string& error,
                                       std::string_view itemId,
                                       std::uint32_t baseRevision)
{
    result = nullptr;
    SettingsWriteGuard mutation;
    if (!mutation) {
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return SocketResult::Conflict;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (!operation_permitted())
        return expired(error);
    if (!initialized)
        return unavailable(error, "Контроллер ещё не запущен");
    if (!known_sensor_port(portId)) {
        error = "Неизвестный sensor-порт";
        return SocketResult::NotFound;
    }
    if (configurations[index(ControllerKind::Security)].security.readerPortId == portId) {
        error = "Порт занят считывателем iButton охраны";
        return SocketResult::Conflict;
    }
    const auto& config = configurations[index(ControllerKind::Meteo)];
    for (const auto& item : config.items)
        if (item.portId == portId && item.sensorType != SensorProtocol::OneWire) {
            // Explicit probe for the sole saved owner permits DHT->OneWire editing
            // before a ROM is known. It never changes or persists the DHT config.
            if (claim_count(configurations, ResourceKind::Sensor, portId) != 1 || itemId != item.id
                || baseRevision != config.revision) {
                error =
                    "Порт занят DHT22; поиск допустим только его владельцу с актуальной ревизией";
                return SocketResult::Conflict;
            }
        }
    MeteoScanSnapshot scan;
    const auto status = meteo_sensors_request_scan(portId, refresh, scan);
    if (status != ESP_OK)
        return unavailable(error, "Не удалось запланировать поиск DS18B20");
    Json json(cJSON_CreateObject(), cJSON_Delete);
    if (!json || !cJSON_AddBoolToObject(json.get(), "ok", true)
        || !cJSON_AddStringToObject(json.get(), "portId", std::string(portId).c_str())
        || !cJSON_AddBoolToObject(json.get(), "busy", scan.busy)
        || !cJSON_AddBoolToObject(json.get(), "complete", scan.complete)
        || !cJSON_AddStringToObject(json.get(), "error", scan.error.c_str()))
        return unavailable(error, "Недостаточно памяти");
    auto* devices = cJSON_AddArrayToObject(json.get(), "devices");
    if (!devices)
        return unavailable(error, "Недостаточно памяти");
    const auto now = esp_timer_get_time() / 1000;
    for (const auto& device : scan.devices) {
        Json value(device_reading_json(device, true, now), cJSON_Delete);
        if (!value || !cJSON_AddItemToArray(devices, value.get()))
            return unavailable(error, "Недостаточно памяти");
        value.release();
    }
    result = json.release();
    error.clear();
    return SocketResult::Ok;
}

// Existing sockets integrations continue to call the same signatures.
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Compatibility initialization of the whole engine. @return controllers_init() result.
 * @endcond
 */
esp_err_t socket_controller_init()
{
    return controllers_init();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Capture Sockets only. @return Owned JSON snapshot, or nullptr on allocation failure.
 * @endcond
 */
cJSON* socket_controller_status_json()
{
    return controller_status_json(ControllerKind::Sockets);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Compatibility configuration update for Sockets.
 * @param request Borrowed revision-checked config JSON.
 * @param[out] error Failure diagnostic.
 * @return controller_update() result for Sockets.
 * @endcond
 */
SocketResult socket_controller_update(const cJSON* request, std::string& error)
{
    return controller_update(ControllerKind::Sockets, request, error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Compatibility durable Sockets SET.
 * @param id Configured socket ID.
 * @param on Logical target state.
 * @param[out] error Failure diagnostic.
 * @return controller_set_state() result for Sockets.
 * @endcond
 */
SocketResult socket_controller_set_state(std::string_view id, bool on, std::string& error)
{
    return controller_set_state(ControllerKind::Sockets, id, on, error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Compatibility Sockets SET with delivery expiry.
 * @param id Configured socket ID.
 * @param on Logical target state.
 * @param expiresAtUptimeMs Absolute monotonic delivery deadline in milliseconds.
 * @param[out] error Failure diagnostic.
 * @return controller_set_state_until() result for Sockets.
 * @endcond
 */
SocketResult socket_controller_set_state_until(std::string_view id,
                                               bool on,
                                               std::int64_t expiresAtUptimeMs,
                                               std::string& error)
{
    return controller_set_state_until(ControllerKind::Sockets, id, on, expiresAtUptimeMs, error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Compatibility raw-relay gateway; ownership is checked across all modules.
 * @param relayId Profile relay name.
 * @param on Logical target state.
 * @param[out] error Failure diagnostic.
 * @return controllers_set_relay() result.
 * @endcond
 */
SocketResult socket_controller_set_relay(std::string_view relayId, bool on, std::string& error)
{
    return controllers_set_relay(relayId, on, error);
}

#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Run one ordinary worker iteration against host fakes.
 * @endcond
 */
void socket_controller_test_step()
{
    worker_step();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Reset RAM for a simulated host reboot; fake tasks must be stopped and NVS is retained.
 * @endcond
 */
void socket_controller_test_reset()
{
    std::lock_guard<std::mutex> lock(controller_mutex);
    configurations = defaults();
    for (auto& runtime : runtimes)
        runtime.clear();
    initialized = false;
    worker_error = ESP_OK;
    service_error.clear();
    reset_state_storage();
    reset_security_runtime();
    security_sync_test_reset();
}
#endif
