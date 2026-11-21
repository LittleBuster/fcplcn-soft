/**
 * @file runtime_supervisor.cpp
 * @brief Independent bounded-progress supervision and task stack observations.
 */
#include "system/runtime_supervisor.h"
#include "system/runtime_policy.h"
#include "product_identity.h"

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include "cJSON.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {
constexpr char kTag[] = FCPLCN_PRODUCT_NAME ".supervisor";
constexpr std::uint32_t kRestartMarker = 0x46435744;
constexpr std::size_t kTaskCount = static_cast<std::size_t>(RuntimeTask::Count);
constexpr const char* kTaskNames[] = {
    "main", "io", "controllers", "supervisor", "network", "meteo", "time", "rtc", "http"};

/** @brief Atomic progress state, independent of application/module mutexes. */
struct TaskState {
    std::atomic<TaskHandle_t> handle{nullptr};
    std::atomic<std::uint32_t> completedMs{0};
    std::atomic<bool> madeProgress{false};
    std::atomic<bool> requested{false};
    std::atomic<bool> subscribed{false};
    std::atomic<esp_err_t> error{ESP_OK};
};

/** @brief One retained startup diagnostic whose label has static lifetime. */
struct StartupError {
    const char* stage = nullptr;
    esp_err_t error = ESP_OK;
};

std::array<TaskState, kTaskCount> tasks;
std::mutex startup_mutex;
std::array<StartupError, 12> startup_errors;
std::atomic<bool> watchdog_ready{false};
std::atomic<bool> monitor_ready{false};
std::atomic<esp_err_t> watchdog_error{ESP_ERR_INVALID_STATE};
std::atomic<bool> degraded{false};
RTC_NOINIT_ATTR volatile std::uint32_t retained_restart_marker;
RTC_NOINIT_ATTR volatile std::uint32_t retained_restart_task;
const char* last_supervisor_restart = nullptr;

/**
 * @brief Determine whether a task needs completed-iteration progress monitoring.
 * @param[in] task Diagnostic task slot index.
 * @return True only for the I/O and autonomous-control workers.
 */
bool critical(std::size_t task)
{
    return task == static_cast<std::size_t>(RuntimeTask::Io)
           || task == static_cast<std::size_t>(RuntimeTask::Controllers);
}

/**
 * @brief Independently restart after a stalled critical worker and feed the monitor watchdog.
 * @note The unnamed FreeRTOS task argument is unused; this process-lifetime task never returns.
 * Progress reads are atomic and never wait for controller, storage or I/O locks.
 */
