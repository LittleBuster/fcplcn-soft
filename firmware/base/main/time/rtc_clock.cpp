/**
 * @file rtc_clock.cpp
 * @brief Serialized optional DS3231M polling and verified UTC writes.
 * @details A five-second freshness bound prevents a disconnected RTC from serving indefinitely
 * cached time. Calendar writes are read back before OSF is cleared; transport or
 * calendar failures invalidate the cache rather than inventing a current time.
 */
#include "time/rtc_clock.h"
#include "hardware/board_profile.h"
#include "hardware/ds3231.h"
#include "platform/runtime_supervisor.h"

#include <ctime>
#include <mutex>
#include <string>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {
constexpr std::int64_t kEarliestTrustedUnixTime = 1704067200;  // 2024-01-01 UTC.
std::mutex mutex;
bool present = false;
bool valid = false;
bool configured = false;
std::int64_t sampled_unix = 0;
std::int64_t sampled_at = -1;
std::string error;
TaskHandle_t task = nullptr;

/**
 * @brief Invalidate the cached calendar and retain a readable RTC failure reason.
 * @param[in] result Driver/readback error to return unchanged.
 * @param[in] operation Borrowed null-terminated operation label.
 * @return The supplied result code.
 * @pre Hold the RTC mutex. The last sampled numeric value remains diagnostic only.
 */
esp_err_t failure(esp_err_t result, const char* operation)
{
    valid = false;
    error = std::string(operation) + ": " + esp_err_to_name(result);
    return result;
}

/**
 * @brief Test whether the last verified RTC sample is younger than five seconds.
 * @return True only for a valid cache entry with an established sample timestamp.
 * @pre Hold the RTC mutex.
 */
bool fresh()
{
    return valid && sampled_at >= 0 && esp_timer_get_time() - sampled_at < 5'000'000;
}

/**
 * @brief Configure the RTC and update its presence and availability.
 * @param[in] rtc Active profile's RTC connection.
 * @return ESP_OK after configuration, or the first bounded I2C error.
 * @pre Hold the RTC mutex.
 * @note OSF remains set until a time write and readback establish a valid calendar.
 */
esp_err_t configure(const BoardRtc& rtc)
{
    const auto result = ds3231_configure(rtc, present);
    configured = result == ESP_OK;
    return configured ? ESP_OK : failure(result, present ? "Настройка RTC" : "RTC недоступен");
}

/**
 * @brief Translate a driver write stage into a diagnostic operation name.
 * @param[in] stage Stage reported by the DS3231 driver.
 * @return Process-lifetime operation label used in service diagnostics.
 */
const char* write_operation(Ds3231WriteStage stage)
{
    switch (stage) {
        case Ds3231WriteStage::ReadCalendar:
            return "Проверка записи RTC";
        case Ds3231WriteStage::VerifyCalendar:
            return "RTC не подтвердил записанное время";
        case Ds3231WriteStage::ClearOscillatorStop:
            return "Подтверждение достоверности RTC";
        case Ds3231WriteStage::WriteCalendar:
        default:
            return "Запись RTC";
    }
}

/**
 * @brief Refresh optional RTC presence, verified calendar and freshness diagnostics.
 * @pre Hold the RTC mutex; board activation and shared I2C initialization are complete.
 * @note Missing hardware, OSF, invalid dates or I2C failures leave the cache unavailable.
 */
void poll_locked()
{
    const auto& rtc = board_profile_active().rtc;
    if (!rtc) {
        present = false;
        valid = false;
        error = "RTC не предусмотрен профилем";
        return;
    }
    if (!configured && configure(*rtc) != ESP_OK)
        return;
    Ds3231Time time;
    const auto result = ds3231_read_time(*rtc, time);
    if (result != ESP_OK) {
        present = false;
        configured = false;
        failure(result, "Чтение RTC");
        return;
    }
    present = true;
    if (!time.unixTime || *time.unixTime < kEarliestTrustedUnixTime) {
        valid = false;
        error = time.oscillatorStopped
                    ? "RTC потерял достоверное время (OSF). Установите время или дождитесь NTP."
                    : "Недостоверная дата RTC";
        return;
    }
    valid = true;
    sampled_unix = *time.unixTime;
    sampled_at = esp_timer_get_time();
    error.clear();
}

/**
 * @brief Poll the optional RTC once per second in its dedicated FreeRTOS task.
 * @note The unused task argument is ignored; rtc_clock_poll() acquires the RTC mutex.
 */
