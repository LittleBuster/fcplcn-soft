/**
 * @file runtime_policy_test.cpp
 * @brief Native fault-injection coverage for bounded independent worker supervision.
 */
#include "platform/runtime_policy.h"

#include <cstdint>
#include <iostream>
#include <stdexcept>

/**
 * @brief Stop the test process when a safety policy expectation is violated.
 * @param[in] condition Evaluated fault-policy assertion.
 * @param[in] message Failure explanation printed by the test runner.
 */
void require(bool condition, const char* message)
{
    if (!condition)
        throw std::runtime_error(message);
}

/**
 * @brief Exercise fresh, stalled, never-started and wraparound worker histories.
 * @return Zero when every watchdog policy scenario passes.
 */
int main()
{
    require(!runtime_progress_expired(100'000, 0, false), "a task that never started is not stale");
    require(!runtime_progress_expired(0, 0, true), "boot at millisecond zero is a valid sample");
    require(!runtime_progress_expired(6000, 0, true),
            "the fallback deadline includes its boundary");
    require(runtime_progress_expired(6001, 0, true),
            "stalled work must trigger after the deadline");
    std::uint32_t completed = 0;
    for (std::uint32_t now = 20; now < 100'000; now += 20) {
        require(!runtime_progress_expired(now, completed, true), "a healthy loop must stay alive");
        completed = now;
    }
    require(runtime_progress_expired(completed + 6001, completed, true),
            "looping without completion must expire");
    const std::uint32_t before_wrap = UINT32_MAX - 2000;
    require(!runtime_progress_expired(1000, before_wrap, true),
            "healthy work across uptime wrap must stay alive");
    require(runtime_progress_expired(5000, before_wrap, true),
            "stalled work across uptime wrap must expire");
    require(!runtime_progress_expired(5000, 4990, true),
            "a completed iteration clears an old expiry");
    const std::uint32_t io_completed = 100;
    const std::uint32_t controller_completed = 7000;
    require(runtime_progress_expired(7000, io_completed, true),
            "controller progress must not hide a stalled IO worker");
    require(!runtime_progress_expired(7000, controller_completed, true),
            "independent healthy controller remains fresh");
    require(!runtime_control_progress_ready(true, true, false, false),
            "task creation is not proof of useful work");
    require(!runtime_control_progress_ready(true, true, true, false),
            "one completed worker is insufficient for OTA acceptance");
    require(!runtime_control_progress_ready(false, true, true, true),
            "missing hardware supervision blocks OTA acceptance");
    require(!runtime_control_progress_ready(true, false, true, true),
            "missing fallback monitor blocks OTA acceptance");
    require(runtime_control_progress_ready(true, true, true, true),
            "both supervised workers completing work allow OTA acceptance");
    std::cout
        << "FCPLCn runtime watchdog policy: healthy/stalled/independent/wrap scenarios PASS\n";
}
