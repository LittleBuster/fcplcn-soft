/**
 * @file recovery_mode.cpp
 * @brief RAM-only recovery AP with read-only diagnostics and deliberate restart.
 */
#include "system/recovery_mode.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string_view>
#include "product_identity.h"
#include "system/runtime_supervisor.h"
#include "system/system_metrics.h"
#include "cJSON.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {
constexpr char kTag[] = FCPLCN_PRODUCT_NAME ".recovery";
std::array<char, 33> reboot_token{};
const char* failed_stage = "startup";
esp_err_t failed_error = ESP_FAIL;
RecoveryBootState boot_status{};

/**
 * @brief Apply cache and browser restrictions to an isolated recovery response.
 * @param[in] request Borrowed ESP-IDF HTTP request.
 */
void headers(httpd_req_t* request)
{
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(request, "X-Frame-Options", "DENY");
    httpd_resp_set_hdr(
        request,
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
}

/**
 * @brief Describe only the safe-start operations established before the failure.
 * @return Borrowed static explanatory text; physical outputs are never assumed OFF.
 */
const char* safety_note()
{
    if (boot_status.boardId == nullptr)
        return "Модель платы не подтверждена. GPIO оставлены без переназначения; состояние физических выходов не подтверждено.";
    if (!boot_status.safeGpiosConfigured)
        return "Модель платы известна, но безопасные уровни GPIO не подтверждены. Состояние физических выходов не подтверждено.";
    if (boot_status.expanderResetRequested)
        return "Установлены безопасные уровни GPIO выбранной платы и запрошен RESET расширителя. Физическое выключение нагрузок не проверено.";
    return "Установлены безопасные уровни GPIO выбранной платы. Аппаратный RESET расширителя недоступен; состояние физических выходов не подтверждено.";
}

/**
 * @brief Serve recovery instructions and a per-boot-token restart form without JavaScript.
 * @param[in] request Borrowed ESP-IDF HTTP request.
 * @return SDK response-send status.
 */
esp_err_t index(httpd_req_t* request)
{
    headers(request);
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    char page[3600];
    std::snprintf(
        page,
        sizeof(page),
        "<!doctype html><html lang=ru><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>%s — восстановление</title><style>body{color:#edf2fa;background:#101820;font:18px system-ui;max-width:720px;margin:8vh auto;padding:24px}"
        "main{background:#1b2836;padding:28px;border-radius:20px}button,a{color:#a5dfed}button{background:#263b4b;padding:14px;border:1px solid #5f8b9c;border-radius:10px;font:inherit}code{word-break:break-all}</style>"
        "<main><h1>%s</h1><h2>Аварийный режим</h2><p>Аппаратные драйверы и автономные контроллеры не запущены. Настройки и учётная запись сохранены.</p>"
        "<p>%s</p>"
        "<p>Этап: <code>%s</code><br>Ошибка: <code>%s</code></p>"
        "<p>Доступны только диагностика и перезапуск. Для исправления повреждённых настроек используйте сервисное подключение; автоматического стирания Flash нет.</p>"
        "<p><a href='/api/v1/status'>Открыть диагностику JSON</a></p>"
        "<form method=post action='/api/v1/reboot'><input type=hidden name=token value='%s'><button>Перезапустить PLC</button></form></main></html>",
        FCPLCN_PRODUCT_NAME,
        FCPLCN_PRODUCT_NAME,
        safety_note(),
        failed_stage,
        esp_err_to_name(failed_error),
        reboot_token.data());
    return httpd_resp_sendstr(request, page);
}

/**
 * @brief Return only nonsecret failure and runtime diagnostics in recovery mode.
 * @param[in] request Borrowed ESP-IDF HTTP request.
 * @return SDK response-send status, including a bounded allocation-failure response.
 */
esp_err_t status(httpd_req_t* request)
{
    headers(request);
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    auto* json = cJSON_CreateObject();
    if (json == nullptr)
        return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "No memory");
    cJSON_AddStringToObject(json, "product", FCPLCN_PRODUCT_NAME);
    cJSON_AddStringToObject(json, "mode", "recovery");
    cJSON_AddStringToObject(json, "stage", failed_stage);
    cJSON_AddStringToObject(json, "error", esp_err_to_name(failed_error));
    cJSON_AddBoolToObject(json, "storagePreserved", true);
    cJSON_AddBoolToObject(json, "boardProfileKnown", boot_status.boardId != nullptr);
    if (boot_status.boardId != nullptr)
        cJSON_AddStringToObject(json, "boardId", boot_status.boardId);
    else
        cJSON_AddNullToObject(json, "boardId");
    cJSON_AddBoolToObject(json, "hardwareDriversStarted", false);
    cJSON_AddBoolToObject(json, "safeGpiosAttempted", boot_status.safeGpiosAttempted);
    cJSON_AddBoolToObject(json, "safeGpiosConfigured", boot_status.safeGpiosConfigured);
    cJSON_AddBoolToObject(json, "expanderResetRequested", boot_status.expanderResetRequested);
    cJSON_AddBoolToObject(json, "physicalOutputsOffConfirmed", false);
    auto* metrics = system_metrics_json();
    if (!cJSON_AddItemToObject(json, "system", metrics))
        cJSON_Delete(metrics);
    char* body = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (body == nullptr)
        return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "No memory");
    const auto result = httpd_resp_sendstr(request, body);
    cJSON_free(body);
    return result;
}

