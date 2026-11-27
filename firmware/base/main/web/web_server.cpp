/**
 * @file web_server.cpp
 * @brief Authenticated local HTTP routes and embedded interface delivery.
 * @details Mutations require a RAM session and matching browser Origin/Host. JSON bodies have
 * size, nesting and total receive budgets, in addition to SDK per-socket timeouts.
 * Restore reserves an idle reboot worker before its atomic commit so a successful
 * import cannot become frozen without a scheduled reboot.
 */
#include "web/web_server.h"
#include "web/static_cache.h"
#include "security/auth.h"
#include "config/backup.h"
#include "hardware/board_profile.h"
#include "config/config.h"
#include "hardware/hardware_io.h"
#include "network/network.h"
#include "product_identity.h"
#include "time/rtc_clock.h"
#include "controllers/socket_controller.h"
#include "config/settings_store.h"
#include "config/settings_json.h"
#include "system/system_metrics.h"
#include "system/firmware_update.h"
#include "platform/runtime_supervisor.h"
#include "time/time_service.h"
#include "web_assets.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cctype>
#include <cstring>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>
#include "esp_app_desc.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
constexpr std::size_t kMaxBody = 8192;
constexpr std::int64_t kBodyReceiveBudgetUs = 10'000'000;
httpd_handle_t server = nullptr;
std::atomic<bool> reboot_pending{false};
TaskHandle_t restart_task = nullptr;

/**
 * @brief Apply browser-isolation headers shared by local API and static responses.
 * @param[in] req Borrowed ESP-IDF request whose response headers are updated.
 */
void common_headers(httpd_req_t* req)
{
    httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(req, "X-Frame-Options", "DENY");
    httpd_resp_set_hdr(
        req,
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

/**
 * @brief Serialize an owned JSON value, send the response and release its memory.
 * @param[in] req Borrowed ESP-IDF request.
 * @param[in] value Transferred JSON ownership, including nullptr on allocation failure.
 * @param[in] status Borrowed HTTP status text; defaults to 200 OK.
 * @return SDK send result; a missing/unserializable value produces a 500 JSON error response.
 */
esp_err_t send_json(httpd_req_t* req, cJSON* value, const char* status = "200 OK")
{
    Json json(value, cJSON_Delete);
    common_headers(req);
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_type(req, "application/json; charset=utf-8");
    httpd_resp_set_status(req, status);
    char* text = json ? cJSON_PrintUnformatted(json.get()) : nullptr;
    if (text == nullptr) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_sendstr(req, "{\"error\":\"Недостаточно памяти\"}");
    }
    const esp_err_t result = httpd_resp_sendstr(req, text);
    cJSON_free(text);
    return result;
}

/**
 * @brief Send a JSON error message using the supplied HTTP status.
 * @param[in] req Borrowed ESP-IDF request.
 * @param[in] status Borrowed HTTP status text.
 * @param[in] message Borrowed user-visible error text copied into the JSON response.
 * @return SDK response-send result, with allocation handling delegated to send_json.
 */
esp_err_t error(httpd_req_t* req, const char* status, const char* message)
{
    cJSON* value = cJSON_CreateObject();
    cJSON_AddStringToObject(value, "error", message);
    return send_json(req, value, status);
}

/**
 * @brief Allocate the common successful mutation response body.
 * @return Owned JSON object with ok=true, or nullptr on allocation failure; pass ownership to
 * send_json.
 */
cJSON* ok()
{
    cJSON* value = cJSON_CreateObject();
    cJSON_AddBoolToObject(value, "ok", true);
    return value;
}

/**
 * @brief Read one HTTP header within a caller-supplied byte limit.
 * @param[in] req Borrowed ESP-IDF request.
 * @param[in] name Case-insensitive HTTP header name passed to the SDK.
 * @param[in] limit Maximum accepted header length excluding the terminator.
 * @return Owned header text, or an empty string when missing, oversized or unreadable.
 */
std::string header(httpd_req_t* req, const char* name, std::size_t limit = 256)
{
    const auto length = httpd_req_get_hdr_value_len(req, name);
    if (length == 0 || length > limit)
        return {};
    std::vector<char> buffer(length + 1);
    if (httpd_req_get_hdr_value_str(req, name, buffer.data(), buffer.size()) != ESP_OK)
        return {};
    return buffer.data();
}

/**
 * @brief Normalize a copied string using the current character-lowercase conversion.
 * @param[in] s Owned input copy; bytes are promoted as unsigned char before std::tolower.
 * @return Lowercased copy used for case-insensitive HTTP comparisons.
 */
std::string lower(std::string s)
{
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
        return std::tolower(c);
    });
    return s;
}

/**
 * @brief Normalize a Host/Origin authority for an exact same-origin comparison.
 * @param[in] host Owned host/authority text, including an optional port.
 * @param[in] tls True for HTTPS; chooses 443 rather than 80 as the removable default port.
 * @return Lowercase authority with only the scheme-default port suffix removed.
 */
std::string normalize_host(std::string host, bool tls)
{
    host = lower(std::move(host));
    const std::string port = tls ? ":443" : ":80";
    if (host.size() > port.size()
        && host.compare(host.size() - port.size(), port.size(), port) == 0)
        host.resize(host.size() - port.size());
    return host;
}

