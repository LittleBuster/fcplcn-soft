/**
 * @file management_routes.cpp
 * @brief Private MQTT service routes using the same configuration, ownership and persistence APIs.
 */
#include "network/management_routes.h"
#include "network/network.h"
#include "config/backup.h"
#include "config/config.h"
#include "config/settings_json.h"
#include "controllers/socket_controller.h"
#include "hardware/board_profile.h"
#include "hardware/hardware_io.h"
#include "security/auth.h"
#include "system/system_metrics.h"
#include "system/firmware_update.h"
#include "time/rtc_clock.h"
#include "time/time_service.h"
#include "platform/operation_context.h"
#include "product_identity.h"
#include "esp_app_desc.h"
#include "esp_mac.h"
#include "esp_system.h"
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <optional>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

/**
 * @brief Build a diagnostic compatible with local HTTP error bodies.
 * @param[in] status HTTP-compatible failure status.
 * @param[in] message Public failure description.
 * @return Owned route result consumed by the protocol.
 */
ManagementRouteResult failure(int status, const std::string& message)
{
    auto* data = cJSON_CreateObject();
    if (data)
        cJSON_AddStringToObject(data, "error", message.c_str());
    return {status, data, {}};
}

/**
 * @brief Allocate the common successful mutation response body.
 * @return Owned object containing ok=true, or nullptr on allocation failure.
 */
cJSON* success()
{
    auto* data = cJSON_CreateObject();
    if (data)
        cJSON_AddBoolToObject(data, "ok", true);
    return data;
}

/**
 * @brief Read one required or optional bounded JSON string, including an explicitly empty password.
 * @param[in] root Borrowed request body.
 * @param[in] key Case-sensitive field name.
 * @param[out] out Copied text when present and valid.
 * @param[in] maximum Maximum accepted byte length.
 * @param[in] optional Whether omission is accepted.
 * @return True for a bounded string or permitted omission.
 */
bool string_field(const cJSON* root,
                  const char* key,
                  std::string& out,
                  std::size_t maximum,
                  bool optional = false)
{
    const auto* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!value)
        return optional;
    if (!cJSON_IsString(value) || !value->valuestring || std::strlen(value->valuestring) > maximum)
        return false;
    out = value->valuestring;
    return true;
}

/**
 * @brief Select a module only for its exact compiled local service path.
 * @param[in] path Complete relative service path.
 * @param[out] kind Selected controller family.
 * @param[out] suffix Remaining operation suffix.
 * @return True for one of the five supported families.
 */
bool controller_path(std::string_view path, ControllerKind& kind, std::string_view& suffix)
{
    constexpr std::string_view prefix = "/controllers/";
    if (path.substr(0, prefix.size()) != prefix)
        return false;
    auto part = path.substr(prefix.size());
    const auto slash = part.find('/');
    const auto name = part.substr(0, slash);
    suffix = slash == std::string_view::npos ? std::string_view{} : part.substr(slash);
    if (name == "sockets")
        kind = ControllerKind::Sockets;
    else if (name == "lights")
        kind = ControllerKind::Lights;
    else if (name == "meteo")
        kind = ControllerKind::Meteo;
    else if (name == "thermostats")
        kind = ControllerKind::Thermostats;
    else if (name == "irrigation")
        kind = ControllerKind::Irrigation;
    else if (name == "tanks")
        kind = ControllerKind::Tanks;
    else if (name == "security")
        kind = ControllerKind::Security;
    else
        return false;
    return true;
}

/**
 * @brief Preserve the local HTTP mapping for validation, ownership and operational failures.
 * @param[in] result Business-service failure classification.
 * @param[in] message Optional detailed failure description.
 * @return Owned HTTP-compatible diagnostic.
 */
ManagementRouteResult controller_failure(ControllerResult result, const std::string& message)
{
    if (!operation_permitted())
        return failure(409, "Срок запроса истёк или соединение сменилось");
    const auto status =
        result == ControllerResult::InvalidInput                                       ? 400
        : result == ControllerResult::Conflict || result == ControllerResult::Disabled ? 409
        : result == ControllerResult::NotFound                                         ? 404
                                                                                       : 503;
    return failure(status, message.empty() ? "Контроллер не подтвердил операцию" : message);
}

/**
 * @brief Return the fresh selected controller snapshot with the common mutation acknowledgement.
 * @param[in] kind Controller family whose state is read.
 * @return Owned snapshot with ok=true, or an allocation diagnostic.
 */
ManagementRouteResult controller_response(ControllerKind kind)
{
    auto* data = controller_status_json(kind, false);
    if (!data || !cJSON_AddBoolToObject(data, "ok", true)) {
        cJSON_Delete(data);
        return failure(500, "Не удалось прочитать состояния контроллера");
    }
    return {200, data, {}};
}