/**
 * @brief Require a present browser Origin to match the recovery HTTP Host authority.
 * @param[in] request Borrowed recovery POST request.
 * @return True for a same-origin browser request or absent Origin; false for malformed headers.
 * @note Clients without Origin must still provide the per-boot restart token.
 */
bool same_origin(httpd_req_t* request)
{
    const auto origin_length = httpd_req_get_hdr_value_len(request, "Origin");
    if (origin_length == 0)
        return true;
    const auto host_length = httpd_req_get_hdr_value_len(request, "Host");
    if (origin_length > 135 || host_length == 0 || host_length > 128)
        return false;
    std::array<char, 136> origin{};
    std::array<char, 129> host{};
    if (httpd_req_get_hdr_value_str(request, "Origin", origin.data(), origin.size()) != ESP_OK
        || httpd_req_get_hdr_value_str(request, "Host", host.data(), host.size()) != ESP_OK)
        return false;
    std::string_view url(origin.data());
    if (url.substr(0, 7) != "http://")
        return false;
    auto authority = url.substr(7);
    std::string_view expected(host.data());
    if (authority.find_first_of("/\\@?# \t\r\n") != std::string_view::npos)
        return false;
    if (authority.size() > 3 && authority.substr(authority.size() - 3) == ":80")
        authority.remove_suffix(3);
    if (expected.size() > 3 && expected.substr(expected.size() - 3) == ":80")
        expected.remove_suffix(3);
    return authority == expected;
}

/**
 * @brief Verify the bounded per-boot restart token before a deliberate recovery reboot.
 * @param[in] request Borrowed ESP-IDF POST request containing one token form field.
 * @return SDK error/send result; ESP restarts after an accepted response.
 * @note The token is only exposed to clients that can read the isolated AP page, preventing
 * a cross-origin form from silently causing a reboot. No persistent credential is consulted.
 */
esp_err_t reboot(httpd_req_t* request)
{
    headers(request);
    if (!same_origin(request))
        return httpd_resp_send_err(request, HTTPD_403_FORBIDDEN, "Origin does not match Host");
    constexpr std::size_t kBodyBytes = 6 + 32;
    if (request->content_len != kBodyBytes)
        return httpd_resp_send_err(request, HTTPD_403_FORBIDDEN, "Invalid restart token");
    std::array<char, kBodyBytes + 1> body{};
    std::size_t received = 0;
    const auto deadline = esp_timer_get_time() + 5'000'000;
    while (received < kBodyBytes) {
        if (esp_timer_get_time() >= deadline)
            return httpd_resp_send_err(request, HTTPD_408_REQ_TIMEOUT, "Request timed out");
        const int count = httpd_req_recv(request, body.data() + received, kBodyBytes - received);
        if (count <= 0 || esp_timer_get_time() >= deadline)
            return httpd_resp_send_err(request, HTTPD_408_REQ_TIMEOUT, "Request timed out");
        received += static_cast<std::size_t>(count);
    }
    unsigned mismatch = std::memcmp(body.data(), "token=", 6) != 0;
    for (std::size_t i = 0; i < 32; ++i)
        mismatch |=
            static_cast<unsigned char>(body[i + 6]) ^ static_cast<unsigned char>(reboot_token[i]);
    if (mismatch != 0)
        return httpd_resp_send_err(request, HTTPD_403_FORBIDDEN, "Invalid restart token");
    httpd_resp_set_type(request, "text/plain; charset=utf-8");
    const auto result = httpd_resp_sendstr(request, FCPLCN_PRODUCT_NAME " перезапускается");
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
    return result;
}

/**
 * @brief Start a RAM-only AP that does not read WiFi credentials from unavailable NVS.
 * @return ESP_OK or the first network/WiFi initialization error.
 */