/**
 * @brief Validate a browser Origin against the request Host and its scheme-default port.
 * @param[in] req Borrowed request whose Origin and Host headers are inspected.
 * @return True for a matching authority or absent Origin; false for malformed or mismatching
 * headers.
 * @note Nonbrowser clients may omit Origin but still require authentication through require().
 */
bool same_origin(httpd_req_t* req)
{
    const auto length = httpd_req_get_hdr_value_len(req, "Origin");
    if (length == 0)
        return true;  // Non-browser clients still need the session cookie.
    const std::string origin = header(req, "Origin");
    const std::string host = header(req, "Host", 128);
    if (origin.empty() || host.empty())
        return false;
    const bool tls = origin.rfind("https://", 0) == 0;
    const std::size_t prefix = tls ? 8 : 7;
    if (!tls && origin.rfind("http://", 0) != 0)
        return false;
    const std::string authority = origin.substr(prefix);
    if (authority.find_first_of("/\\@?# \t\r\n") != std::string::npos)
        return false;
    return normalize_host(authority, tls) == normalize_host(host, tls);
}

/**
 * @brief Guard API access with authentication, POST origin checks and the restore freeze.
 * @param[in] req Borrowed HTTP request; rejected requests receive an error response here.
 * @param[in] session Whether a valid session is required; login passes false.
 * @return True when the handler may continue; false after sending a 401, 403 or 409 response.
 * @note During a staged restore only POST /api/v1/reboot may pass the mutation freeze.
 */
bool require(httpd_req_t* req, bool session = true)
{
    if (session && !auth_check_request(req)) {
        error(req, "401 Unauthorized", "Необходим вход");
        return false;
    }
    if (req->method == HTTP_POST && !same_origin(req)) {
        error(req, "403 Forbidden", "Запрос с другого сайта запрещён");
        return false;
    }
    if (req->method == HTTP_POST && settings_restore_pending()
        && std::strcmp(req->uri, "/api/v1/reboot") != 0) {
        error(req, "409 Conflict", "Импорт сохранён: ожидается перезагрузка устройства");
        return false;
    }
    if (req->method == HTTP_POST && std::strncmp(req->uri, "/api/v1/firmware/", 17) != 0
        && std::strcmp(req->uri, "/api/v1/reboot") != 0
        && std::strcmp(req->uri, "/api/v1/login") != 0
        && std::strcmp(req->uri, "/api/v1/logout") != 0 && firmware_update_busy()) {
        error(req,
              "409 Conflict",
              "Выполняется обновление прошивки; дождитесь завершения или отмените загрузку");
        return false;
    }
    return true;
}

/**
 * @brief Receive one bounded JSON body without allowing an endless slow drip.
 * @param[in] req Borrowed request owned by ESP-IDF's HTTP task.
 * @param[in] maximum Maximum accepted body byte count before allocation.
 * @return Owned JSON object, or an empty owner after sending an error response.
 * @details The absolute ten-second budget is checked around every receive. An already
 * running receive is additionally bounded by the configured five-second SDK timeout.
 * Raw text is checked for decoded NUL and nesting before cJSON owns the parse tree.
 */
Json read_json(httpd_req_t* req, std::size_t maximum = kMaxBody)
{
    if (req->content_len == 0 || req->content_len > maximum) {
        error(req,
              req->content_len > maximum ? "413 Content Too Large" : "400 Bad Request",
              "Неверный размер запроса");
        return Json(nullptr, cJSON_Delete);
    }
    const std::string type = lower(header(req, "Content-Type", 128));
    if (type.rfind("application/json", 0) != 0) {
        error(req, "415 Unsupported Media Type", "Ожидается application/json");
        return Json(nullptr, cJSON_Delete);
    }
    std::vector<char> data(req->content_len + 1, 0);
    std::size_t read = 0;
    const auto deadline = esp_timer_get_time() + kBodyReceiveBudgetUs;
    while (read < req->content_len) {
        if (esp_timer_get_time() >= deadline) {
            error(req, "408 Request Timeout", "Истекло время получения запроса");
            return Json(nullptr, cJSON_Delete);
        }
        const int count = httpd_req_recv(req, data.data() + read, req->content_len - read);
        if (count <= 0) {
            error(req, "408 Request Timeout", "Не удалось получить запрос");
            return Json(nullptr, cJSON_Delete);
        }
        if (esp_timer_get_time() >= deadline) {
            error(req, "408 Request Timeout", "Истекло время получения запроса");
            return Json(nullptr, cJSON_Delete);
        }
        read += count;
    }
    if (!supported_json_text(std::string_view(data.data(), req->content_len))) {
        error(
            req, "400 Bad Request", "JSON содержит нулевой символ или слишком большую вложенность");
        return Json(nullptr, cJSON_Delete);
    }
    Json value(cJSON_ParseWithLengthOpts(data.data(), data.size(), nullptr, true), cJSON_Delete);
    if (!value || !cJSON_IsObject(value.get())) {
        error(req, "400 Bad Request", "Некорректный JSON");
        return Json(nullptr, cJSON_Delete);
    }
    return value;
}

/**
 * @brief Extract a bounded JSON string while supporting explicitly optional fields.
 * @param[in] json Borrowed parsed request object already checked for unsupported NUL text.
 * @param[in] key Case-sensitive property name.
 * @param[out] value Copied string on success when the property exists; otherwise unchanged.
 * @param[in] limit Maximum UTF-8 byte length accepted for a present value.
 * @param[in] optional Whether a missing property is accepted without changing value.
 * @return True for a valid bounded string, or an absent optional field; false for invalid values.
 */
