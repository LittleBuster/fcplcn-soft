/**
 * @file controller_status.cpp
 * @brief Controller status snapshots and typed resource ownership catalog.
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
#include "platform/runtime_supervisor.h"
#include "platform/checksum.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {

/**
 * @brief Dispatch module reporting or serialize a static-switch module with physical observations.
 * @param[in] kind Valid controller module enum.
 * @return Newly allocated JSON object owned by the caller, or nullptr on allocation failure.
 * @pre The caller holds controller_mutex.
 * @note Reports saved switch state separately from confirmed physical levels and includes legacy
 * input conflicts.
 */
cJSON* status_locked(ControllerKind kind)
{
    if (kind == ControllerKind::Irrigation)
        return irrigation_status_locked();
    if (kind == ControllerKind::Tanks)
        return tanks_status_locked();
    if (kind == ControllerKind::Security)
        return security_status_locked();
    if (kind == ControllerKind::Meteo)
        return meteo_status_locked();
    if (kind == ControllerKind::Thermostats)
        return thermostats_status_locked();
    const auto module = index(kind);
    const auto& config = configurations[module];
    const auto& runtime = runtimes[module];
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddNumberToObject(root.get(), "revision", config.revision)
        || !cJSON_AddBoolToObject(root.get(), "enabled", config.enabled))
        return nullptr;
    auto* items = cJSON_AddArrayToObject(root.get(), "items");
    auto* ports = cJSON_AddObjectToObject(root.get(), "ports");
    if (!items || !ports)
        return nullptr;
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& item = config.items[i];
        const auto observation = observe(config, item);
        const bool available = initialized && worker_error == ESP_OK && config.enabled
                               && config.boardId == board.id && observation.relayReady;
        std::string error = runtime[i].error;
        if (!state_storage_error().empty())
            error = state_storage_error();
        else if (!service_error.empty())
            error = service_error;
        else if (claim_count(configurations, ResourceKind::Input, item.inputId) > 1)
            error =
                "Вход назначен нескольким элементам: автоматика кнопки остановлена до исправления";
        else if (!observation.relayReady)
            error = "Нет свежих данных назначенного реле";
        else if (!observation.inputReady)
            error = "Нет свежих данных назначенного входа";
        else if (observation.relay.value != item.state)
            error = "Ожидается подтверждение сохранённого состояния";
        Json object(cJSON_CreateObject(), cJSON_Delete);
        if (!object || !cJSON_AddStringToObject(object.get(), "id", item.id.c_str())
            || !cJSON_AddStringToObject(object.get(), "name", item.name.c_str())
            || !cJSON_AddStringToObject(object.get(), "relayId", item.relayId.c_str())
            || !cJSON_AddStringToObject(object.get(), "inputId", item.inputId.c_str())
            || !cJSON_AddBoolToObject(object.get(), "state", item.state)
            || !cJSON_AddBoolToObject(object.get(), "available", available)
            || !cJSON_AddStringToObject(object.get(), "error", error.c_str()))
            return nullptr;
        auto* actual = observation.relayReady
                           ? cJSON_AddBoolToObject(object.get(), "actual", observation.relay.value)
                           : cJSON_AddNullToObject(object.get(), "actual");
        auto* input =
            !item.inputId.empty() && observation.inputReady
                ? cJSON_AddBoolToObject(object.get(), "inputLevel", observation.input.value)
                : cJSON_AddNullToObject(object.get(), "inputLevel");
        if (!actual || !input || !cJSON_AddItemToArray(items, object.get()))
            return nullptr;
        object.release();
    }
    auto* relays = cJSON_AddArrayToObject(ports, "relays");
    auto* inputs = cJSON_AddArrayToObject(ports, "inputs");
    auto* sensors = cJSON_AddArrayToObject(ports, "sensors");
    if (!relays || !inputs || !sensors)
        return nullptr;
    const auto add_port = [](cJSON* array, const char* name) {
        Json value(cJSON_CreateString(name), cJSON_Delete);
        if (!value || !cJSON_AddItemToArray(array, value.get()))
            return false;
        value.release();
        return true;
    };
    for (std::size_t i = 0; i < board.relayCount; ++i)
        if (!add_port(relays, board.relays[i].name))
            return nullptr;
    for (std::size_t i = 0; i < board.inputCount; ++i)
        if (!add_port(inputs, board.inputs[i].name))
            return nullptr;
    for (std::size_t i = 0; i < board.sensorPortCount; ++i)
        if (!add_port(sensors, board.sensorPorts[i].name))
            return nullptr;
    const auto* module_error =
        !service_error.empty() ? service_error.c_str()
        : module_input_conflict(config)
            ? "Конфликт назначений входа: исправьте настройки; сохранённые состояния не сброшены"
            : nullptr;
    if (module_error && !cJSON_AddStringToObject(root.get(), "error", module_error))
        return nullptr;
    return root.release();
}