/**
 * @brief Combine actual hardware, verified FRAM diagnostics, RTC and immutable active-profile pins.
 * @return Owned object for cJSON_Delete(), or nullptr on allocation failure.
 */
cJSON* hardware_snapshot()
{
    Json root(hardware_io_status_json(), cJSON_Delete);
    Json rtc(rtc_clock_status_json(), cJSON_Delete);
    Json pins(board_profile_pin_map_json(board_profile_active()), cJSON_Delete);
    Json storage(controllers_probe_state_storage_json(), cJSON_Delete);
    if (!root || !rtc || !pins || !storage)
        return nullptr;
    if (!cJSON_AddItemToObject(root.get(), "rtc", rtc.get()))
        return nullptr;
    rtc.release();
    if (!cJSON_AddItemToObject(root.get(), "pinMap", pins.get()))
        return nullptr;
    pins.release();
    if (!cJSON_AddItemToObject(root.get(), "stateStorage", storage.get()))
        return nullptr;
    storage.release();
    return root.release();
}

/**
 * @brief Build the same public identity/network/time/diagnostic shape as local /status.
 * @return Owned public object for cJSON_Delete(), or nullptr on allocation failure.
 */
cJSON* status_snapshot()
{
    Json root(network_status_json(), cJSON_Delete);
    if (!root)
        return nullptr;
    auto* product = cJSON_AddObjectToObject(root.get(), "product");
    cJSON_AddStringToObject(product, "name", FCPLCN_PRODUCT_NAME);
    cJSON_AddStringToObject(product, "fullName", FCPLCN_PRODUCT_FULL_NAME);
    auto* device = cJSON_AddObjectToObject(root.get(), "device");
    const auto config = config_get();
    cJSON_AddStringToObject(device, "id", device_id().c_str());
    cJSON_AddStringToObject(device, "name", config.device.name.c_str());
    std::uint8_t mac[6]{};
    char formatted[18]{};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        std::snprintf(formatted,
                      sizeof(formatted),
                      "%02X:%02X:%02X:%02X:%02X:%02X",
                      mac[0],
                      mac[1],
                      mac[2],
                      mac[3],
                      mac[4],
                      mac[5]);
        cJSON_AddStringToObject(device, "mac", formatted);
    }
    cJSON_AddStringToObject(root.get(), "firmwareVersion", esp_app_get_description()->version);
    cJSON_AddNumberToObject(
        root.get(), "uptimeSec", static_cast<double>(esp_timer_get_time() / 1'000'000));
    cJSON_AddNumberToObject(root.get(), "freeHeap", esp_get_free_heap_size());
    cJSON_AddItemToObject(root.get(), "system", system_metrics_json());
    cJSON_AddItemToObject(root.get(), "stateStorage", controllers_state_storage_json());
    auto* hardware = board_profile_status_json();
    cJSON_AddStringToObject(hardware, "configuredBoardId", config.hardware.boardId.c_str());
    cJSON_AddBoolToObject(
        hardware, "rebootRequired", config.hardware.boardId != board_profile_active().id);
    cJSON_AddItemToObject(root.get(), "hardware", hardware);
    cJSON_AddItemToObject(root.get(), "time", time_service_status_json());
    cJSON_AddNumberToObject(root.get(), "revision", config.revision);
    return root.release();
}

/**
 * @brief Validate selected controller mutations and preserve all autonomous service invariants.
 * @param[in] request Validated request with borrowed body.
 * @param[in] kind Selected controller family.
 * @param[in] suffix Exact operation suffix.
 * @return Owned HTTP-compatible business result.
 */