bool get_string(const cJSON* json,
                const char* key,
                std::string& value,
                std::size_t limit,
                bool optional = false)
{
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (!item)
        return optional;
    if (!cJSON_IsString(item) || !item->valuestring || std::strlen(item->valuestring) > limit)
        return false;
    value = item->valuestring;
    return true;
}

/**
 * @brief Map a failed authentication result to a consistent HTTP JSON error.
 * @param[in] req Borrowed request receiving the failure response.
 * @param[in] result Authentication failure classification; rate limiting adds Retry-After: 5.
 * @return SDK send result for 429 rate limiting, 403 credential rejection or 500 internal failure.
 * @note Unsupported result values fall back to 500.
 */
esp_err_t auth_result(httpd_req_t* req, AuthResult result)
{
    if (result == AuthResult::RateLimited) {
        httpd_resp_set_hdr(req, "Retry-After", "5");
        return error(req, "429 Too Many Requests", "Слишком много попыток. Повторите позже");
    }
    if (result == AuthResult::InvalidCredentials)
        return error(req, "403 Forbidden", "Неверный логин или пароль");
    if (result == AuthResult::InvalidInput)
        return error(req, "400 Bad Request", "Некорректный логин или пароль");
    return error(
        req, "500 Internal Server Error", "Не удалось сохранить или проверить учётную запись");
}

/**
 * @brief Validate login credentials, issue a session cookie and return the account name.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Accepts bounded username/password fields; applies Origin checks without requiring an
 * existing session.
 */
esp_err_t login(httpd_req_t* req)
{
    if (!require(req, false))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string username, password;
    if (!get_string(body.get(), "username", username, 64)
        || !get_string(body.get(), "password", password, 128))
        return error(req, "400 Bad Request", "Укажите логин и пароль");
    AuthCookie cookie;
    const auto result = auth_login(req, username, password, cookie);
    if (result != AuthResult::Ok)
        return auth_result(req, result);
    auto* response = ok();
    cJSON_AddStringToObject(response, "username", auth_get_username().c_str());
    return send_json(req, response);
}

/**
 * @brief Revoke the current web session and expire its browser cookie.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Requires authentication and the common mutation guards.
 */
esp_err_t logout(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    AuthCookie cookie;
    auth_logout(req, cookie);
    return send_json(req, ok());
}

/**
 * @brief Return redacted saved settings together with the public web account name.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Passwords and verifier material are not part of this ordinary configuration response.
 */
esp_err_t get_config(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto* json = config_public_json();
    auto* user = cJSON_AddObjectToObject(json, "user");
    cJSON_AddStringToObject(user, "username", auth_get_username().c_str());
    return send_json(req, json);
}

/**
 * @brief Return the compiled registry of supported hardware profiles.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note The request is read-only and requires a valid web session.
 */
esp_err_t get_board_profiles(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    return send_json(req, board_profiles_json());
}

/**
 * @brief Combine hardware readback, live FRAM/RTC status and active-profile pin metadata.
 * @return Owned JSON snapshot, or nullptr if any allocation/attachment fails; delete with
 * cJSON_Delete.
 */
cJSON* hardware_snapshot()
{
    Json snapshot(hardware_io_status_json(), cJSON_Delete);
    Json rtc(rtc_clock_status_json(), cJSON_Delete);
    Json pins(board_profile_pin_map_json(board_profile_active()), cJSON_Delete);
    Json storage(controllers_probe_state_storage_json(), cJSON_Delete);
    if (!snapshot || !rtc || !pins || !storage)
        return nullptr;
    if (!cJSON_AddItemToObject(snapshot.get(), "rtc", rtc.get()))
        return nullptr;
    rtc.release();
    if (!cJSON_AddItemToObject(snapshot.get(), "pinMap", pins.get()))
        return nullptr;
    pins.release();
    if (!cJSON_AddItemToObject(snapshot.get(), "stateStorage", storage.get()))
        return nullptr;
    storage.release();
    return snapshot.release();
}

/**
 * @brief Return hardware readback, RTC status and the active profile pin map.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Readback validity is preserved by hardware_snapshot; unknown levels remain unknown.
 */
esp_err_t get_hardware(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    return send_json(req, hardware_snapshot());
}

/**
 * @brief Map a local controller failure to the corresponding HTTP error response.
 * @param[in] req Borrowed request receiving the response.
 * @param[in] result Validation, conflict, disabled, missing-item or operational failure category.
 * @param[in] message User-visible detail; empty text uses a common unconfirmed-operation message.
 * @return SDK send result for the selected 400, 409, 404 or 503 status.
 */
esp_err_t socket_error(httpd_req_t* req, SocketResult result, const std::string& message)
{
    const char* status = result == SocketResult::InvalidInput ? "400 Bad Request"
                         : result == SocketResult::Conflict || result == SocketResult::Disabled
                             ? "409 Conflict"
                         : result == SocketResult::NotFound ? "404 Not Found"
                                                            : "503 Service Unavailable";
    return error(
        req, status, message.empty() ? "Контроллер не подтвердил операцию" : message.c_str());
}

/**
 * @brief Resolve the controller kind from a registered controller-route URI.
 * @param[in] req Borrowed request for a known controller endpoint.
 * @return Thermostats, Meteo or Lights for their prefixes; Sockets for the remaining registered
 * routes.
 */
