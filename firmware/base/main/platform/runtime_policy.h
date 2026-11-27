/**
 * @file runtime_policy.h
 * @brief Portable progress deadline policy shared by firmware and fault-injection tests.
 */
#pragma once

#include <cstdint>

inline constexpr std::uint32_t kRuntimeWatchdogTimeoutMs =
    5000;  ///< Hardware task watchdog period.
inline constexpr std::uint32_t kRuntimeProgressTimeoutMs =
    6000;  ///< Independent progress deadline.

/**
 * @brief Detect a stalled worker with wrap-safe 32-bit monotonic millisecond arithmetic.
 * @param[in] nowMs Current low 32 bits of monotonic uptime in milliseconds.
 * @param[in] completedMs Most recent completed worker iteration in the same time domain.
 * @param[in] started Whether the worker has registered; absent optional tasks are not timed out.
 * @return True after more than six seconds without progress from a started worker.
 * @note The monitor samples every 250 ms, far sooner than a full 32-bit counter wrap. Feeding
 * another task never updates this worker's completion timestamp.
 */
constexpr bool
runtime_progress_expired(std::uint32_t nowMs, std::uint32_t completedMs, bool started)
{
    return started && static_cast<std::uint32_t>(nowMs - completedMs) > kRuntimeProgressTimeoutMs;
}

/**
 * @brief Gate OTA acceptance on actual work by both critical loops and available supervision.
 * @param[in] watchdogReady Whether panic watchdog initialization succeeded.
 * @param[in] monitorReady Whether the independent progress monitor is running.
 * @param[in] ioCompleted Whether a live I/O worker completed at least one iteration.
 * @param[in] controllersCompleted Whether a live control worker completed at least one iteration.
 * @return True only when both autonomous workers and their supervision have demonstrated readiness.
 */
constexpr bool runtime_control_progress_ready(bool watchdogReady,
                                              bool monitorReady,
                                              bool ioCompleted,
                                              bool controllersCompleted)
{
    return watchdogReady && monitorReady && ioCompleted && controllersCompleted;
}
