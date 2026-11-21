/**
 * @file controller_switches.cpp
 * @brief Autonomous button sampling, switch restoration and worker scheduling.
 */
#include "controllers/controller_internal.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <vector>

#include "hardware/board_profile.h"
#include "cJSON.h"
#include "hardware/hardware_io.h"
#include "sensors/meteo_sensors.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "config/settings_json.h"
#include "config/model.h"
#include "system/runtime_supervisor.h"
#include "util/checksum.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {

/**
 * @brief Read fresh physical snapshots for a switch row on the active board.
 * @param[in] config Owning module configuration.
 * @param[in] item Relay binding and optional button input.
 * @return Relay/input snapshots with readiness flags; an absent optional input is ready.
 * @note Hardware reads use their own lock; a mismatched board leaves the relay unavailable.
 */
Observation observe(const Configuration& config, const Item& item)
{
    Observation observation;
    if (config.boardId != board_profile_active().id)
        return observation;
    observation.relayReady = hardware_io_read_relay(item.relayId, observation.relay) == ESP_OK
                             && observation.relay.valid && observation.relay.fresh;
    if (!item.inputId.empty())
        observation.inputReady = hardware_io_read_input(item.inputId, observation.input) == ESP_OK
                                 && observation.input.valid && observation.input.fresh;
    return observation;
}

/**
 * @brief Return a common unavailable result with a caller-visible diagnostic.
 * @param[out] error Replaced failure text.
 * @param[in] message Borrowed diagnostic copied into error.
 * @return SocketResult::Unavailable.
 */
SocketResult unavailable(std::string& error, const char* message)
{
    error = message;
    return SocketResult::Unavailable;
}

/**
 * @brief Report that a command missed its monotonic delivery deadline.
 * @param[out] error Replaced deadline-expired diagnostic.
 * @return SocketResult::Conflict; no hardware or storage access is performed.
 */
SocketResult expired(std::string& error)
{
    error = "Истёк срок выполнения команды";
    return SocketResult::Conflict;
}

/**
 * @brief Test an optional absolute ESP uptime deadline in microseconds.
 * @param[in] deadlineUs Nonzero absolute deadline; zero means unlimited delivery time.
 * @return True when the current monotonic time has reached or passed the deadline.
 */
bool deadline_expired(std::int64_t deadlineUs)
{
    return !operation_permitted() || (deadlineUs != 0 && esp_timer_get_time() >= deadlineUs);
}

/**
 * @brief Execute a serialized static-switch transaction while the controller lock is held.
 * @details Order: fresh observation, deadline-aware write/readback, FRAM journal
 * commit, then RAM/ACK. Failure retains the last durable state and requests its
 * physical rollback. The hardware service never queues a failed new ON.
 * @param[in] kind Static-switch module (Sockets or Lights).
 * @param[in] item_index Existing row index in that module and its runtime vector.
 * @param[in] on Requested confirmed logical relay state.
 * @param[out] error Failure diagnostic, cleared on success.
 * @param[in] deadlineUs Optional absolute uptime delivery deadline in microseconds; zero is
 * unlimited.
 * @return Command confirmation or disabled/unavailable/expiry/storage failure.
 * @pre The caller holds controller_mutex and an outer settings write guard.
 */
SocketResult set_state_locked(ControllerKind kind,
                              std::size_t item_index,
                              bool on,
                              std::string& error,
                              std::int64_t deadlineUs)
{
    if (deadline_expired(deadlineUs))
        return expired(error);
    const auto module = index(kind);
    auto& config = configurations[module];
    auto& item = config.items[item_index];
    auto& transient = runtimes[module][item_index];
    if (!config.enabled) {
        error = "Модуль выключен";
        return SocketResult::Disabled;
    }
    if (worker_error != ESP_OK || config.boardId != board_profile_active().id)
        return unavailable(error, "Контроллер недоступен для активной платы");
    const auto observation = observe(config, item);
    if (deadline_expired(deadlineUs))
        return expired(error);
    if (!observation.relayReady)
        return unavailable(error, "Нет свежих данных назначенного реле");
    const bool previous = item.state;
    if (deadline_expired(deadlineUs))
        return expired(error);
    if (observation.relay.value != on) {
        const auto result = deadlineUs != 0
                                ? hardware_io_set_relay_until(item.relayId, on, deadlineUs)
                                : hardware_io_set_relay(item.relayId, on);
        if (deadlineUs != 0 && result == ESP_ERR_TIMEOUT)
            return expired(error);
        if (result != ESP_OK) {
            transient.error = "Реле не подтвердило новое состояние";
            transient.lastAttemptUs = -1;
            return unavailable(error, transient.error.c_str());
        }
    }
    if (previous == on && state_storage_healthy()) {
        transient.error.clear();
        error.clear();
        return SocketResult::Ok;
    }
    Configurations next = configurations;
    next[module].items[item_index].state = on;
    if (save_states(next) != ESP_OK) {
        // Physical readback precedes persistence; RAM/ACK follows persistence.
        // Failed persistence rolls hardware back to the last durable state.
        hardware_io_set_relay(item.relayId, previous);
        transient.error = "Не удалось сохранить состояние во FRAM";
        transient.lastAttemptUs = -1;
        error = transient.error;
        return SocketResult::StorageError;
    }
    item.state = on;
    transient.error.clear();
    error.clear();
    return SocketResult::Ok;
}