ControllerKind request_controller(httpd_req_t* req)
{
    if (std::strncmp(req->uri,
                     "/api/v1/controllers/irrigation",
                     sizeof("/api/v1/controllers/irrigation") - 1)
        == 0)
        return ControllerKind::Irrigation;
    if (std::strncmp(req->uri, "/api/v1/controllers/tanks", 25) == 0)
        return ControllerKind::Tanks;
    if (std::strncmp(req->uri, "/api/v1/controllers/security", 28) == 0)
        return ControllerKind::Security;
    if (std::strncmp(req->uri, "/api/v1/controllers/thermostats", 31) == 0)
        return ControllerKind::Thermostats;
    if (std::strncmp(req->uri, "/api/v1/controllers/meteo", 25) == 0)
        return ControllerKind::Meteo;
    return std::strncmp(req->uri, "/api/v1/controllers/lights", 26) == 0 ? ControllerKind::Lights
                                                                         : ControllerKind::Sockets;
}

/**
 * @brief Send a fresh snapshot with ok=true after a controller mutation.
 * @param[in] req Borrowed request receiving the response.
 * @param[in] kind Module whose current state is returned.
 * @return SDK send result, including a 500 response if the snapshot cannot be allocated.
 */
esp_err_t controller_response(httpd_req_t* req, ControllerKind kind)
{
    Json response(controller_status_json(kind, false), cJSON_Delete);
    if (!response || !cJSON_AddBoolToObject(response.get(), "ok", true))
        return error(
            req, "500 Internal Server Error", "Не удалось прочитать состояния контроллера");
    return send_json(req, response.release());
}

/**
 * @brief Return the overview and enabled states of all local controller modules.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Requires authentication; reads the local controller service without depending on the hub.
 */
esp_err_t get_controllers(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    return send_json(req, controllers_status_json());
}

/**
 * @brief Return the selected controller module and its current item states.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note The module is determined by the registered request URI.
 */
esp_err_t get_controller(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    return send_json(req, controller_status_json(request_controller(req)));
}

/**
 * @brief Validate and save the selected controller module configuration.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Delegates revision, resource ownership and autonomous output transitions to
 * controller_update.
 */
esp_err_t configure_controller(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string message;
    const auto kind = request_controller(req);
    const auto result = controller_update(kind, body.get(), message);
    if (result != SocketResult::Ok)
        return socket_error(req, result, message);
    return controller_response(req, kind);
}

/**
 * @brief Apply an explicit desired state to a socket or light through its controller.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Requires an element ID and boolean value; persistence and output confirmation belong to the
 * controller.
 */
esp_err_t set_controller_state(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string id;
    const auto* desired = cJSON_GetObjectItemCaseSensitive(body.get(), "value");
    if (!get_string(body.get(), "id", id, kSocketMaxIdBytes) || !cJSON_IsBool(desired))
        return error(req, "400 Bad Request", "Укажите ID элемента и состояние true/false");
    std::string message;
    const auto kind = request_controller(req);
    const auto result = controller_set_state(kind, id, cJSON_IsTrue(desired), message);
    if (result != SocketResult::Ok)
        return socket_error(req, result, message);
    return controller_response(req, kind);
}

/**
 * @brief Change and persist the individual permission for autonomous controller operation.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Changes the enabled flag without directly commanding a physical relay.
 */
esp_err_t set_item_enabled(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string id;
    const auto* desired = cJSON_GetObjectItemCaseSensitive(body.get(), "value");
    if (!get_string(body.get(), "id", id, kSocketMaxIdBytes) || !cJSON_IsBool(desired))
        return error(req, "400 Bad Request", "Укажите ID элемента и режим true/false");
    std::string message;
    const auto kind = request_controller(req);
    const auto result = kind == ControllerKind::Irrigation
                            ? controller_irrigation_set_enabled(id, cJSON_IsTrue(desired), message)
                        : kind == ControllerKind::Tanks
                            ? controller_tank_set_enabled(id, cJSON_IsTrue(desired), message)
                            : controller_thermostat_set_enabled(id, cJSON_IsTrue(desired), message);
    if (result != ControllerResult::Ok)
        return socket_error(req, result, message);
    return controller_response(req, kind);
}

/**
 * @brief Explicitly arm or disarm the local security controller after session/origin validation.
 * @param[in] req Borrowed HTTP request containing only the desired armed value.
 * @return SDK response result; operational failures use the common controller error mapping.
 */
esp_err_t set_security_armed(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    const auto* value = cJSON_GetObjectItemCaseSensitive(body.get(), "value");
    if (!settings_json_fields(body.get(), {"value"}) || !cJSON_IsBool(value))
        return error(req, "400 Bad Request", "Укажите режим охраны true/false");
    std::string message;
    const auto result = controller_security_set_armed(cJSON_IsTrue(value), message);
    if (result != ControllerResult::Ok)
        return socket_error(req, result, message);
    return controller_response(req, ControllerKind::Security);
}

/**
 * @brief Queue or poll authenticated, bounded discovery of a selected iButton reader port.
 * @param[in] req Borrowed request containing portId and a boolean refresh flag.
 * @return SDK response result; armed/claimed-port conflicts are returned before bus work.
 */
