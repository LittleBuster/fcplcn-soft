/**
 * @file rtc_clock.h
 * @brief Optional DS3231M service with verified writes and a bounded-age cache.
 */
#pragma once
#include <cstdint>
#include <optional>
#include "cJSON.h"
#include "esp_err.h"
/** @brief Sample the optional RTC and start its one-second polling task.
 * @pre Board activation and hardware_io_init() have completed; call once from startup.
 * @note Missing hardware or task allocation failure is nonfatal and is reported in status/logs.
 */
void rtc_clock_init();

/** @brief Refresh the cached RTC calendar and validity flags.
 * @note Thread-safe; serialized I2C reads may block up to the hardware transaction bounds.
 */
void rtc_clock_poll();

/** @brief Read the last verified sample, without I2C access or extrapolation.
 * @return Sampled UTC epoch seconds, or nullopt when invalid/at least five seconds old.
 * @note Thread-safe after board/hardware initialization.
 */
std::optional<std::int64_t> rtc_clock_get_unix();

/** @brief Write and verify the RTC calendar, then clear OSF.
 * @param[in] unix_time UTC epoch seconds from 2024 through 2099.
 * @return ESP_OK after full confirmation, INVALID_ARG/NOT_SUPPORTED, or an I2C/readback error.
 * @note Thread-safe; the cached time becomes invalid on failure. OSF is cleared only after
 * calendar readback confirms the requested time or the immediately following second.
 */
esp_err_t rtc_clock_set_unix(std::int64_t unix_time);

/** @brief Build optional RTC identity, presence, freshness and diagnostic status.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr when the root cannot be allocated.
 * @note Thread-safe; unavailable time is JSON null, never an invented timestamp.
 */
cJSON* rtc_clock_status_json();