/**
 * @brief Establish input generation and release state without synthesizing a button press.
 * @param[in,out] transient Row debounce state to reset from this observation.
 * @param[in] input Valid fresh physical input snapshot.
 * @note A boot/recovery LOW stays disarmed; only an observed released HIGH can arm a later press.
 */
void baseline(Runtime& transient, const HardwareIoChannelState& input)
{
    transient.baseline = true;
    // The board's optocoupler input has an external pull-up: released=HIGH,
    // pressed=LOW. A LOW at boot/recovery is never interpreted as a press.
    transient.armed = input.value;
    transient.lowSamples = 0;
    transient.highSinceUs = input.value ? input.updatedAtUs : -1;
    transient.lockoutUntilUs = 0;
    transient.lastInputUs = input.updatedAtUs;
    transient.inputGeneration = input.generation;
}

/**
 * @brief Consume exactly one active-low press from distinct fresh input samples.
 * @details First/recovered LOW is only a baseline. An armed HIGH->LOW toggles
 * after three consecutive distinct LOW observations, then locks out for 300 ms.
 * Rearming requires released HIGH over
 * at least two observations and 50 ms. A failed action still consumes the press;
 * held LOW and release never repeat it. Shared by switches and thermostat flags.
 * @param[in,out] transient Row debounce state updated even when a press is rejected or consumed.
 * @param[in] input Valid fresh input observation, including its acquisition timestamp and
 * generation.
 * @return True only once after three distinct LOW samples outside the lockout period.
 * @pre The caller serializes access to transient and has rejected unavailable input snapshots.
 */
bool button_press(Runtime& transient, const HardwareIoChannelState& input)
{
    if (!transient.baseline || transient.inputGeneration != input.generation
        || input.updatedAtUs < transient.lastInputUs) {
        baseline(transient, input);
        return false;
    }
    if (input.updatedAtUs <= transient.lastInputUs)
        return false;
    transient.lastInputUs = input.updatedAtUs;
    const auto now = esp_timer_get_time();
    if (input.value) {
        transient.lowSamples = 0;
        if (!transient.armed) {
            if (transient.highSinceUs < 0)
                transient.highSinceUs = input.updatedAtUs;
            else if (now >= transient.lockoutUntilUs
                     && input.updatedAtUs - transient.highSinceUs >= kDebounceUs)
                transient.armed = true;
        }
        return false;
    }
    transient.highSinceUs = -1;
    if (!transient.armed || now < transient.lockoutUntilUs) {
        transient.lowSamples = 0;
        return false;
    }
    if (++transient.lowSamples < kPressConfirmSamples)
        return false;
    transient.lowSamples = 0;
    transient.armed = false;
    transient.lockoutUntilUs = now + kPressLockoutUs;
    return true;
}

/**
 * @brief Advance saved switches, button edges and autonomous thermostats once.
 * @details Enters the settings writer gate before controller_mutex. Relay recovery resets button
 * baselines and retries are bounded. After a staged import only thermostat safety OFF is
 * requested; the durable imported bundle is never overwritten by this worker.
 * @note Called by the dedicated worker and the host-test hook; networking is not required.
 */