esp_err_t scan_security_keys(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string port;
    const auto* refresh = cJSON_GetObjectItemCaseSensitive(body.get(), "refresh");
    if (!settings_json_fields(body.get(), {"portId", "refresh"})
        || !get_string(body.get(), "portId", port, 32) || !cJSON_IsBool(refresh))
        return error(req, "400 Bad Request", "Выберите порт считывателя и режим поиска");
    cJSON* snapshot = nullptr;
    std::string message;
    const auto result = controller_security_scan(port, cJSON_IsTrue(refresh), snapshot, message);
    if (result != ControllerResult::Ok) {
        cJSON_Delete(snapshot);
        return socket_error(req, result, message);
    }
    return send_json(req, snapshot);
}

/**
 * @brief Validate OneWire scan parameters and request a bounded local bus scan.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Accepts optional item ID/revision and refresh; returns the controller scan response without
 * polling the bus in HTTP.
 */
esp_err_t scan_meteo(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string port, item_id;
    const auto* refresh = cJSON_GetObjectItemCaseSensitive(body.get(), "refresh");
    const auto* revision = cJSON_GetObjectItemCaseSensitive(body.get(), "baseRevision");
    if (!get_string(body.get(), "portId", port, 32)
        || !get_string(body.get(), "itemId", item_id, kSocketMaxIdBytes, true)
        || (refresh && !cJSON_IsBool(refresh))
        || (revision
            && (!cJSON_IsNumber(revision) || !std::isfinite(revision->valuedouble)
                || revision->valuedouble < 1 || revision->valuedouble > UINT32_MAX
                || std::floor(revision->valuedouble) != revision->valuedouble)))
        return error(req, "400 Bad Request", "Укажите sensor-порт и корректные параметры поиска");
    std::string message;
    cJSON* response = nullptr;
    const auto result =
        controller_meteo_scan(port,
                              cJSON_IsTrue(refresh),
                              response,
                              message,
                              item_id,
                              revision ? static_cast<std::uint32_t>(revision->valuedouble) : 0);
    if (result != ControllerResult::Ok)
        return socket_error(req, result, message);
    return send_json(req, response);
}

/**
 * @brief Request a manual relay state through the controller ownership guard.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note A successful response includes a fresh hardware snapshot; owned thermostat relays cannot be
 * overridden.
 */
esp_err_t set_relay(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string id;
    const auto* desired = cJSON_GetObjectItemCaseSensitive(body.get(), "value");
    if (!get_string(body.get(), "id", id, 64) || !cJSON_IsBool(desired))
        return error(req, "400 Bad Request", "Укажите имя реле и состояние true/false");
    std::string message;
    const auto result = controllers_set_relay(id, cJSON_IsTrue(desired), message);
    if (result != SocketResult::Ok)
        return socket_error(req, result, message);
    Json snapshot(hardware_snapshot(), cJSON_Delete);
    if (!snapshot)
        return error(req, "500 Internal Server Error", "Не удалось прочитать аппаратные состояния");
    auto* response = ok();
    cJSON_AddItemToObject(response, "hardware", snapshot.release());
    return send_json(req, response);
}

/**
 * @brief Queue an asynchronous scan of both profile-defined I2C buses.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Returns queued=true; actual bus work is performed outside the HTTP task.
 */
esp_err_t scan_hardware(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    hardware_io_request_scan();
    auto* response = ok();
    cJSON_AddBoolToObject(response, "queued", true);
    return send_json(req, response);
}

/**
 * @brief Save validated settings and schedule affected network/time services to apply them.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Reports the new revision and pending profile reboot; scheduling occurs after sending the
 * response.
 */
esp_err_t set_config(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string message;
    bool network = false;
    const esp_err_t result = config_update(body.get(), message, network);
    if (result != ESP_OK)
        return error(
            req,
            result == ESP_ERR_INVALID_STATE
                ? "409 Conflict"
                : (result == ESP_ERR_INVALID_ARG ? "400 Bad Request" : "500 Internal Server Error"),
            message.c_str());
    cJSON* response = ok();
    cJSON_AddNumberToObject(response, "revision", config_get().revision);
    cJSON_AddBoolToObject(response, "networkRestart", network);
    cJSON_AddBoolToObject(
        response, "rebootRequired", config_get().hardware.boardId != board_profile_active().id);
    const auto sent = send_json(req, response);
    time_service_schedule_apply();
    if (network)
        network_schedule_apply();
    return sent;
}

/**
 * @brief Return device identity, network observations, diagnostics, clocks and profile status.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Combines local snapshots without exposing WiFi/MQTT secrets; no cloud connection is
 * consulted.
 */
