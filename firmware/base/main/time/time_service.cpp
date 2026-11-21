/**
 * @file time_service.cpp
 * @brief System wall-clock source selection and deferred NTP/RTC synchronization.
 * @details Boot can restore a plausible RTC value before NTP is available. The NTP callback only
 * marks a pending RTC write; a worker performs serialized reconfiguration and bounded
 * retry spacing. Manual system time remains useful when the optional RTC is offline.
 */
#include "time/time_service.h"
#include "util/operation_context.h"
#include "system/runtime_supervisor.h"
#include "hardware/board_profile.h"
#include "config/config.h"
#include "time/rtc_clock.h"

#include <atomic>
#include <cstdlib>
#include <ctime>
#include <mutex>
#include <string>
#include <sys/time.h>
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {
std::mutex time_mutex;
std::atomic<int> source{0};
std::atomic<bool> rtc_sync_pending{false};
TaskHandle_t task = nullptr;
bool initialized = false;
std::string server;

/**
 * @brief Record a completed SNTP synchronization and defer its RTC write.
 * @note The callback ignores the supplied timeval, updates atomics only and never performs I2C.
 */
void synchronized(struct timeval*)
{
    source.store(2);
    rtc_sync_pending.store(true);
}

/**
 * @brief Seed an unset system clock from a fresh, plausible optional RTC sample.
 * @note Requires an unset source and initially implausible system time; rechecks source under
 * time_mutex.
 */
void restore_rtc_time()
{
    if (source.load() != 0 || std::time(nullptr) >= 1704067200)
        return;
    const auto rtc_time = rtc_clock_get_unix();
    if (!rtc_time)
        return;
    std::lock_guard<std::mutex> lock(time_mutex);
    if (source.load() != 0)
        return;
    timeval value{static_cast<time_t>(*rtc_time), 0};
    if (settimeofday(&value, nullptr) == 0)
        source.store(3);
}

/**
 * @brief Apply saved POSIX timezone and replace the optional SNTP client configuration.
 * @note Runs from the time worker and serializes TZ/SNTP lifecycle with time_mutex.
 */
void apply()
{
    const auto c = config_get().time;
    std::lock_guard<std::mutex> lock(time_mutex);
    setenv("TZ", c.timezone.c_str(), 1);
    tzset();
    if (initialized) {
        esp_netif_sntp_deinit();
        initialized = false;
    }
    if (c.ntpEnabled) {
        server = c.ntpServer;
        esp_sntp_config_t settings = ESP_NETIF_SNTP_DEFAULT_CONFIG(server.c_str());
        settings.sync_cb = synchronized;
        const esp_err_t err = esp_netif_sntp_init(&settings);
        initialized = err == ESP_OK;
        if (err != ESP_OK)
            ESP_LOGE("FCPLCn.time", "NTP start failed: %s", esp_err_to_name(err));
    }
}

/**
 * @brief Handle deferred time configuration, RTC boot restore and rate-limited RTC synchronization.
 * @note The unused task argument is ignored. RTC failures retry no faster than every five seconds.
 */
void worker(void*)
{
    runtime_task_observe(RuntimeTask::Time);
    apply();
    std::int64_t next_rtc_sync = 0;
    while (true) {
        if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000))) {
            vTaskDelay(pdMS_TO_TICKS(300));
            apply();
        }
        restore_rtc_time();
        if (rtc_sync_pending.load() && esp_timer_get_time() >= next_rtc_sync) {
            rtc_sync_pending.store(false);
            const auto result = rtc_clock_set_unix(static_cast<std::int64_t>(std::time(nullptr)));
            if (result != ESP_OK)
                rtc_sync_pending.store(true);
            next_rtc_sync = esp_timer_get_time() + 5'000'000;
        }
    }
}

/**
 * @brief Request deferred SNTP reconfiguration when a station or Ethernet address becomes usable.
 * @param[in] id IP-event identifier; unrelated events are ignored.
 * @note Unnamed handler context, event base and payload are unused; no network lifecycle runs here.
 */
void ip_event(void*, esp_event_base_t, int32_t id, void*)
{
    if (id == IP_EVENT_ETH_GOT_IP || id == IP_EVENT_STA_GOT_IP)
        time_service_schedule_apply();
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Restore plausible RTC time and start the time configuration worker.
 * @return ESP_OK, a task allocation error or event registration error.
 * @pre Configuration, board, RTC/hardware and the default event loop are initialized.
 * @note Call once at startup. Autonomous controllers use monotonic freshness separately.
 * @endcond
 */
esp_err_t time_service_init()
{
    restore_rtc_time();
    if (xTaskCreate(worker, "fcplcn_time", 4096, nullptr, 3, &task) != pdPASS)
        return ESP_ERR_NO_MEM;
    return esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, ip_event, nullptr);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Request deferred timezone/NTP reconfiguration from current persisted settings.
 * @note Thread-safe task-context notification; repeated requests are coalesced.
 * @endcond
 */
void time_service_schedule_apply()
{
    if (task)
        xTaskNotifyGive(task);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Report system wall time, its source and the optional external RTC status.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on root allocation failure.
 * @note Thread-safe after initialization; formatting uses the configured POSIX timezone.
 * @endcond
 */
cJSON* time_service_status_json()
{
    std::lock_guard<std::mutex> lock(time_mutex);
    const std::time_t now = std::time(nullptr);
    const bool valid = now >= 1704067200;
    struct tm local{};
    localtime_r(&now, &local);
    char formatted[80]{};
    if (valid)
        std::strftime(formatted, sizeof(formatted), "%Y-%m-%d %H:%M:%S %z", &local);
    cJSON* json = cJSON_CreateObject();
    cJSON_AddNumberToObject(json, "unixTime", static_cast<double>(now));
    cJSON_AddBoolToObject(json, "valid", valid);
    cJSON_AddStringToObject(json, "localTime", formatted);
    cJSON_AddStringToObject(json,
                            "source",
                            valid ? (source.load() == 2   ? "ntp"
                                     : source.load() == 3 ? "rtc"
                                                          : "manual")
                                  : "unset");
    auto* rtc = rtc_clock_status_json();
    cJSON_AddBoolToObject(
        json, "externalRtcPresent", cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(rtc, "present")));
    cJSON_AddItemToObject(json, "rtc", rtc);
    return json;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Set system wall time and attempt a verified optional RTC update.
 * @param[in] unix_time UTC epoch seconds in the supported 2024..2099 range.
 * @return ESP_OK once the system clock is set, INVALID_ARG for range, or ESP_FAIL.
 * @note Thread-safe. RTC failure does not undo system time; a worker retries the RTC update.
 * @endcond
 */
esp_err_t time_service_set_unix(std::int64_t unix_time)
{
    if (unix_time < 1704067200 || unix_time > 4102444799LL)
        return ESP_ERR_INVALID_ARG;
    {
        std::lock_guard<std::mutex> lock(time_mutex);
        if (!operation_permitted())
            return ESP_ERR_INVALID_STATE;
        timeval tv{static_cast<time_t>(unix_time), 0};
        if (settimeofday(&tv, nullptr) != 0)
            return ESP_FAIL;
        source.store(1);
    }
    // ESP time remains usable if an optional/offline RTC could not be updated.
    const auto rtc_result = rtc_clock_set_unix(unix_time);
    if (rtc_result != ESP_OK && board_profile_active().rtc) {
        rtc_sync_pending.store(true);
        ESP_LOGW("FCPLCn.time", "RTC write deferred: %s", esp_err_to_name(rtc_result));
    }
    return ESP_OK;
}
