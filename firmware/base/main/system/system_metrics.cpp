/**
 * @file system_metrics.cpp
 * @brief Chip temperature plus reset, heap and task-supervision diagnostics.
 * @details The diagnostic sensor is serialized independently of control sensors; installation or
 * read failure does not prevent PLC startup and produces unknown JSON measurements.
 */
#include "system/system_metrics.h"

#include <cmath>
#include <mutex>
#include "driver/temperature_sensor.h"
#include "esp_log.h"
#ifdef ESP_PLATFORM
#include "system/runtime_supervisor.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#endif

namespace {
constexpr char kTag[] = "FCPLCn.metrics";
std::mutex sensor_mutex;
temperature_sensor_handle_t sensor = nullptr;

#ifdef ESP_PLATFORM
/**
 * @brief Translate the SDK reset reason to a stable diagnostic identifier.
 * @param[in] reason Reason captured by the ESP reset controller for this boot.
 * @return Process-lifetime technical name; unknown future codes use "unknown".
 */
const char* reset_name(esp_reset_reason_t reason)
{
    switch (reason) {
        case ESP_RST_POWERON:
            return "power_on";
        case ESP_RST_EXT:
            return "external";
        case ESP_RST_SW:
            return "software";
        case ESP_RST_PANIC:
            return "panic";
        case ESP_RST_INT_WDT:
            return "interrupt_watchdog";
        case ESP_RST_TASK_WDT:
            return "task_watchdog";
        case ESP_RST_WDT:
            return "watchdog";
        case ESP_RST_DEEPSLEEP:
            return "deep_sleep";
        case ESP_RST_BROWNOUT:
            return "brownout";
        case ESP_RST_SDIO:
            return "sdio";
        case ESP_RST_USB:
            return "usb";
        case ESP_RST_JTAG:
            return "jtag";
        case ESP_RST_EFUSE:
            return "efuse";
        case ESP_RST_PWR_GLITCH:
            return "power_glitch";
        case ESP_RST_CPU_LOCKUP:
            return "cpu_lockup";
        default:
            return "unknown";
    }
}
#endif
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Install and enable the internal temperature sensor if available.
 * @note Thread-safe and idempotent after success. Failure is nonfatal and leaves metrics unknown.
 * @endcond
 */
void system_metrics_init()
{
    std::lock_guard<std::mutex> lock(sensor_mutex);
    if (sensor != nullptr)
        return;
    // One supported hardware range, covering normal operating chip temperatures.
    const temperature_sensor_config_t settings = TEMPERATURE_SENSOR_CONFIG_DEFAULT(20, 100);
    esp_err_t error = temperature_sensor_install(&settings, &sensor);
    if (error == ESP_OK) {
        error = temperature_sensor_enable(sensor);
        if (error != ESP_OK) {
            temperature_sensor_uninstall(sensor);
            sensor = nullptr;
        }
    }
    if (error != ESP_OK)
        ESP_LOGW(kTag, "Chip temperature unavailable: %s", esp_err_to_name(error));
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read chip temperature and target runtime/reset/heap diagnostics.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr if the root cannot be allocated.
 * @note Thread-safe. A failed/non-finite reading is JSON null and is never a control measurement.
 * @endcond
 */
cJSON* system_metrics_json()
{
    auto* json = cJSON_CreateObject();
    if (json == nullptr)
        return nullptr;
    {
        std::lock_guard<std::mutex> lock(sensor_mutex);
        float celsius = 0;
        if (sensor != nullptr && temperature_sensor_get_celsius(sensor, &celsius) == ESP_OK
            && std::isfinite(celsius)) {
            cJSON_AddNumberToObject(json, "chipTemperatureC", celsius);
        } else {
            cJSON_AddNullToObject(json, "chipTemperatureC");
        }
    }
#ifdef ESP_PLATFORM
    cJSON_AddNumberToObject(json, "minimumFreeHeapBytes", esp_get_minimum_free_heap_size());
    cJSON_AddNumberToObject(json,
                            "minimumFreeInternalHeapBytes",
                            heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    const auto reason = esp_reset_reason();
    cJSON_AddStringToObject(json, "resetReason", reset_name(reason));
    cJSON_AddNumberToObject(json, "resetReasonCode", static_cast<int>(reason));
    auto* runtime = runtime_supervisor_json();
    if (!cJSON_AddItemToObject(json, "runtime", runtime))
        cJSON_Delete(runtime);
#endif
    return json;
}