esp_err_t status(httpd_req_t* req)
{
    runtime_task_observe(RuntimeTask::Http);
    if (!require(req))
        return ESP_OK;
    cJSON* root = network_status_json();
    if (!root)
        return error(req, "500 Internal Server Error", "Недостаточно памяти");
    auto* product = cJSON_AddObjectToObject(root, "product");
    cJSON_AddStringToObject(product, "name", FCPLCN_PRODUCT_NAME);
    cJSON_AddStringToObject(product, "fullName", FCPLCN_PRODUCT_FULL_NAME);
    auto* device = cJSON_AddObjectToObject(root, "device");
    cJSON_AddStringToObject(device, "id", device_id().c_str());
    cJSON_AddStringToObject(device, "name", config_get().device.name.c_str());
    std::uint8_t mac[6]{};
    char formatted_mac[18]{};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        std::snprintf(formatted_mac,
                      sizeof(formatted_mac),
                      "%02X:%02X:%02X:%02X:%02X:%02X",
                      mac[0],
                      mac[1],
                      mac[2],
                      mac[3],
                      mac[4],
                      mac[5]);
        cJSON_AddStringToObject(device, "mac", formatted_mac);
    }
    cJSON_AddStringToObject(root, "firmwareVersion", esp_app_get_description()->version);
    cJSON_AddNumberToObject(root, "uptimeSec", static_cast<double>(esp_timer_get_time() / 1000000));
    cJSON_AddNumberToObject(root, "freeHeap", esp_get_free_heap_size());
    cJSON_AddItemToObject(root, "system", system_metrics_json());
    cJSON_AddItemToObject(root, "stateStorage", controllers_state_storage_json());
    auto* hardware = board_profile_status_json();
    const auto current_config = config_get();
    cJSON_AddStringToObject(hardware, "configuredBoardId", current_config.hardware.boardId.c_str());
    cJSON_AddBoolToObject(
        hardware, "rebootRequired", current_config.hardware.boardId != board_profile_active().id);
    cJSON_AddItemToObject(root, "hardware", hardware);
    cJSON_AddItemToObject(root, "time", time_service_status_json());
    cJSON_AddNumberToObject(root, "revision", current_config.revision);
    return send_json(req, root);
}

/**
 * @brief Verify the current password, update the account and require a new web login.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note An omitted newPassword preserves the verifier; a supplied empty string explicitly clears
 * the password.
 */
esp_err_t change_user(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    std::string username, current_password, password;
    if (!get_string(body.get(), "username", username, 64)
        || !get_string(body.get(), "currentPassword", current_password, 128)
        || !get_string(body.get(), "newPassword", password, 128, true))
        return error(req, "400 Bad Request", "Некорректные данные пользователя");
    const auto updated = auth_change_user(current_password,
                                          username,
                                          cJSON_HasObjectItem(body.get(), "newPassword")
                                              ? std::optional<std::string>(password)
                                              : std::nullopt);
    if (updated != AuthResult::Ok)
        return auth_result(req, updated);
    AuthCookie cookie;
    auth_logout(req, cookie);
    auto* response = ok();
    cJSON_AddBoolToObject(response, "reauthenticate", true);
    return send_json(req, response);
}

/**
 * @brief Validate the requested 2024–2099 epoch and update system time plus the optional RTC.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Rejects a stale supplied timezone. A failed optional RTC write is deferred by the time
 * service; setting the ESP system clock can still succeed and be acknowledged.
 */
esp_err_t set_time(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    auto body = read_json(req);
    if (!body)
        return ESP_OK;
    const cJSON* unix_time = cJSON_GetObjectItemCaseSensitive(body.get(), "unixTime");
    if (!cJSON_IsNumber(unix_time) || !std::isfinite(unix_time->valuedouble)
        || unix_time->valuedouble < 1704067200 || unix_time->valuedouble > 4102444799.0)
        return error(req, "400 Bad Request", "Время должно быть в диапазоне 2024–2099");
    std::string timezone;
    if (!get_string(body.get(), "timezone", timezone, 96, true))
        return error(req, "400 Bad Request", "Некорректный часовой пояс");
    if (cJSON_HasObjectItem(body.get(), "timezone") && timezone != config_get().time.timezone)
        return error(req,
                     "409 Conflict",
                     "Часовой пояс изменился. Обновите настройки перед установкой времени");
    if (time_service_set_unix(static_cast<std::int64_t>(unix_time->valuedouble)) != ESP_OK)
        return error(req, "500 Internal Server Error", "Не удалось установить время");
    cJSON* response = ok();
    cJSON_AddNumberToObject(response, "revision", config_get().revision);
    return send_json(req, response);
}

/**
 * @brief Wait for a reboot notification, allow the HTTP reply one second, then restart ESP.
 * @note The unnamed FreeRTOS argument is unused. The idle worker waits without consuming CPU.
 * @pre Only notified after a reboot request or successful durable full restore.
 */
void restart_worker(void*)
{
    while (true) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_restart();
    }
}

/**
 * @brief Ensure an idle reboot worker exists before accepting a reboot or restore.
 * @return True if an existing worker is available or task creation succeeded.
 * @pre Called only by serialized ESP-IDF HTTP handlers; no reboot is triggered by reservation
 * alone.
 */
bool reserve_restart()
{
    if (restart_task != nullptr)
        return true;
    return xTaskCreate(restart_worker, "fcplcn_restart", 3072, nullptr, 3, &restart_task) == pdPASS;
}

/**
 * @brief Acknowledge an authenticated reboot and notify its delayed worker once.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Reserves the task before responding; reboot_pending prevents duplicate notifications.
 */
esp_err_t reboot(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    if (!firmware_update_prepare_restart())
        return error(req, "409 Conflict", "Во время загрузки прошивки перезагрузка недоступна");
    if (!reserve_restart()) {
        firmware_update_cancel_restart();
        return error(req, "500 Internal Server Error", "Не удалось запланировать перезапуск");
    }
    const auto sent = send_json(req, ok());
    if (!reboot_pending.exchange(true))
        xTaskNotifyGive(restart_task);
    return sent;
}

