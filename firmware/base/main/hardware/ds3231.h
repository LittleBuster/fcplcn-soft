/**
 * @file ds3231.h
 * @brief Profile-bound DS3231M configuration and calendar access.
 */
#pragma once

#include <cstdint>
#include <optional>
#include "esp_err.h"

struct BoardRtc;

inline constexpr std::int64_t kDs3231UnixEnd = 4102444800;  ///< 2100-01-01 UTC, exclusive.

/** @brief Decoded calendar and oscillator status after a successful read. */
struct Ds3231Time {
    std::optional<std::int64_t> unixTime;  ///< UTC epoch seconds for a valid calendar.
    bool oscillatorStopped = false;  ///< OSF marks a loss of trustworthy timekeeping.
};

/** @brief Operation reported with a failed RTC calendar write. */
enum class Ds3231WriteStage {
    WriteCalendar,  ///< Transfer the encoded calendar to the RTC.
    ReadCalendar,  ///< Read back the new calendar.
    VerifyCalendar,  ///< Verify that the RTC reports the requested time.
    ClearOscillatorStop,  ///< Clear OSF and disable the unused 32 kHz output.
};

/** @brief Result of writing and confirming a DS3231 calendar. */
struct Ds3231WriteResult {
    esp_err_t error;  ///< ESP_OK or the first operation error.
    Ds3231WriteStage stage;  ///< Operation that failed when error is not ESP_OK.
};

/**
 * @brief Enable battery-backed timekeeping and disable unused outputs and alarms.
 * @param[in] rtc Active profile's RTC connection.
 * @param[out] present Whether the initial control and status registers could be read.
 * @return ESP_OK after configuration, or the first I2C error.
 * @note OSF is retained. The caller serializes operations on the RTC.
 */
esp_err_t ds3231_configure(const BoardRtc& rtc, bool& present);

/**
 * @brief Read calendar registers and check oscillator status.
 * @param[in] rtc Active profile's RTC connection.
 * @param[out] time Calendar and status on a successful transfer, unchanged on I2C error.
 * @return ESP_OK on a successful transfer, even if the calendar is invalid, or an I2C error.
 * @note The caller serializes operations on the RTC.
 */
esp_err_t ds3231_read_time(const BoardRtc& rtc, Ds3231Time& time);

/**
 * @brief Write the calendar and clear OSF after calendar readback matches.
 * @param[in] rtc Active profile's RTC connection.
 * @param[in] unix_time Authorized UTC epoch seconds in the chip's calendar range.
 * @return Result and operation for diagnosing a failed write.
 * @note The caller serializes operations on the RTC.
 */
Ds3231WriteResult ds3231_write_time(const BoardRtc& rtc, std::int64_t unix_time);
