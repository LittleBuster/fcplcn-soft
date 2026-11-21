/** @file services.cpp @brief Host-only nonmutating network/clock/diagnostic adapters. */
#include "network/network.h"
#include "hardware/hardware_io.h"
#include "time/rtc_clock.h"
#include "time/time_service.h"
#include "system/system_metrics.h"
#include "system/firmware_update.h"
#include "util/operation_context.h"
#include "esp_app_desc.h"
#include "esp_system.h"

namespace management_test {
unsigned scans = 0;
std::int64_t unix_time = 0;
}  // namespace management_test

/** @brief Return fake LAN observations without broker credentials. */
cJSON* network_status_json()
{
    return cJSON_CreateObject();
}

/** @brief Return a fake hardware envelope; actual state mutations use the shared driver fixture. */
cJSON* hardware_io_status_json()
{
    return cJSON_CreateObject();
}

/** @brief Count asynchronous scan requests without performing host I2C operations. */
void hardware_io_request_scan()
{
    ++management_test::scans;
}

/** @brief Return a fake optional RTC observation. */
cJSON* rtc_clock_status_json()
{
    return cJSON_CreateObject();
}

/** @brief Return a fake ESP wall-clock observation. */
cJSON* time_service_status_json()
{
    return cJSON_CreateObject();
}

/** @brief Apply a fake clock value only while the same remote context remains valid. */
esp_err_t time_service_set_unix(std::int64_t value)
{
    if (!operation_permitted())
        return ESP_ERR_INVALID_STATE;
    management_test::unix_time = value;
    return ESP_OK;
}

/** @brief Return fake CPU/heap metrics without replacing business storage or controllers. */
cJSON* system_metrics_json()
{
    return cJSON_CreateObject();
}

/** @brief Return the host test firmware version. */
const esp_app_desc_t* esp_app_get_description()
{
    static const esp_app_desc_t description{"host-test"};
    return &description;
}

/** @brief Return a fixed host heap diagnostic. */
std::uint32_t esp_get_free_heap_size()
{
    return 100'000;
}

/** @brief Isolate flash SDK from service-route tests; production OTA has dedicated native tests. */
FirmwareUpdateResult
firmware_update_request(std::string_view, std::string_view, const cJSON*, bool (*)())
{
    auto* data = cJSON_CreateObject();
    cJSON_AddStringToObject(data, "error", "OTA flash adapter is covered by test-base-ota");
    return {503, data, false};
}

/** @brief Keep unrelated route regressions outside a simulated upload. */
bool firmware_update_busy()
{
    return false;
}

/** @brief Permit reboot reservation in unrelated storage/controller route regressions. */
bool firmware_update_prepare_restart()
{
    return true;
}

/** @brief Release a fake reservation with no hardware side effect. */
void firmware_update_cancel_restart()
{
}