/**
 * @brief Dispatch authenticated application-upload chunks without buffering a complete binary.
 * @param[in] req Borrowed local HTTP request with the normal session and same-origin guards.
 * @return SDK response-send result; successful verification notifies the reserved reboot worker.
 */
esp_err_t firmware_update(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    Json body(nullptr, cJSON_Delete);
    if (req->method == HTTP_POST) {
        body = read_json(req, kFirmwareRequestBytes);
        if (!body)
            return ESP_OK;
    }
    auto result = firmware_update_request(req->method == HTTP_GET ? "GET" : "POST",
                                          std::string_view(req->uri).substr(7),
                                          body.get(),
                                          reserve_restart);
    const auto* status = result.status == 200   ? "200 OK"
                         : result.status == 400 ? "400 Bad Request"
                         : result.status == 404 ? "404 Not Found"
                         : result.status == 405 ? "405 Method Not Allowed"
                         : result.status == 409 ? "409 Conflict"
                                                : "503 Service Unavailable";
    const auto sent = send_json(req, result.data, status);
    if (result.reboot && !reboot_pending.exchange(true))
        xTaskNotifyGive(restart_task);
    return sent;
}

/**
 * @brief Download the complete portable saved configuration as a JSON attachment.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Requires authentication; the document contains secrets and the password verifier, unlike
 * get_config.
 */
esp_err_t download_backup(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    std::string message;
    auto* document = backup_export_json(message);
    if (!document)
        return error(req,
                     "503 Service Unavailable",
                     message.empty() ? "Не удалось подготовить резервную копию" : message.c_str());
    httpd_resp_set_hdr(req, "Content-Disposition", "attachment; filename=\"FCPLCn-backup.json\"");
    return send_json(req, document);
}

/**
 * @brief Validate and atomically stage a full backup, then schedule the required reboot.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Reserves the reboot task before commit. A successful import freezes mutations and schedules
 * restart after the reply.
 */
esp_err_t restore_backup(httpd_req_t* req)
{
    if (!require(req))
        return ESP_OK;
    if (reboot_pending.load())
        return error(req, "409 Conflict", "Перезагрузка уже запланирована");
    auto body = read_json(req, kBackupMaxRequestBytes);
    if (!body)
        return ESP_OK;
    if (!firmware_update_prepare_restart())
        return error(req, "409 Conflict", "Во время загрузки прошивки импорт недоступен");
    // Reserve an idle worker before committing: task-allocation failure must
    // not leave an accepted import stranded without its scheduled reboot.
    if (!reserve_restart()) {
        firmware_update_cancel_restart();
        return error(req, "503 Service Unavailable", "Не удалось подготовить перезагрузку");
    }
    std::string message;
    const auto result = backup_stage_restore(body.get(), message);
    if (result != BackupResult::Ok) {
        firmware_update_cancel_restart();
        return error(req,
                     result == BackupResult::InvalidInput ? "400 Bad Request"
                     : result == BackupResult::Conflict   ? "409 Conflict"
                                                          : "503 Service Unavailable",
                     message.c_str());
    }
    auto* response = ok();
    cJSON_AddBoolToObject(response, "rebootRequired", true);
    const auto sent = send_json(req, response);
    if (!reboot_pending.exchange(true))
        xTaskNotifyGive(restart_task);
    return sent;
}

/**
 * @brief Serve the embedded HTML, JavaScript or CSS with common browser-isolation headers.
 * @param[in] req Borrowed ESP-IDF request handled by the HTTP server task.
 * @return SDK response-send result, or ESP_OK when a guard/parser has already answered.
 * @note Assets are public so the login UI can load; API authorization is enforced by the individual
 * handlers.
 */
