/**
 * @file rtc_clock.cpp
 * @brief Serialized optional DS3231M polling and verified UTC writes.
 * @details A five-second freshness bound prevents a disconnected RTC from serving indefinitely
 * cached time. Calendar writes are read back before OSF is cleared; transport or
 * calendar failures invalidate the cache rather than inventing a current time.
 */
#include "time/rtc_clock.h"
#include "system/runtime_supervisor.h"
#include "hardware/board_profile.h"
#include "hardware/hardware_io.h"
#include "time/rtc_codec.h"

#include <ctime>
#include <mutex>
#include <string>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {
std::mutex mutex;
bool present = false;
bool valid = false;
bool configured = false;
std::int64_t sampled_unix = 0;
std::int64_t sampled_at = -1;
std::string error;
TaskHandle_t task = nullptr;

/**
 * @brief Read the optional RTC through the shared profile-bound I2C service.
 * @param[in] reg First RTC register address.
 * @param[out] bytes Borrowed writable buffer of at least length bytes.
 * @param[in] length Number of sequential bytes to read.
 * @return ESP_OK, NOT_SUPPORTED when no RTC exists in the profile, or an I2C error.
 */
esp_err_t read_registers(std::uint8_t reg, std::uint8_t* bytes, std::size_t length)
{
    const auto& rtc = board_profile_active().rtc;
    return rtc ? hardware_i2c_read(rtc->i2cBusId, rtc->address, reg, bytes, length)
               : ESP_ERR_NOT_SUPPORTED;
}

/**
 * @brief Write sequential RTC registers through the serialized hardware I2C service.
 * @param[in] reg First RTC register address.
 * @param[in] bytes Borrowed readable payload of at least length bytes.
 * @param[in] length Number of bytes to write.
 * @return ESP_OK, NOT_SUPPORTED for a profile without RTC, or an I2C error.
 */
esp_err_t write_registers(std::uint8_t reg, const std::uint8_t* bytes, std::size_t length)
{
    const auto& rtc = board_profile_active().rtc;
    return rtc ? hardware_i2c_write(rtc->i2cBusId, rtc->address, reg, bytes, length)
               : ESP_ERR_NOT_SUPPORTED;
}

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
 * @brief Enable battery-backed timekeeping and disable unused RTC outputs/alarms.
 * @return ESP_OK after configuration, or the first bounded I2C error.
 * @pre Hold the RTC mutex.
 * @note OSF remains set until a time write and readback establish a valid calendar.
 */
esp_err_t configure()
{
    std::uint8_t flags[2]{};
    esp_err_t result = read_registers(0x0e, flags, sizeof(flags));
    if (result != ESP_OK) {
        present = false;
        configured = false;
        return failure(result, "RTC недоступен");
    }
    present = true;
    // Run on battery, disable unused square-wave/alarms. Preserve NA bits.
    const std::uint8_t control = (flags[0] & 0x18) | 0x04;
    if (flags[0] != control)
        result = write_registers(0x0e, &control, 1);
    if (result == ESP_OK && (flags[1] & 0x08)) {
        const std::uint8_t status =
            flags[1] & ~0x08;  // Preserve OSF until verified time is written.
        result = write_registers(0x0f, &status, 1);
    }
    if (result != ESP_OK) {
        configured = false;
        return failure(result, "Настройка RTC");
    }
    configured = true;
    return ESP_OK;
}

/**
 * @brief Refresh optional RTC presence, verified calendar and freshness diagnostics.
 * @pre Hold the RTC mutex; board activation and shared I2C initialization are complete.
 * @note Missing hardware, OSF, invalid dates or I2C failures leave the cache unavailable.
 */
void poll_locked()
{
    if (!board_profile_active().rtc) {
        present = false;
        valid = false;
        error = "RTC не предусмотрен профилем";
        return;
    }
    if (!configured && configure() != ESP_OK)
        return;
    std::uint8_t calendar[7]{}, status = 0;
    auto result = read_registers(0x00, calendar, sizeof(calendar));
    if (result == ESP_OK)
        result = read_registers(0x0f, &status, 1);
    if (result != ESP_OK) {
        present = false;
        configured = false;
        failure(result, "Чтение RTC");
        return;
    }
    present = true;
    if (!rtc_decode_calendar(calendar, status, sampled_unix) || sampled_unix < 1704067200) {
        valid = false;
        error = status & 0x80
                    ? "RTC потерял достоверное время (OSF). Установите время или дождитесь NTP."
                    : "Недостоверная дата RTC";
        return;
    }
    valid = true;
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
    std::uint8_t calendar[7]{};
    if (unix_time < 1704067200 || !rtc_encode_calendar(unix_time, calendar))
        return ESP_ERR_INVALID_ARG;
    std::lock_guard<std::mutex> lock(mutex);
    if (!board_profile_active().rtc)
        return ESP_ERR_NOT_SUPPORTED;
    if (!configured) {
        const auto result = configure();
        if (result != ESP_OK)
            return result;
    }
    auto result = write_registers(0x00, calendar, sizeof(calendar));
    if (result != ESP_OK)
        return failure(result, "Запись RTC");
    std::uint8_t readback[7]{};
    result = read_registers(0x00, readback, sizeof(readback));
    std::int64_t confirmed = 0;
    if (result != ESP_OK)
        return failure(result, "Проверка записи RTC");
    if (!rtc_decode_calendar(readback, 0, confirmed) || confirmed < unix_time
        || confirmed > unix_time + 1)
        return failure(ESP_FAIL, "RTC не подтвердил записанное время");
    std::uint8_t status = 0;
    result = read_registers(0x0f, &status, 1);
    if (result == ESP_OK) {
        status &= ~0x88;  // Clear OSF only after successful calendar write/readback.
        result = write_registers(0x0f, &status, 1);
    }
    if (result != ESP_OK)
        return failure(result, "Подтверждение достоверности RTC");
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