void worker(void*)
{
    runtime_task_observe(RuntimeTask::Rtc);
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        rtc_clock_poll();
    }
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Sample the optional RTC and start its one-second polling task.
 * @pre Board activation and hardware_io_init() have completed; call once from startup.
 * @note Missing hardware or task allocation failure is nonfatal and is reported in status/logs.
 * @endcond
 */
void rtc_clock_init()
{
    rtc_clock_poll();
    if (task == nullptr && xTaskCreate(worker, "fcplcn_rtc", 4096, nullptr, 2, &task) != pdPASS)
        ESP_LOGW("FCPLCn.rtc", "RTC polling task could not start");
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Refresh the cached RTC calendar and validity flags.
 * @note Thread-safe; serialized I2C reads may block up to the hardware transaction bounds.
 * @endcond
 */
void rtc_clock_poll()
{
    std::lock_guard<std::mutex> lock(mutex);
    poll_locked();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read the last verified sample, without I2C access or extrapolation.
 * @return Sampled UTC epoch seconds, or nullopt when invalid/at least five seconds old.
 * @note Thread-safe after board/hardware initialization.
 * @endcond
 */
std::optional<std::int64_t> rtc_clock_get_unix()
{
    std::lock_guard<std::mutex> lock(mutex);
    return fresh() ? std::optional<std::int64_t>(sampled_unix) : std::nullopt;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Write and verify the RTC calendar, then clear OSF.
 * @param[in] unix_time UTC epoch seconds from 2024 through 2099.
 * @return ESP_OK after full confirmation, INVALID_ARG/NOT_SUPPORTED, or an I2C/readback error.
 * @note Thread-safe; the cached time becomes invalid on failure. OSF is cleared only after
 * calendar readback confirms the requested time or the immediately following second.
 * @endcond
 */
esp_err_t rtc_clock_set_unix(std::int64_t unix_time)
{
    if (unix_time < kEarliestTrustedUnixTime || unix_time >= kDs3231UnixEnd)
        return ESP_ERR_INVALID_ARG;
    std::lock_guard<std::mutex> lock(mutex);
    const auto& rtc = board_profile_active().rtc;
    if (!rtc)
        return ESP_ERR_NOT_SUPPORTED;
    if (!configured) {
        const auto result = configure(*rtc);
        if (result != ESP_OK)
            return result;
    }
    const auto result = ds3231_write_time(*rtc, unix_time);
    if (result.error != ESP_OK)
        return failure(result.error, write_operation(result.stage));
    poll_locked();
    return fresh() ? ESP_OK : ESP_FAIL;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Build optional RTC identity, presence, freshness and diagnostic status.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr when the root cannot be allocated.
 * @note Thread-safe; unavailable time is JSON null, never an invented timestamp.
 * @endcond
 */
cJSON* rtc_clock_status_json()
{
    std::lock_guard<std::mutex> lock(mutex);
    auto* json = cJSON_CreateObject();
    if (json == nullptr)
        return nullptr;
    const auto& rtc = board_profile_active().rtc;
    const bool available = fresh();
    cJSON_AddStringToObject(json, "model", rtc ? rtc->model : "");
    cJSON_AddStringToObject(json, "busId", rtc ? rtc->i2cBusId : "");
    if (rtc)
        cJSON_AddNumberToObject(json, "address", rtc->address);
    else
        cJSON_AddNullToObject(json, "address");
    cJSON_AddBoolToObject(json, "present", present);
    cJSON_AddBoolToObject(json, "valid", available);
    if (available)
        cJSON_AddNumberToObject(json, "unixTime", static_cast<double>(sampled_unix));
    else
        cJSON_AddNullToObject(json, "unixTime");
    char formatted[80]{};
    if (available) {
        const auto timestamp = static_cast<std::time_t>(sampled_unix);
        struct tm local{};
        localtime_r(&timestamp, &local);
        std::strftime(formatted, sizeof(formatted), "%Y-%m-%d %H:%M:%S %z", &local);
    }
    cJSON_AddStringToObject(json, "localTime", formatted);
    cJSON_AddStringToObject(
        json, "error", available ? "" : (error.empty() ? "RTC: нет свежих данных" : error.c_str()));
    if (sampled_at >= 0)
        cJSON_AddNumberToObject(json, "updatedAtMs", static_cast<double>(sampled_at / 1000));
    else
        cJSON_AddNullToObject(json, "updatedAtMs");
    return json;
}