esp_err_t start_ap()
{
    auto result = esp_netif_init();
    if (result != ESP_OK && result != ESP_ERR_INVALID_STATE)
        return result;
    result = esp_event_loop_create_default();
    if (result != ESP_OK && result != ESP_ERR_INVALID_STATE)
        return result;
    esp_netif_config_t netif_config = ESP_NETIF_DEFAULT_WIFI_AP();
    auto* netif = esp_netif_new(&netif_config);
    if (netif == nullptr)
        return ESP_ERR_NO_MEM;
    result = esp_netif_attach_wifi_ap(netif);
    if (result == ESP_OK)
        result = esp_wifi_set_default_wifi_ap_handlers();
    if (result != ESP_OK) {
        esp_netif_destroy_default_wifi(netif);
        return result;
    }
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    init.nvs_enable = 0;
    result = esp_wifi_init(&init);
    if (result != ESP_OK)
        return result;
    result = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (result != ESP_OK)
        return result;
    result = esp_wifi_set_mode(WIFI_MODE_AP);
    if (result != ESP_OK)
        return result;
    wifi_config_t config{};
    std::array<std::uint8_t, 6> mac{};
    esp_read_mac(mac.data(), ESP_MAC_WIFI_SOFTAP);
    std::snprintf(reinterpret_cast<char*>(config.ap.ssid),
                  sizeof(config.ap.ssid),
                  "%s-Recovery-%02X%02X%02X",
                  FCPLCN_PRODUCT_NAME,
                  mac[3],
                  mac[4],
                  mac[5]);
    config.ap.ssid_len = std::strlen(reinterpret_cast<const char*>(config.ap.ssid));
    config.ap.channel = 1;
    config.ap.max_connection = 2;
    config.ap.authmode = WIFI_AUTH_OPEN;
    result = esp_wifi_set_config(WIFI_IF_AP, &config);
    if (result != ESP_OK)
        return result;
    result = esp_wifi_start();
    if (result == ESP_OK)
        ESP_LOGW(kTag, "Recovery AP %s at http://192.168.4.1; settings retained", config.ap.ssid);
    return result;
}

/**
 * @brief Start the three isolated recovery routes without regular control/configuration APIs.
 * @return ESP_OK or an HTTP server/route registration failure.
 */
esp_err_t start_server()
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 6144;
    config.recv_wait_timeout = 3;
    config.send_wait_timeout = 3;
    config.max_uri_handlers = 3;
    httpd_handle_t server = nullptr;
    auto result = httpd_start(&server, &config);
    if (result != ESP_OK)
        return result;
    std::array<httpd_uri_t, 3> routes{};
    routes[0].uri = "/";
    routes[0].method = HTTP_GET;
    routes[0].handler = index;
    routes[1].uri = "/api/v1/status";
    routes[1].method = HTTP_GET;
    routes[1].handler = status;
    routes[2].uri = "/api/v1/reboot";
    routes[2].method = HTTP_POST;
    routes[2].handler = reboot;
    for (const auto& route : routes) {
        result = httpd_register_uri_handler(server, &route);
        if (result != ESP_OK) {
            httpd_stop(server);
            return result;
        }
    }
    return ESP_OK;
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Preserve known safe-level requests and serve an isolated recovery AP without saved
 * secrets.
 * @param[in] stage Static startup-stage label that failed before hardware/control task creation.
 * @param[in] error Failure code shown without exposing saved settings.
 * @param[in] boot Established boot facts; boardId must have static lifetime when nonnull.
 * @note Never returns. Only diagnostics and an explicit token-protected reboot are offered;
 * no NVS erase, configuration export, control API or authentication bypass is provided.
 * @pre Invoke before starting profile-bound I/O/control workers. Unknown profiles leave GPIOs
 * untouched.
 * @endcond
 */
[[noreturn]] void recovery_mode_run(const char* stage, esp_err_t error, RecoveryBootState boot)
{
    boot_status = boot;
    failed_stage = stage;
    failed_error = error;
    runtime_supervisor_record_error(stage, error);
    ESP_LOGE(kTag, "%s failed: %s; entering read-only recovery", stage, esp_err_to_name(error));
    for (std::size_t i = 0; i < 4; ++i)
        std::snprintf(
            reboot_token.data() + i * 8, 9, "%08lx", static_cast<unsigned long>(esp_random()));
    const auto network = start_ap();
    if (network != ESP_OK)
        runtime_supervisor_record_error("recovery_ap", network);
    else {
        const auto http = start_server();
        if (http != ESP_OK)
            runtime_supervisor_record_error("recovery_http", http);
    }
    while (true)
        vTaskDelay(pdMS_TO_TICKS(1000));
}
