/**
 * @file ibutton.cpp
 * @brief CRC-checked iButton discovery and one-event-per-touch reader state machine.
 */
#include "sensors/ibutton.h"

#include <algorithm>
#include <limits>
#include <mutex>

#include "esp_timer.h"
#include "hardware/board_profile.h"
#include "hardware/meteo_codec.h"
#include "hardware/sensor_ports.h"
#include "sensors/sensor_worker.h"

namespace {
constexpr std::int64_t kPollMs = 100;
constexpr std::int64_t kFreshMs = 1500;
constexpr std::int64_t kScanRefreshMs = 2000;
constexpr unsigned kReleaseSamples = 2;
constexpr unsigned kPressSamples = 2;

/** @brief Discovery cache and pending work for one board sensor pin. */
struct ScanState {
    std::string portId;
    int gpio{};
    bool requested = false;
    std::uint64_t generation = 0;
    IbuttonScanSnapshot snapshot;
};

/** @brief One immutable reader/discovery job reserved before releasing the cache mutex. */
struct Job {
    std::string portId;
    int gpio{};
    bool discovery = false;
    std::uint64_t generation = 0;
};

std::mutex mutex;
std::string reader_port;
IbuttonReading reading;
std::vector<ScanState> scans;
std::int64_t next_poll_ms = 0;
unsigned empty_samples = 0;
unsigned press_samples = 0;
bool ready_for_touch = false;
std::string candidate;
bool discovery_turn = false;

/**
 * @brief Invalidate queued and in-flight discoveries after pin ownership changes.
 * @pre The caller holds mutex; runtime reader observations and event counters remain intact.
 */
void cancel_scans_locked()
{
    for (auto& scan : scans) {
        ++scan.generation;
        scan.requested = false;
        scan.snapshot = {};
    }
}

/**
 * @brief Read monotonic uptime for reader scheduling and sample freshness.
 * @return ESP uptime in whole milliseconds, independent of adjustable RTC time.
 */
std::int64_t now_ms()
{
    return esp_timer_get_time() / 1000;
}

/**
 * @brief Resolve an authorized semantic port to its immutable board wiring.
 * @param[in] id Requested sensor-port name.
 * @return Borrowed profile entry, or nullptr for an unknown sensor port.
 */
const BoardSensorPort* find_port(std::string_view id)
{
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.sensorPortCount; ++i)
        if (id == board.sensorPorts[i].name)
            return &board.sensorPorts[i];
    return nullptr;
}

/**
 * @brief Reserve a due physical reader poll or one queued discovery.
 * @param[out] job Complete GPIO/configuration snapshot when work exists.
 * @return True when a bounded job was reserved.
 * @pre The caller holds mutex; only the shared acquisition worker executes jobs.
 */
bool reserve(Job& job)
{
    const auto now = now_ms();
    const auto scan = std::find_if(scans.begin(), scans.end(), [](const auto& entry) {
        return entry.requested;
    });
    if (discovery_turn && scan != scans.end()) {
        scan->requested = false;
        discovery_turn = false;
        job = {scan->portId, scan->gpio, true, scan->generation};
        return true;
    }
    if (!reader_port.empty() && now >= next_poll_ms) {
        const auto* port = find_port(reader_port);
        if (port) {
            job = {reader_port, port->gpio, false, reading.generation};
            next_poll_ms = now + kPollMs;
            discovery_turn = true;
            return true;
        }
    }
    if (scan != scans.end()) {
        scan->requested = false;
        discovery_turn = false;
        job = {scan->portId, scan->gpio, true, scan->generation};
        return true;
    }
    return false;
}

/**
 * @brief Publish one observation without synthesizing a touch from a held/startup key.
 * @param[in] observed Complete bus result for the current reader binding.
 * @pre Hold mutex and reject observations from previous binding generations first.
 */