void monitor(void*)
{
    const auto subscribed = runtime_task_start(RuntimeTask::Supervisor);
    if (subscribed != ESP_OK)
        runtime_supervisor_record_error("supervisor_watchdog", subscribed);
    monitor_ready.store(true);
    while (true) {
        const auto now = static_cast<std::uint32_t>(esp_timer_get_time() / 1000);
        for (std::size_t i = 0; i < tasks.size(); ++i) {
            if (!critical(i) || tasks[i].handle.load() == nullptr)
                continue;
            if (runtime_progress_expired(now, tasks[i].completedMs.load(), true)) {
                retained_restart_task = static_cast<std::uint32_t>(i);
                retained_restart_marker = kRestartMarker;
                ESP_LOGE(kTag, "%s stopped completing iterations; restarting", kTaskNames[i]);
                esp_restart();
            }
        }
        runtime_task_heartbeat();
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Enable a five-second panic watchdog and an independent progress monitor.
 * @return ESP_OK or an SDK/task-allocation error; call before starting critical workers.
 * @note The monitor restarts ESP after a critical worker stops completing iterations for six
 * seconds, including when that worker could not subscribe to the hardware task watchdog.
 * @endcond
 */
esp_err_t runtime_supervisor_init()
{
    runtime_task_observe(RuntimeTask::Main);
    if (esp_reset_reason() == ESP_RST_SW && retained_restart_marker == kRestartMarker
        && retained_restart_task < kTaskCount)
        last_supervisor_restart = kTaskNames[retained_restart_task];
    retained_restart_marker = 0;
    esp_task_wdt_config_t config{};
    config.timeout_ms = kRuntimeWatchdogTimeoutMs;
    config.idle_core_mask = (1U << portNUM_PROCESSORS) - 1U;
    config.trigger_panic = true;
    auto result = esp_task_wdt_reconfigure(&config);
    if (result == ESP_ERR_INVALID_STATE)
        result = esp_task_wdt_init(&config);
    watchdog_error.store(result);
    watchdog_ready.store(result == ESP_OK);
    if (result != ESP_OK)
        return result;
    if (xTaskCreate(monitor, "fcplcn_supervisor", 3072, nullptr, 6, nullptr) != pdPASS)
        return ESP_ERR_NO_MEM;
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Register the calling persistent task and subscribe it to the task watchdog.
 * @param[in] task Diagnostic identity belonging to the calling task.
 * @return ESP_OK, INVALID_ARG, or the watchdog registration error retained in diagnostics.
 * @note Call once from the worker itself. Even failed subscription retains software progress
 * monitoring for I/O and controllers; continue the local loop and report the error.
 * @endcond
 */
esp_err_t runtime_task_start(RuntimeTask task)
{
    const auto index = static_cast<std::size_t>(task);
    if (index >= tasks.size())
        return ESP_ERR_INVALID_ARG;
    runtime_task_observe(task);
    auto& state = tasks[index];
    state.requested.store(true);
    const auto current = xTaskGetCurrentTaskHandle();
    const auto result = esp_task_wdt_status(current) == ESP_OK ? ESP_OK : esp_task_wdt_add(current);
    state.error.store(result);
    state.subscribed.store(result == ESP_OK);
    if (result != ESP_OK) {
        runtime_supervisor_record_error(kTaskNames[index], result);
        ESP_LOGW(
            kTag, "%s task watchdog registration: %s", kTaskNames[index], esp_err_to_name(result));
    }
    return result;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Record completion of one iteration and feed this task's watchdog subscription.
 * @note Call from the monitored worker after useful work, never from another task or a timer
 * on its behalf. Native test builds intentionally provide a no-op hook.
 * @endcond
 */
void runtime_task_heartbeat()
{
    const auto current = xTaskGetCurrentTaskHandle();
    for (auto& state : tasks) {
        if (state.handle.load() != current)
            continue;
        state.completedMs.store(static_cast<std::uint32_t>(esp_timer_get_time() / 1000));
        state.madeProgress.store(true);
        if (state.subscribed.load()) {
            const auto result = esp_task_wdt_reset();
            if (result != ESP_OK) {
                state.error.store(result);
                state.subscribed.store(false);
            }
        }
        return;
    }
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Register the calling persistent task for stack diagnostics without watching its period.
 * @param[in] task Diagnostic identity for a task that remains alive throughout device runtime.
 * @note Never register a temporary task: its handle must remain valid for stack sampling.
 * @endcond
 */
void runtime_task_observe(RuntimeTask task)
{
    const auto index = static_cast<std::size_t>(task);
    if (index >= tasks.size())
        return;
    tasks[index].completedMs.store(static_cast<std::uint32_t>(esp_timer_get_time() / 1000));
    tasks[index].handle.store(xTaskGetCurrentTaskHandle());
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Retain one startup/service failure without aborting or erasing settings.
 * @param[in] stage Static process-lifetime stage label; no credentials or user data.
 * @param[in] error ESP-IDF error code; ESP_OK is ignored.
 * @note Thread-safe. Up to twelve distinct startup stages are retained.
 * @endcond
 */
void runtime_supervisor_record_error(const char* stage, esp_err_t error)
{
    if (stage == nullptr || error == ESP_OK)
        return;
    degraded.store(true);
    std::lock_guard<std::mutex> lock(startup_mutex);
    for (auto& entry : startup_errors) {
        if (entry.stage == nullptr || entry.stage == stage) {
            entry = {stage, error};
            return;
        }
    }
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Check whether any startup/service failure has been retained.
 * @return True when startup diagnostics contain an error.
 * @endcond
 */
bool runtime_supervisor_degraded()
{
    return degraded.load();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Verify that both critical workers completed an iteration under running supervision.
 * @return True after both live critical tasks demonstrate progress and supervision is available.
 * @note Optional network/sensor failures do not by themselves block OTA acceptance.
 * @endcond
 */
bool runtime_supervisor_control_ready()
{
    const auto& io = tasks[static_cast<std::size_t>(RuntimeTask::Io)];
    const auto& controllers = tasks[static_cast<std::size_t>(RuntimeTask::Controllers)];
    return runtime_control_progress_ready(watchdog_ready.load(),
                                          monitor_ready.load(),
                                          io.handle.load() != nullptr && io.madeProgress.load(),
                                          controllers.handle.load() != nullptr
                                              && controllers.madeProgress.load());
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Build task stack/progress, watchdog and startup diagnostics.
 * @return Owned JSON object, or nullptr on allocation failure; delete with cJSON_Delete.
 * @note Registered handles refer only to process-lifetime tasks. ESP-IDF reports stack high
 * water marks in bytes. No module or hardware lock is taken while sampling task stacks.
 * @endcond
 */
cJSON* runtime_supervisor_json()
{
    using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
    Json owner(cJSON_CreateObject(), cJSON_Delete);
    auto* result = owner.get();
    if (result == nullptr)
        return nullptr;
    cJSON_AddBoolToObject(result, "startupDegraded", degraded.load());
    cJSON_AddBoolToObject(result, "criticalTasksReady", runtime_supervisor_control_ready());
    cJSON_AddBoolToObject(result, "watchdogReady", watchdog_ready.load());
    cJSON_AddNumberToObject(result, "watchdogTimeoutMs", kRuntimeWatchdogTimeoutMs);
    cJSON_AddBoolToObject(result, "fallbackMonitorReady", monitor_ready.load());
    cJSON_AddStringToObject(result, "watchdogInitError", esp_err_to_name(watchdog_error.load()));
    if (last_supervisor_restart)
        cJSON_AddStringToObject(result, "lastSupervisorRestartTask", last_supervisor_restart);
    else
        cJSON_AddNullToObject(result, "lastSupervisorRestartTask");
    auto* errors = cJSON_AddArrayToObject(result, "startupErrors");
    if (errors == nullptr)
        return nullptr;
    {
        std::lock_guard<std::mutex> lock(startup_mutex);
        for (const auto& entry : startup_errors) {
            if (entry.stage == nullptr)
                continue;
            Json item(cJSON_CreateObject(), cJSON_Delete);
            if (!item || !cJSON_AddStringToObject(item.get(), "stage", entry.stage)
                || !cJSON_AddStringToObject(item.get(), "error", esp_err_to_name(entry.error))
                || !cJSON_AddItemToArray(errors, item.get()))
                return nullptr;
            item.release();
        }
    }
    auto* list = cJSON_AddArrayToObject(result, "tasks");
    if (list == nullptr)
        return nullptr;
    const auto now = static_cast<std::uint32_t>(esp_timer_get_time() / 1000);
    for (std::size_t i = 0; i < tasks.size(); ++i) {
        const auto handle = tasks[i].handle.load();
        Json item_owner(cJSON_CreateObject(), cJSON_Delete);
        auto* item = item_owner.get();
        if (item == nullptr)
            return nullptr;
        cJSON_AddStringToObject(item, "id", kTaskNames[i]);
        cJSON_AddBoolToObject(item, "running", handle != nullptr);
        cJSON_AddBoolToObject(item, "completedIteration", tasks[i].madeProgress.load());
        cJSON_AddBoolToObject(item, "watchdogRequested", tasks[i].requested.load());
        cJSON_AddBoolToObject(item, "watchdogSubscribed", tasks[i].subscribed.load());
        if (handle != nullptr) {
            cJSON_AddNumberToObject(
                item, "stackHighWaterMarkBytes", uxTaskGetStackHighWaterMark(handle));
            const auto elapsed = static_cast<std::uint32_t>(now - tasks[i].completedMs.load());
            cJSON_AddNumberToObject(item, "heartbeatAgeMs", elapsed);
        } else {
            cJSON_AddNullToObject(item, "stackHighWaterMarkBytes");
            cJSON_AddNullToObject(item, "heartbeatAgeMs");
        }
        if (tasks[i].requested.load())
            cJSON_AddStringToObject(item, "watchdogError", esp_err_to_name(tasks[i].error.load()));
        else
            cJSON_AddNullToObject(item, "watchdogError");
        if (!cJSON_AddItemToArray(list, item))
            return nullptr;
        item_owner.release();
    }
    return owner.release();
}