esp_err_t asset(httpd_req_t* req)
{
    common_headers(req);
    const std::string_view uri(req->uri);
    auto path = uri.substr(0, uri.find('?'));
    if (path == "/")
        path = "/index.html";
    const WebAsset* selected = nullptr;
    for (const auto& entry : web_assets) {
        if (path == entry.path) {
            selected = &entry;
            break;
        }
    }
    bool versioned = false;
    if (selected == nullptr || !asset_version_matches(uri, web_asset_version, versioned)) {
        httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        httpd_resp_set_status(req, "404 Not Found");
        return httpd_resp_sendstr(req, "Asset not present in this firmware release");
    }
    if (httpd_req_get_hdr_value_len(req, "Accept-Encoding") > 1024) {
        httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        httpd_resp_set_status(req, "431 Request Header Fields Too Large");
        return httpd_resp_sendstr(req, "Accept-Encoding header is too large");
    }
    const auto encoding = asset_encoding(header(req, "Accept-Encoding", 1024));
    httpd_resp_set_hdr(req, "Vary", "Accept-Encoding");
    if (encoding == AssetEncoding::None) {
        httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        httpd_resp_set_status(req, "406 Not Acceptable");
        return httpd_resp_sendstr(req, "No acceptable asset representation");
    }
    const bool gzip = encoding == AssetEncoding::Gzip;
    const auto* data = gzip ? selected->gzip : selected->identity;
    const auto size = gzip ? selected->gzipSize : selected->identitySize;
    const auto* etag = gzip ? selected->gzipEtag : selected->identityEtag;
    httpd_resp_set_type(req, selected->mime);
    httpd_resp_set_hdr(req, "ETag", etag);
    httpd_resp_set_hdr(req,
                       "Cache-Control",
                       !selected->html && versioned ? "public, max-age=31536000, immutable"
                                                    : "no-cache");
    if (gzip)
        httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    if (asset_etag_matches(header(req, "If-None-Match", 1024), etag)) {
        httpd_resp_set_status(req, "304 Not Modified");
        return httpd_resp_send(req, nullptr, 0);
    }
    return httpd_resp_send(req, reinterpret_cast<const char*>(data), size);
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Start the HTTP server and register the local API and embedded assets.
 * @return ESP_OK or an ESP-IDF server/route registration error.
 * @pre Auth, settings, controllers, clocks and network initialization have completed.
 * Call once from startup; the server binds port 80 on all active local interfaces.
 * @note API mutations require a session and matching browser Origin/Host. JSON body sizes,
 * nesting, receive budgets and socket timeouts are bounded. No credentials are logged.
 * @endcond
 */
esp_err_t web_server_start()
{
    const struct Route {
        const char* path;
        httpd_method_t method;
        esp_err_t (*handler)(httpd_req_t*);
    } routes[] = {
        {"/", HTTP_GET, asset},
        {"/index.html", HTTP_GET, asset},
        {"/app.js", HTTP_GET, asset},
        {"/style.css", HTTP_GET, asset},
        {"/modules/*", HTTP_GET, asset},
        {"/api/v1/login", HTTP_POST, login},
        {"/api/v1/logout", HTTP_POST, logout},
        {"/api/v1/status", HTTP_GET, status},
        {"/api/v1/config", HTTP_GET, get_config},
        {"/api/v1/config", HTTP_POST, set_config},
        {"/api/v1/config/backup", HTTP_GET, download_backup},
        {"/api/v1/config/restore", HTTP_POST, restore_backup},
        {"/api/v1/board-profiles", HTTP_GET, get_board_profiles},
        {"/api/v1/hardware", HTTP_GET, get_hardware},
        {"/api/v1/hardware/relay", HTTP_POST, set_relay},
        {"/api/v1/hardware/scan", HTTP_POST, scan_hardware},
        {"/api/v1/controllers", HTTP_GET, get_controllers},
        {"/api/v1/controllers/sockets", HTTP_GET, get_controller},
        {"/api/v1/controllers/sockets", HTTP_POST, configure_controller},
        {"/api/v1/controllers/sockets/state", HTTP_POST, set_controller_state},
        {"/api/v1/controllers/lights", HTTP_GET, get_controller},
        {"/api/v1/controllers/lights", HTTP_POST, configure_controller},
        {"/api/v1/controllers/lights/state", HTTP_POST, set_controller_state},
        {"/api/v1/controllers/meteo", HTTP_GET, get_controller},
        {"/api/v1/controllers/meteo", HTTP_POST, configure_controller},
        {"/api/v1/controllers/meteo/scan", HTTP_POST, scan_meteo},
        {"/api/v1/controllers/irrigation", HTTP_GET, get_controller},
        {"/api/v1/controllers/irrigation", HTTP_POST, configure_controller},
        {"/api/v1/controllers/irrigation/enabled", HTTP_POST, set_item_enabled},
        {"/api/v1/controllers/tanks", HTTP_GET, get_controller},
        {"/api/v1/controllers/tanks", HTTP_POST, configure_controller},
        {"/api/v1/controllers/tanks/enabled", HTTP_POST, set_item_enabled},
        {"/api/v1/controllers/thermostats", HTTP_GET, get_controller},
        {"/api/v1/controllers/thermostats", HTTP_POST, configure_controller},
        {"/api/v1/controllers/thermostats/enabled", HTTP_POST, set_item_enabled},
        {"/api/v1/controllers/security", HTTP_GET, get_controller},
        {"/api/v1/controllers/security", HTTP_POST, configure_controller},
        {"/api/v1/controllers/security/armed", HTTP_POST, set_security_armed},
        {"/api/v1/controllers/security/scan", HTTP_POST, scan_security_keys},
        {"/api/v1/user", HTTP_POST, change_user},
        {"/api/v1/time", HTTP_POST, set_time},
        {"/api/v1/reboot", HTTP_POST, reboot},
        {"/api/v1/firmware", HTTP_GET, firmware_update},
        {"/api/v1/firmware/begin", HTTP_POST, firmware_update},
        {"/api/v1/firmware/chunk", HTTP_POST, firmware_update},
        {"/api/v1/firmware/finish", HTTP_POST, firmware_update},
        {"/api/v1/firmware/abort", HTTP_POST, firmware_update},
    };

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.max_uri_handlers = sizeof(routes) / sizeof(routes[0]);
    config.uri_match_fn = httpd_uri_match_wildcard;
    config.max_open_sockets = 7;
    config.lru_purge_enable = true;
    config.stack_size = 12288;
    config.recv_wait_timeout = 5;
    config.send_wait_timeout = 5;
    esp_err_t result = httpd_start(&server, &config);
    if (result != ESP_OK)
        return result;

    for (const auto& route : routes) {
        httpd_uri_t uri{};
        uri.uri = route.path;
        uri.method = route.method;
        uri.handler = route.handler;
        result = httpd_register_uri_handler(server, &uri);
        if (result != ESP_OK)
            return result;
    }
    ESP_LOGI(FCPLCN_PRODUCT_NAME, "Web interface started on port 80, all local interfaces");
    return ESP_OK;
}