/**
 * @brief Build the active-board port catalog with owners and resource-conflict flags.
 * @return Newly allocated JSON array owned by the caller, or nullptr on allocation failure.
 * @pre The caller holds controller_mutex.
 * @note Disabled rows retain claims; compatible OneWire sharing is represented without an
 * exclusive-port conflict.
 */
cJSON* resources_locked()
{
    Json resources(cJSON_CreateArray(), cJSON_Delete);
    if (!resources)
        return nullptr;
    const auto add_resource = [&](const char* id, ResourceKind kind) {
        const Item* owner = nullptr;
        ControllerKind owner_kind = ControllerKind::Sockets;
        for (std::size_t module = 0; module < kControllerCount && owner == nullptr; ++module)
            for (const auto& item : configurations[module].items) {
                if ((kind == ResourceKind::Relay && item.relayId == id)
                    || (kind == ResourceKind::Input && item.inputId == id)
                    || (kind == ResourceKind::Sensor && item.portId == id)
                    || (kind == ResourceKind::Relay
                        && (item.pumpRelayId == id || item.valveRelayId == id))
                    || (kind == ResourceKind::Input
                        && std::find(item.levelInputs.begin(), item.levelInputs.end(), id)
                               != item.levelInputs.end())) {
                    owner = &item;
                    owner_kind = static_cast<ControllerKind>(module);
                    break;
                }
            }
        Json object(cJSON_CreateObject(), cJSON_Delete);
        if (!object || !cJSON_AddStringToObject(object.get(), "id", id)
            || !cJSON_AddStringToObject(object.get(), "kind", resource_id(kind))
            || !cJSON_AddBoolToObject(object.get(),
                                      "conflict",
                                      kind == ResourceKind::Sensor
                                          ? sensor_conflict(configurations, id)
                                          : claim_count(configurations, kind, id) > 1))
            return false;
        const auto& security = configurations[index(ControllerKind::Security)].security;
        const bool siren = kind == ResourceKind::Relay && security.sirenRelayId == id;
        const bool reader = kind == ResourceKind::Sensor && security.readerPortId == id;
        if (siren || reader) {
            if (!cJSON_AddStringToObject(object.get(), "ownerController", "security")
                || !cJSON_AddStringToObject(object.get(), "ownerId", siren ? "siren" : "reader")
                || !cJSON_AddStringToObject(
                    object.get(), "ownerName", siren ? "Сирена" : "Считыватель iButton"))
                return false;
        } else if (owner) {
            if (!cJSON_AddStringToObject(object.get(), "ownerController", controller_id(owner_kind))
                || !cJSON_AddStringToObject(object.get(), "ownerId", owner->id.c_str())
                || !cJSON_AddStringToObject(object.get(), "ownerName", owner->name.c_str()))
                return false;
        } else if (!cJSON_AddNullToObject(object.get(), "ownerController")
                   || !cJSON_AddNullToObject(object.get(), "ownerId")
                   || !cJSON_AddNullToObject(object.get(), "ownerName"))
            return false;
        if (!cJSON_AddItemToArray(resources.get(), object.get()))
            return false;
        object.release();
        return true;
    };
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.relayCount; ++i)
        if (!add_resource(board.relays[i].name, ResourceKind::Relay))
            return nullptr;
    for (std::size_t i = 0; i < board.inputCount; ++i)
        if (!add_resource(board.inputs[i].name, ResourceKind::Input))
            return nullptr;
    for (std::size_t i = 0; i < board.sensorPortCount; ++i)
        if (!add_resource(board.sensorPorts[i].name, ResourceKind::Sensor))
            return nullptr;
    return resources.release();
}

}  // namespace fcplcn::controllers::detail

/** @endcond */