ManagementRouteResult
controller_route(const ManagementRequest& request, ControllerKind kind, std::string_view suffix)
{
    if (request.method == "GET")
        return suffix.empty() ? ManagementRouteResult{200, controller_status_json(kind), {}}
                              : failure(404, "Неизвестный путь");
    const auto* body = request.body;
    std::string message, id;
    auto result = ControllerResult::InvalidInput;
    const auto* value = cJSON_GetObjectItemCaseSensitive(body, "value");
    if (suffix.empty()) {
        result = controller_update(kind, body, message);
    } else if ((suffix == "/state"
                && (kind == ControllerKind::Sockets || kind == ControllerKind::Lights))
               || (suffix == "/enabled"
                   && (kind == ControllerKind::Thermostats || kind == ControllerKind::Tanks
                       || kind == ControllerKind::Irrigation))) {
        if (!settings_json_fields(body, {"id", "value"})
            || !string_field(body, "id", id, kSocketMaxIdBytes) || !cJSON_IsBool(value))
            return failure(400, "Укажите ID элемента и состояние true/false");
        result = kind == ControllerKind::Irrigation
                     ? controller_irrigation_set_enabled_until(
                           id, cJSON_IsTrue(value), request.expiresAtUptimeMs, message)
                 : kind == ControllerKind::Tanks
                     ? controller_tank_set_enabled_until(
                           id, cJSON_IsTrue(value), request.expiresAtUptimeMs, message)
                 : kind == ControllerKind::Thermostats
                     ? controller_thermostat_set_enabled_until(
                           id, cJSON_IsTrue(value), request.expiresAtUptimeMs, message)
                     : controller_set_state_until(
                           kind, id, cJSON_IsTrue(value), request.expiresAtUptimeMs, message);
    } else if (suffix == "/armed" && kind == ControllerKind::Security) {
        if (!settings_json_fields(body, {"value"}) || !cJSON_IsBool(value))
            return failure(400, "Укажите режим охраны true/false");
        result = controller_security_set_armed_until(
            cJSON_IsTrue(value), request.expiresAtUptimeMs, message);
    } else if (suffix == "/scan"
               && (kind == ControllerKind::Meteo || kind == ControllerKind::Security)) {
        std::string port, item;
        const auto* refresh = cJSON_GetObjectItemCaseSensitive(body, "refresh");
        const auto* revision = cJSON_GetObjectItemCaseSensitive(body, "baseRevision");
        if (!string_field(body, "portId", port, 32)
            || !string_field(body, "itemId", item, kSocketMaxIdBytes, true)
            || (refresh && !cJSON_IsBool(refresh))
            || (revision
                && (!cJSON_IsNumber(revision) || !std::isfinite(revision->valuedouble)
                    || revision->valuedouble < 1 || revision->valuedouble > UINT32_MAX
                    || std::floor(revision->valuedouble) != revision->valuedouble)))
            return failure(400, "Укажите sensor-порт и корректные параметры поиска");
        if (kind == ControllerKind::Security
            && (!settings_json_fields(body, {"portId", "refresh"}) || !cJSON_IsBool(refresh)))
            return failure(400, "Выберите порт считывателя и режим поиска");
        cJSON* response = nullptr;
        result = kind == ControllerKind::Security
                     ? controller_security_scan(port, cJSON_IsTrue(refresh), response, message)
                     : controller_meteo_scan(
                           port,
                           cJSON_IsTrue(refresh),
                           response,
                           message,
                           item,
                           revision ? static_cast<std::uint32_t>(revision->valuedouble) : 0);
        if (result == ControllerResult::Ok)
            return {200, response, {}};
        cJSON_Delete(response);
    } else
        return failure(404, "Неизвестный путь контроллера");
    return result == ControllerResult::Ok ? controller_response(kind)
                                          : controller_failure(result, message);
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Dispatch only compiled local-service operations without accepting login or arbitrary
 * paths.
 * @param[in] request Validated request within its active cancellation context.
 * @param[in] hooks Idle reboot-worker reservation before accepting restore or restart.
 * @return Owned private result with deferred work after its reply send attempt.
 * @endcond
 */
ManagementRouteResult management_dispatch(const ManagementRequest& request,
                                          const ManagementRouteHooks& hooks)
{
    if (!operation_permitted())
        return failure(409, "Срок запроса истёк или соединение сменилось");
    if (request.path == "/firmware" || request.path.substr(0, 10) == "/firmware/") {
        auto result = firmware_update_request(
            request.method, request.path, request.body, hooks.reserveReboot);
        return {result.status, result.data, {false, false, result.reboot}};
    }
    if (request.method == "POST" && request.path != "/reboot" && firmware_update_busy())
        return failure(
            409, "Выполняется обновление прошивки; дождитесь завершения или отмените загрузку");
    ControllerKind kind;
    std::string_view suffix;
    if (controller_path(request.path, kind, suffix))
        return controller_route(request, kind, suffix);
    if (request.method == "GET") {
        if (request.path == "/config") {
            auto* config = config_public_json();
            auto* user = cJSON_AddObjectToObject(config, "user");
            cJSON_AddStringToObject(user, "username", auth_get_username().c_str());
            return {200, config, {}};
        }
        if (request.path == "/status")
            return {200, status_snapshot(), {}};
        if (request.path == "/board-profiles")
            return {200, board_profiles_json(), {}};
        if (request.path == "/hardware")
            return {200, hardware_snapshot(), {}};
        if (request.path == "/controllers")
            return {200, controllers_status_json(), {}};
        if (request.path == "/config/backup") {
            std::string error;
            auto* data = backup_export_json(error);
            return data ? ManagementRouteResult{200, data, {}} : failure(503, error);
        }
        return failure(404, "Неизвестный путь управления");
    }
    if (request.method != "POST")
        return failure(405, "Метод не поддерживается");
    const auto* body = request.body;
    if (request.path == "/config") {
        std::string error;
        bool network = false;
        const auto result = config_update(body, error, network);
        if (result != ESP_OK)
            return failure(!operation_permitted() || result == ESP_ERR_INVALID_STATE ? 409
                           : result == ESP_ERR_INVALID_ARG                           ? 400
                                                                                     : 500,
                           error);
        auto* response = success();
        const auto config = config_get();
        cJSON_AddNumberToObject(response, "revision", config.revision);
        cJSON_AddBoolToObject(response, "networkRestart", network);
        cJSON_AddBoolToObject(
            response, "rebootRequired", config.hardware.boardId != board_profile_active().id);
        return {200, response, {network, true, false}};
    }
    if (request.path == "/hardware/relay") {
        std::string id, error;
        const auto* value = cJSON_GetObjectItemCaseSensitive(body, "value");
        if (!settings_json_fields(body, {"id", "value"}) || !string_field(body, "id", id, 64)
            || !cJSON_IsBool(value))
            return failure(400, "Укажите имя реле и состояние true/false");
        const auto result = controllers_set_relay(id, cJSON_IsTrue(value), error);
        if (result != ControllerResult::Ok)
            return controller_failure(result, error);
        auto* response = success();
        cJSON_AddItemToObject(response, "hardware", hardware_snapshot());
        return {200, response, {}};
    }
    if (request.path == "/hardware/scan") {
        hardware_io_request_scan();
        auto* response = success();
        cJSON_AddBoolToObject(response, "queued", true);
        return {200, response, {}};
    }
    if (request.path == "/user") {
        std::string username, current, password;
        if (!settings_json_fields(body, {"username", "currentPassword"}, {"newPassword"})
            || !string_field(body, "username", username, 64)
            || !string_field(body, "currentPassword", current, 128)
            || !string_field(body, "newPassword", password, 128, true))
            return failure(400, "Некорректные данные пользователя");
        const auto result = auth_change_user(current,
                                             username,
                                             cJSON_HasObjectItem(body, "newPassword")
                                                 ? std::optional<std::string>(password)
                                                 : std::nullopt);
        if (result != AuthResult::Ok)
            return failure(!operation_permitted()                     ? 409
                           : result == AuthResult::InvalidCredentials ? 403
                           : result == AuthResult::InvalidInput       ? 400
                           : result == AuthResult::RateLimited        ? 429
                                                                      : 500,
                           "Не удалось проверить пароль или сохранить учётную запись");
        auto* response = success();
        cJSON_AddBoolToObject(response, "reauthenticate", true);
        return {200, response, {}};
    }
    if (request.path == "/time") {
        const auto* unixTime = cJSON_GetObjectItemCaseSensitive(body, "unixTime");
        std::string timezone;
        if (!cJSON_IsNumber(unixTime) || !std::isfinite(unixTime->valuedouble)
            || unixTime->valuedouble < 1704067200 || unixTime->valuedouble > 4102444799.0
            || !string_field(body, "timezone", timezone, 96, true))
            return failure(400, "Время должно быть в диапазоне 2024–2099");
        if (cJSON_HasObjectItem(body, "timezone") && timezone != config_get().time.timezone)
            return failure(409,
                           "Часовой пояс изменился. Обновите настройки перед установкой времени");
        if (time_service_set_unix(static_cast<std::int64_t>(unixTime->valuedouble)) != ESP_OK)
            return failure(operation_permitted() ? 500 : 409, "Не удалось установить время");
        auto* response = success();
        cJSON_AddNumberToObject(response, "revision", config_get().revision);
        return {200, response, {}};
    }
    if (request.path == "/reboot" || request.path == "/config/restore") {
        if (!firmware_update_prepare_restart())
            return failure(409, "Во время загрузки прошивки перезагрузка и импорт недоступны");
        if (!hooks.reserveReboot || !hooks.reserveReboot()) {
            firmware_update_cancel_restart();
            return failure(503, "Не удалось подготовить перезагрузку");
        }
        if (request.path == "/config/restore") {
            std::string error;
            const auto result = backup_stage_restore(body, error);
            if (result != BackupResult::Ok) {
                firmware_update_cancel_restart();
                return failure(!operation_permitted()                 ? 409
                               : result == BackupResult::InvalidInput ? 400
                               : result == BackupResult::Conflict     ? 409
                                                                      : 503,
                               error);
            }
        }
        auto* response = success();
        if (request.path == "/config/restore")
            cJSON_AddBoolToObject(response, "rebootRequired", true);
        return {200, response, {false, false, true}};
    }
    return failure(404, "Неизвестный путь управления");
}
