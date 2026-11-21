/**
 * @file runtime_supervisor.h
 * @brief Task progress, watchdog recovery and retained startup diagnostics.
 */
#pragma once

#include <cstddef>
#include "esp_err.h"

struct cJSON;

/** @brief Stable diagnostic slots for process-lifetime FreeRTOS workers. */
enum class RuntimeTask : std::size_t {
    Main,  ///< Application startup and physical recovery-button loop.
    Io,  ///< Expander sampling, health checking and recovery.
    Controllers,  ///< Autonomous switches and thermal control.
    Supervisor,  ///< Independent progress monitor.
    Network,  ///< Interface/MQTT lifecycle manager.
    Meteo,  ///< Local sensor polling.
    Time,  ///< System-time and NTP maintenance.
    Rtc,  ///< External RTC polling.
    Http,  ///< ESP-IDF's persistent HTTP server task.
    Count  ///< Number of diagnostic slots; not a task identity.
};

/**
 * @brief Enable a five-second panic watchdog and an independent progress monitor.
 * @return ESP_OK or an SDK/task-allocation error; call before starting critical workers.
 * @note The monitor restarts ESP after a critical worker stops completing iterations for six
 * seconds, including when that worker could not subscribe to the hardware task watchdog.
 */
esp_err_t runtime_supervisor_init();

/**
 * @brief Register the calling persistent task and subscribe it to the task watchdog.
 * @param[in] task Diagnostic identity belonging to the calling task.
 * @return ESP_OK, INVALID_ARG, or the watchdog registration error retained in diagnostics.
 * @note Call once from the worker itself. Even failed subscription retains software progress
 * monitoring for I/O and controllers; continue the local loop and report the error.
 */
esp_err_t runtime_task_start(RuntimeTask task);

/**
 * @brief Record completion of one iteration and feed this task's watchdog subscription.
 * @note Call from the monitored worker after useful work, never from another task or a timer
 * on its behalf. Native test builds intentionally provide a no-op hook.
 */
void runtime_task_heartbeat();

/**
 * @brief Register the calling persistent task for stack diagnostics without watching its period.
 * @param[in] task Diagnostic identity for a task that remains alive throughout device runtime.
 * @note Never register a temporary task: its handle must remain valid for stack sampling.
 */
void runtime_task_observe(RuntimeTask task);

/**
 * @brief Retain one startup/service failure without aborting or erasing settings.
 * @param[in] stage Static process-lifetime stage label; no credentials or user data.
 * @param[in] error ESP-IDF error code; ESP_OK is ignored.
 * @note Thread-safe. Up to twelve distinct startup stages are retained.
 */
void runtime_supervisor_record_error(const char* stage, esp_err_t error);

/**
 * @brief Check whether any startup/service failure has been retained.
 * @return True when startup diagnostics contain an error.
 */
bool runtime_supervisor_degraded();

/**
 * @brief Verify that both critical workers completed an iteration under running supervision.
 * @return True after both live critical tasks demonstrate progress and supervision is available.
 * @note Optional network/sensor failures do not by themselves block OTA acceptance.
 */
bool runtime_supervisor_control_ready();

/**
 * @brief Build task stack/progress, watchdog and startup diagnostics.
 * @return Owned JSON object, or nullptr on allocation failure; delete with cJSON_Delete.
 * @note Registered handles refer only to process-lifetime tasks. ESP-IDF reports stack high
 * water marks in bytes. No module or hardware lock is taken while sampling task stacks.
 */
cJSON* runtime_supervisor_json();

#ifndef ESP_PLATFORM
/** @cond FCPLCN_HOST_TEST_ADAPTERS */
inline esp_err_t runtime_task_start(RuntimeTask)
{
    return ESP_OK;
}

inline void runtime_task_heartbeat()
{
}

inline void runtime_task_observe(RuntimeTask)
{
}

/** @endcond */
#endif
