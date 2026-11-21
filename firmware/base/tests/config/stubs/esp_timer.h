/** @file esp_timer.h @brief Monotonic host clock used only by the configuration test target. */
#pragma once
#include <chrono>
#include <cstdint>

/** @brief Read host monotonic microseconds for an optional remote-operation deadline.
 * @return Steady-clock elapsed microseconds; unrelated native driver fixtures keep their fake
 * clocks.
 */
inline std::int64_t esp_timer_get_time()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
