/**
 * @file time_service.h
 * @brief ESP system clock, POSIX timezone and optional NTP/RTC synchronization.
 */
#pragma once
#include "cJSON.h"
#include "esp_err.h"
#include <cstdint>
/** @brief Restore plausible RTC time and start the time configuration worker.
 * @return ESP_OK, a task allocation error or event registration error.
 * @pre Configuration, board, RTC/hardware and the default event loop are initialized.
 * @note Call once at startup. Autonomous controllers use monotonic freshness separately.
 */
esp_err_t time_service_init();

/** @brief Request deferred timezone/NTP reconfiguration from current persisted settings.
 * @note Thread-safe task-context notification; repeated requests are coalesced.
 */
void time_service_schedule_apply();

/** @brief Report system wall time, its source and the optional external RTC status.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on root allocation failure.
 * @note Thread-safe after initialization; formatting uses the configured POSIX timezone.
 */
cJSON* time_service_status_json();

/** @brief Set system wall time and attempt a verified optional RTC update.
 * @param[in] unix_time UTC epoch seconds in the supported 2024..2099 range.
 * @return ESP_OK once the system clock is set, INVALID_ARG for range, or ESP_FAIL.
 * @note Thread-safe. RTC failure does not undo system time; a worker retries the RTC update.
 */
esp_err_t time_service_set_unix(std::int64_t unix_time);