void publish(const IbuttonObservation& observed)
{
    reading.available = observed.available;
    reading.present = observed.available && observed.present;
    reading.addresses = observed.addresses;
    reading.updatedAtMs = now_ms();
    reading.error = observed.error;
    if (!observed.available) {
        // Transport/CRC faults never count as removal and require a new healthy release.
        ready_for_touch = false;
        empty_samples = press_samples = 0;
        candidate.clear();
        return;
    }
    if (!observed.present) {
        press_samples = 0;
        candidate.clear();
        if (empty_samples < kReleaseSamples)
            ++empty_samples;
        if (empty_samples >= kReleaseSamples)
            ready_for_touch = true;
        return;
    }
    empty_samples = 0;
    if (!ready_for_touch)
        return;
    if (observed.addresses.size() != 1) {
        // One physical probe must identify exactly one supported key, never pick an arbitrary ROM.
        ready_for_touch = false;
        press_samples = 0;
        candidate.clear();
        reading.error = observed.addresses.empty() ? "Поднесён неподдерживаемый iButton"
                                                   : "Приложите только один iButton";
        return;
    }
    if (candidate != observed.addresses.front()) {
        candidate = observed.addresses.front();
        press_samples = 1;
        return;
    }
    if (++press_samples < kPressSamples)
        return;
    ready_for_touch = false;
    if (reading.eventSequence == std::numeric_limits<std::uint64_t>::max()) {
        reading.available = false;
        reading.error = "Исчерпан счётчик событий iButton";
        return;
    }
    ++reading.eventSequence;
    reading.eventAddress = candidate;
    reading.eventAtMs = now_ms();
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Start the shared sensor acquisition worker, idempotently.
 * @return ESP_OK or the shared acquisition worker initialization error.
 * @endcond
 */
esp_err_t ibutton_init()
{
    return sensor_worker_init();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Replace the reader binding without performing bus I/O.
 * @param[in] portId Profile sensor port, or an empty value to disable polling.
 * @return ESP_OK, unknown-port error or worker initialization error.
 * @endcond
 */
esp_err_t ibutton_configure(std::string_view portId)
{
    if (!portId.empty() && !find_port(portId))
        return ESP_ERR_NOT_FOUND;
    const auto initialized = ibutton_init();
    if (initialized != ESP_OK)
        return initialized;
    std::lock_guard<std::mutex> lock(mutex);
    if (reader_port == portId)
        return ESP_OK;
    reader_port = portId;
    cancel_scans_locked();
    ++reading.generation;
    reading.available = false;
    reading.present = false;
    reading.addresses.clear();
    reading.updatedAtMs = -1;
    reading.eventAddress.clear();
    reading.eventAtMs = -1;
    reading.error =
        portId.empty() ? "Считыватель iButton выключен" : "Ожидание считывателя iButton";
    next_poll_ms = 0;
    empty_samples = press_samples = 0;
    ready_for_touch = false;
    candidate.clear();
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy reader health and the last complete touch event.
 * @return Owned snapshot with stale and disabled data marked unavailable.
 * @endcond
 */
IbuttonReading ibutton_read()
{
    std::lock_guard<std::mutex> lock(mutex);
    auto result = reading;
    if (reader_port.empty()) {
        result.available = false;
        result.error = "Считыватель iButton не назначен";
    } else if (result.updatedAtMs < 0 || now_ms() < result.updatedAtMs
               || now_ms() - result.updatedAtMs > kFreshMs) {
        result.available = false;
        result.error = "Нет свежих данных считывателя iButton";
    }
    return result;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Queue or poll discovery without performing GPIO work or generating touch events.
 * @param[in] portId Controller-authorized profile sensor port.
 * @param[in] refresh Request another search after the two-second refresh limit.
 * @param[out] snapshot Current queued/running/completed attempt.
 * @return ESP_OK, unknown-port error or worker initialization error.
 * @endcond
 */
esp_err_t ibutton_request_scan(std::string_view portId, bool refresh, IbuttonScanSnapshot& snapshot)
{
    const auto* port = find_port(portId);
    if (!port)
        return ESP_ERR_NOT_FOUND;
    const auto initialized = ibutton_init();
    if (initialized != ESP_OK)
        return initialized;
    std::lock_guard<std::mutex> lock(mutex);
    auto scan = std::find_if(scans.begin(), scans.end(), [&](const auto& entry) {
        return entry.portId == portId;
    });
    if (scan == scans.end()) {
        scans.push_back({std::string(portId), port->gpio, false, 0, {}});
        scan = scans.end() - 1;
    }
    if (!scan->snapshot.busy
        && (!scan->snapshot.complete
            || (refresh
                && (scan->snapshot.updatedAtMs < 0
                    || now_ms() - scan->snapshot.updatedAtMs >= kScanRefreshMs)))) {
        scan->requested = true;
        scan->snapshot.busy = true;
        scan->snapshot.complete = false;
        scan->snapshot.error.clear();
    }
    snapshot = scan->snapshot;
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate a serial-number iButton ROM in family-first wire order.
 * @param[in] text Sixteen hex characters, accepting uppercase input.
 * @param[out] bytes Wire-order bytes assigned only on success.
 * @return True only for family 01 and the correct Dallas ROM CRC.
 * @endcond
 */
bool ibutton_parse_address(std::string_view text, std::array<std::uint8_t, 8>& bytes)
{
    return onewire_parse_address(text, 0x01, bytes);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Execute one due reader poll or queued discovery on the shared worker.
 * @return True when a bounded job ran; false when no reader work is due.
 * @endcond
 */
bool ibutton_worker_step()
{
    Job job;
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (!reserve(job))
            return false;
    }
    const auto observed = sensor_port_observe_ibutton(job.gpio);
    std::lock_guard<std::mutex> lock(mutex);
    if (job.discovery) {
        const auto scan = std::find_if(scans.begin(), scans.end(), [&](const auto& entry) {
            return entry.portId == job.portId;
        });
        if (scan != scans.end() && scan->generation == job.generation) {
            scan->snapshot.busy = false;
            scan->snapshot.complete = true;
            scan->snapshot.updatedAtMs = now_ms();
            scan->snapshot.error = observed.error;
            if (observed.available)
                scan->snapshot.addresses = observed.addresses;
        }
    } else if (job.generation == reading.generation && job.portId == reader_port)
        publish(observed);
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Cancel queued searches and invalidate in-flight discovery publication.
 * @note Does not change the reader binding, current presence or touch event sequence.
 * @endcond
 */
void ibutton_cancel_scans()
{
    std::lock_guard<std::mutex> lock(mutex);
    cancel_scans_locked();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Suppress pending/held key authorization until two healthy empty polls occur.
 * @note Advances the reader generation without changing the configured pin or scan jobs.
 * @endcond
 */
void ibutton_require_release()
{
    std::lock_guard<std::mutex> lock(mutex);
    ++reading.generation;
    ready_for_touch = false;
    empty_samples = press_samples = 0;
    candidate.clear();
    reading.eventAddress.clear();
    reading.eventAtMs = -1;
    next_poll_ms = 0;
}