void worker_step()
{
    SettingsWriteGuard mutation;
    if (!mutation) {
        if (settings_restore_pending()) {
            std::lock_guard<std::mutex> lock(controller_mutex);
            const auto module = index(ControllerKind::Thermostats);
            const auto& config = configurations[module];
            if (!initialized || config.boardId != board_profile_active().id)
                return;
            // The staged bundle must not be overwritten. Only a safety OFF is
            // allowed before reboot; switches stay frozen and no NVS is used.
            for (std::size_t i = 0; i < config.items.size(); ++i) {
                auto& runtime = runtimes[module][i];
                runtime.thermostatDemand = false;
                runtime.sensorHealthy = false;
                runtime.error = "Импорт сохранён: безопасный OFF до перезагрузки";
                HardwareIoChannelState relay;
                if (hardware_io_read_relay(config.items[i].relayId, relay) != ESP_OK || !relay.valid
                    || !relay.fresh || relay.value) {
                    if (hardware_io_set_relay(config.items[i].relayId, false) != ESP_OK)
                        runtime.error += "; выключение не подтверждено";
                }
            }
        }
        return;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (!initialized || worker_error != ESP_OK)
        return;
    for (std::size_t module = 0; module < kRelayControllerCount; ++module) {
        auto& config = configurations[module];
        auto& runtime = runtimes[module];
        if (config.boardId != board_profile_active().id)
            continue;
        for (std::size_t i = 0; i < config.items.size(); ++i) {
            auto& item = config.items[i];
            auto& transient = runtime[i];
            auto observation = observe(config, item);
            if (!observation.relayReady) {
                transient.baseline = false;
                transient.lastAttemptUs = -1;
                continue;
            }
            if (!transient.seenRelay || transient.relayGeneration != observation.relay.generation) {
                transient.baseline = false;
                transient.seenRelay = true;
                transient.relayGeneration = observation.relay.generation;
                transient.lastAttemptUs = -1;
            }
            const auto now = esp_timer_get_time();
            if (observation.relay.value != item.state) {
                transient.baseline = false;
                if (transient.lastAttemptUs < 0 || now - transient.lastAttemptUs >= kRetryUs) {
                    transient.lastAttemptUs = now;
                    if (hardware_io_set_relay(item.relayId, item.state) != ESP_OK) {
                        transient.error = "Реле не подтвердило сохранённое состояние";
                        continue;
                    }
                    observation = observe(config, item);
                }
                if (!observation.relayReady || observation.relay.value != item.state)
                    continue;
            }
            // Conflicting legacy inputs retain config/state but must not toggle
            // multiple consumers. Relay/manual restoration remains available.
            if (!config.enabled || item.inputId.empty() || !observation.inputReady
                || claim_count(configurations, ResourceKind::Input, item.inputId) > 1) {
                transient.baseline = false;
                continue;
            }
            if (!button_press(transient, observation.input))
                continue;
            std::string error;
            set_state_locked(static_cast<ControllerKind>(module), i, !item.state, error);
        }
    }
    thermostats_step_locked();
    security_step_locked();
}

/**
 * @brief Run autonomous controller steps in the dedicated FreeRTOS task.
 * @note The unused FreeRTOS task argument is ignored. Each step is followed by a 20 ms delay;
 * I/O and storage work occur in this task rather than the HTTP or MQTT callback.
 */
void worker(void*)
{
    const auto watchdog = runtime_task_start(RuntimeTask::Controllers);
    if (watchdog != ESP_OK)
        ESP_LOGW(kTag, "Controller watchdog registration failed: %s", esp_err_to_name(watchdog));
    while (true) {
        worker_step();
        runtime_task_heartbeat();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

/**
 * @brief Request previous relay levels for already-applied static-switch changes.
 * @param[in,out] changes Transaction journal, traversed in reverse application order.
 * @note Rollback is best effort; hardware failures are not converted into a confirmed physical
 * state. The caller retains the previous durable configuration and reports the transaction failure.
 */
void rollback(std::vector<RelayChange>& changes)
{
    for (auto it = changes.rbegin(); it != changes.rend(); ++it) {
        if (it->changed)
            hardware_io_set_relay(it->id, it->previous);
    }
}

/**
 * @brief Push immutable-per-claim recovery metadata after init or a config commit.
 * @details Thermostat relays remain Controller-owned even when disabled. Their
 * OFF/reassignment is confirmed before persistence, and policy release follows
 * commit. No policy changes occur on a failed config save. Lock order stays
 * controller -> hardware; the driver never calls an owner in reverse.
 * @return ESP_OK when every active-board relay policy was applied, or the first hardware error.
 * @pre The caller holds controller_mutex and applies only committed controller bindings.
 */
esp_err_t apply_relay_recovery_policies()
{
    const auto& board = board_profile_active();
    const auto& thermostats = configurations[index(ControllerKind::Thermostats)].items;
    for (std::size_t i = 0; i < board.relayCount; ++i) {
        const auto* id = board.relays[i].name;
        const bool controlled =
            id == configurations[index(ControllerKind::Security)].security.sirenRelayId
            || std::any_of(thermostats.begin(), thermostats.end(), [&](const auto& item) {
                   return item.relayId == id;
               });
        const auto error = hardware_io_set_relay_recovery(
            id, controlled ? HardwareRelayRecovery::Controller : HardwareRelayRecovery::Buffered);
        if (error != ESP_OK)
            return error;
    }
    return ESP_OK;
}

}  // namespace fcplcn::controllers::detail

/** @endcond */
