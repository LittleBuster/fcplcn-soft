/**
 * @file meteo_sensors.cpp
 * @brief Asynchronous physical-port acquisition with generation-checked caches.
 * @details The worker schedules ports fairly and performs bus transactions outside
 * the cache mutex. Only matching generations can publish measurements.
 */
#include "sensors/meteo_sensors.h"

#include <algorithm>
#include <mutex>
#include <utility>

#include "esp_timer.h"
#include "hardware/board_profile.h"
#include "hardware/sensor_ports.h"
#include "sensors/ibutton.h"
#include "sensors/sensor_worker.h"

namespace {
constexpr std::int64_t kPollMs = 5000;
constexpr std::int64_t kDiscoveryMs = 30000;
constexpr std::int64_t kFreshMs = 15000;

/**
 * @brief Physical-port configuration, job generation and last published caches.
 * @details A port may serve several selected DS18B20 rows, but polling is done
 * once per bus. Configuration changes cancel publication from an older job.
 */
struct PortState {
    std::string id;
    int gpio{};
    bool configured = false;
    MeteoSensorType type = MeteoSensorType::Dht22;
    std::uint64_t generation = 0;
    std::int64_t nextPollMs = 0;
    std::int64_t lastScanMs = -1;
    bool scanRequested = false;
    MeteoPortReading reading;
    MeteoScanSnapshot scan;
};

struct Job {
    std::size_t index = 0;
    int gpio{};
    MeteoSensorType type{};
    std::uint64_t generation = 0;
    bool discover = false;
    std::vector<MeteoDeviceReading> devices;
};

std::mutex sensor_mutex;
std::vector<PortState> ports;
bool enabled = false;
std::size_t cursor = 0;

/**
 * @brief Read the monotonic clock used by sensor scheduling and freshness.
 * @return ESP timer uptime in whole milliseconds; unrelated to adjustable wall time.
 */
std::int64_t now_ms()
{
    return esp_timer_get_time() / 1000;
}

/**
 * @brief Merge DS18B20 samples into this job's snapshot of the readings.
 * @param[in] job Immutable snapshot of the pin, discovery request and prior readings.
 * @param waitForConversion Scheduler callback for the interval with the bus closed.
 * @param[out] discoveryComplete True when a requested discovery completed.
 * @param[out] scanError Bus initialization or discovery diagnostic.
 * @return Owned reading preserving the last successful value for failed measurements.
 */
MeteoPortReading read_onewire(const Job& job,
                              void (*waitForConversion)(std::int64_t),
                              bool& discoveryComplete,
                              std::string& scanError)
{
    std::vector<std::string> addresses;
    addresses.reserve(job.devices.size());
    for (const auto& device : job.devices) {
        addresses.push_back(device.address);
    }
    auto poll =
        sensor_port_poll_ds18b20(job.gpio, job.discover, std::move(addresses), waitForConversion);
    discoveryComplete = poll.discoveryComplete;
    scanError = std::move(poll.discoveryError);

    MeteoPortReading reading;
    reading.error = std::move(poll.error);
    reading.devices.reserve(poll.samples.size());
    for (auto& sample : poll.samples) {
        MeteoDeviceReading device;
        device.address = std::move(sample.address);
        device.error = std::move(sample.error);
        device.available = sample.sampledAtMs >= 0;
        if (device.available) {
            reading.available = true;
            device.lastSuccessMs = sample.sampledAtMs;
            device.temperatureC = sample.temperatureC;
        } else {
            const auto previous =
                std::find_if(job.devices.begin(), job.devices.end(), [&](const auto& entry) {
                    return entry.address == device.address;
                });
            if (previous != job.devices.end()) {
                device.lastSuccessMs = previous->lastSuccessMs;
                device.temperatureC = previous->temperatureC;
            }
        }
        reading.devices.push_back(std::move(device));
    }
    return reading;
}

/**
 * @brief Collect a DHT22 sample in the common cache format.
 * @param gpio Exclusively owned sensor-port pin.
 * @return Owned cache data or a hardware diagnostic.
 */
MeteoPortReading read_dht(int gpio)
{
    auto sample = sensor_port_read_dht22(gpio);
    MeteoPortReading reading;
    reading.available = sample.sampledAtMs >= 0;
    reading.temperatureC = sample.temperatureC;
    reading.humidityPct = sample.humidityPct;
    reading.lastSuccessMs = sample.sampledAtMs;
    reading.error = std::move(sample.error);
    return reading;
}

/**
 * @brief Reserve the next explicit scan or due periodic poll in round-robin order.
 * @param[out] job Owned immutable binding/generation/device snapshot when work is found.
 * @return True when a port was scheduled; false when no port currently needs work.
 * @note Acquires sensor_mutex, clears the selected request and advances its poll deadline.
 */
bool next_job(Job& job)
{
    std::lock_guard<std::mutex> lock(sensor_mutex);
    const auto now = now_ms();
    // Fair round-robin scheduling: repeated scans cannot starve another port.
    for (std::size_t offset = 0; offset < ports.size(); ++offset) {
        const auto index = (cursor + offset) % ports.size();
        auto& port = ports[index];
        const bool poll = enabled && port.configured && now >= port.nextPollMs;
        if (!port.scanRequested && !poll)
            continue;
        job.index = index;
        job.gpio = port.gpio;
        job.generation = port.generation;
        job.type = port.scanRequested ? MeteoSensorType::OneWire : port.type;
        job.discover =
            port.scanRequested || port.lastScanMs < 0 || now - port.lastScanMs >= kDiscoveryMs;
        job.devices = port.scan.devices;
        port.scanRequested = false;
        if (job.type == MeteoSensorType::OneWire && job.discover)
            port.scan.busy = true;
        port.nextPollMs = now + kPollMs;
        cursor = (index + 1) % ports.size();
        return true;
    }
    return false;
}

/**
 * @brief Locate a profile sensor port in the fixed initialized cache.
 * @param[in] id Borrowed semantic sensor-port identifier.
 * @return Iterator into ports, or ports.end() for an unknown name.
 * @pre Hold sensor_mutex when caches may be accessed concurrently.
 */
auto find_port(std::string_view id)
{
    return std::find_if(ports.begin(), ports.end(), [&](const auto& port) {
        return port.id == id;
    });
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Execute one fair queued job with I/O outside the sensor cache lock.
 * @param waitForConversion Scheduler callback used after releasing the RMT bus.
 * @return True when a reserved job ran, even if its generation changed before publication.
 * @note Called by one acquisition worker, or synchronously by the host-test adapter.
 * @details Only a matching generation may publish results. Explicit OneWire
 * probing of a DHT-owned port updates scan results, never its saved DHT reading.
 * @endcond
 */
bool meteo_worker_step(void (*waitForConversion)(std::int64_t))
{
    Job job;
    if (!next_job(job))
        return false;
    bool complete = false;
    std::string scanError;
    auto reading = job.type == MeteoSensorType::Dht22
                       ? read_dht(job.gpio)
                       : read_onewire(job, waitForConversion, complete, scanError);
    std::lock_guard<std::mutex> lock(sensor_mutex);
    auto& port = ports[job.index];
    // Ignore in-flight readings from a binding changed while IO was running.
    if (port.generation != job.generation)
        return true;
    if (job.type == MeteoSensorType::OneWire && job.discover) {
        port.scan.busy = false;
        port.scan.complete = true;
        port.scan.error = scanError;
        if (!complete && port.scan.error.empty())
            port.scan.error = reading.error;
        port.lastScanMs = now_ms();
    }
    if (job.type == MeteoSensorType::OneWire)
        port.scan.devices = reading.devices;
    if (enabled && port.configured && port.type == job.type) {
        // Keep the last success timestamp for diagnostics, never mark a failed read valid.
        if (reading.lastSuccessMs < 0)
            reading.lastSuccessMs = port.reading.lastSuccessMs;
        port.reading = std::move(reading);
    }
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Initialize released sensor pins and start the acquisition worker once.
 * @return ESP_OK or the worker-allocation error; repeated calls return the initial result.
 * @details Call after board activation and before controller configuration is pushed.
 * @endcond
 */
esp_err_t meteo_sensors_init()
{
    return sensor_worker_init();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Set up each sensor port and its cache before the acquisition task starts.
 * @pre Called once by the shared worker startup after board-profile activation.
 * @endcond
 */
void meteo_worker_prepare()
{
    std::lock_guard<std::mutex> lock(sensor_mutex);
    const auto& board = board_profile_active();
    ports.reserve(board.sensorPortCount);
    for (std::size_t i = 0; i < board.sensorPortCount; ++i) {
        const auto& definition = board.sensorPorts[i];
        PortState port;
        port.id = definition.name;
        port.gpio = definition.gpio;
        sensor_port_release(port.gpio);
        port.reading.error = "Ожидание измерения";
        ports.push_back(std::move(port));
    }
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Replace the worker's physical-port polling configuration without waiting for I/O.
 * @param active Module master flag; explicit discovery remains available while polling is off.
 * @param configurations Borrowed, deduplicated profile ports with their selected protocols.
 * @details Binding/master changes increment a generation. Results from an older
 * in-flight job are discarded; unchanged ports keep their cached measurements.
 * @endcond
 */
void meteo_sensors_configure(bool active, const std::vector<MeteoSensorConfig>& configurations)
{
    bool changed_any = false;
    {
        std::lock_guard<std::mutex> lock(sensor_mutex);
        for (auto& port : ports) {
            const auto match =
                std::find_if(configurations.begin(), configurations.end(), [&](const auto& config) {
                    return config.portId == port.id;
                });
            const bool configured = match != configurations.end();
            const bool changed = enabled != active || configured != port.configured
                                 || (configured && port.type != match->type);
            if (changed) {
                changed_any = true;
                ++port.generation;
                port.reading = {};
                port.reading.error = active && configured ? "Ожидание измерения"
                                                          : "Метео выключен или порт не назначен";
                // A request made against an old binding must not leak into its replacement.
                port.scan.busy = false;
                port.scanRequested = false;
                if (configured && (!port.configured || port.type != match->type)) {
                    port.scan = {};
                    port.lastScanMs = -1;
                }
                port.nextPollMs = 0;
            }
            port.configured = configured;
            if (configured)
                port.type = match->type;
        }
        enabled = active;
    }
    if (changed_any)
        ibutton_cancel_scans();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy a port cache and mask failed, disabled or older-than-15-second data.
 * @param portId Profile sensor-port name.
 * @return Owned value snapshot; unknown ports and driver failure have available=false and an error.
 * @endcond
 */
MeteoPortReading meteo_sensors_read(std::string_view portId)
{
    std::lock_guard<std::mutex> lock(sensor_mutex);
    const auto port = find_port(portId);
    if (port == ports.end()) {
        MeteoPortReading result;
        result.error = "Неизвестный сенсорный порт";
        return result;
    }
    auto result = port->reading;
    const auto startup_error = sensor_worker_status();
    if (startup_error != ESP_OK) {
        result.available = false;
        result.error = std::string("Задача Метео: ") + esp_err_to_name(startup_error);
    } else if (!enabled || !port->configured) {
        result.available = false;
        result.error = "Метео выключен или порт не назначен";
    } else if (port->type == MeteoSensorType::Dht22
               && (result.lastSuccessMs < 0 || now_ms() - result.lastSuccessMs > kFreshMs)) {
        result.available = false;
        if (result.error.empty())
            result.error = "Нет свежих данных DHT22";
    }
    for (auto& device : result.devices) {
        if (!enabled || !port->configured || device.lastSuccessMs < 0
            || now_ms() - device.lastSuccessMs > kFreshMs) {
            device.available = false;
            if (device.error.empty())
                device.error = "Нет свежих данных DS18B20";
        }
    }
    if (port->type == MeteoSensorType::OneWire) {
        result.available =
            startup_error == ESP_OK && enabled && port->configured
            && std::any_of(result.devices.begin(), result.devices.end(), [](const auto& device) {
                   return device.available;
               });
        if (!result.available && result.error.empty())
            result.error = "Нет свежих данных DS18B20";
    }
    return result;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Queue or poll a bounded OneWire discovery; this call performs no bus I/O.
 * @param portId Profile sensor-port name.
 * @param refresh Request a new search, subject to the two-second refresh limit.
 * @param[out] snapshot Current job state and retained discoveries.
 * @return ESP_OK, ESP_ERR_NOT_FOUND, or the sensor worker startup error.
 * @details With refresh=false, the first request queues work and later requests
 * poll it. Owner/port compatibility authorization belongs to the controller API.
 * @endcond
 */
esp_err_t
meteo_sensors_request_scan(std::string_view portId, bool refresh, MeteoScanSnapshot& snapshot)
{
    std::lock_guard<std::mutex> lock(sensor_mutex);
    const auto port = find_port(portId);
    if (port == ports.end())
        return ESP_ERR_NOT_FOUND;
    const auto startup_error = sensor_worker_status();
    if (startup_error != ESP_OK)
        return startup_error;
    if (!port->scan.busy
        && (!port->scan.complete
            || (refresh && (port->lastScanMs < 0 || now_ms() - port->lastScanMs >= 2000)))) {
        port->scanRequested = true;
        port->scan.busy = true;
        port->scan.complete = false;
        port->scan.error.clear();
    }
    snapshot = port->scan;
    return ESP_OK;
}
