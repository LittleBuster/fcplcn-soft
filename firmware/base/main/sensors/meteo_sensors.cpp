/**
 * @file meteo_sensors.cpp
 * @brief Asynchronous physical-port acquisition with generation-checked caches.
 * @details One worker schedules ports fairly. It snapshots a job under the sensor
 * mutex, performs potentially slow protocol work without that lock, then publishes
 * only if the binding generation still matches. A short-lived RMT bus bounds
 * peripheral ownership across all OneWire ports; DHT22/OneWire pins release HIGH.
 */
#include "sensors/meteo_sensors.h"
#include "sensors/ibutton.h"
#include "system/runtime_supervisor.h"

#include "hardware/board_profile.h"
#include "sensors/meteo_codec.h"
#include "dht.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "onewire_bus.h"
#include "onewire_device.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <mutex>

namespace {
constexpr std::int64_t kPollMs = 5000;
constexpr std::int64_t kDiscoveryMs = 30000;
constexpr std::int64_t kFreshMs = 15000;
constexpr std::size_t kMaxDevices = 16;

/**
 * @brief Physical-port configuration, job generation and last published caches.
 * @details A port may serve several selected DS18B20 rows, but polling is done
 * once per bus. Configuration changes cancel publication from an older job.
 */
struct PortState {
    std::string id;
    gpio_num_t gpio{};
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
    gpio_num_t gpio{};
    MeteoSensorType type{};
    std::uint64_t generation = 0;
    bool explicitScan = false;
    bool discover = false;
    std::vector<MeteoDeviceReading> devices;
};

std::mutex sensor_mutex;
std::vector<PortState> ports;
bool enabled = false;
bool started = false;
esp_err_t startup_error = ESP_ERR_INVALID_STATE;
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
 * @brief Build a sensor-operation diagnostic with the underlying IDF error name.
 * @param[in] action Borrowed null-terminated human-readable operation label.
 * @param[in] error Driver result to append.
 * @return Owned diagnostic string.
 */
std::string failure(const char* action, esp_err_t error)
{
    return std::string(action) + ": " + esp_err_to_name(error);
}

// Both protocols and the ISO1640 isolators require releasing HIGH, never driving it.
/**
 * @brief Release the isolator-facing sensor line as floating open-drain HIGH.
 * @param[in] gpio Sensor-port pin from the active profile.
 * @note Neither protocol nor the ISO1640 path may actively drive this line HIGH.
 */
void release_pin(gpio_num_t gpio)
{
    gpio_set_level(gpio, 1);
    gpio_set_direction(gpio, GPIO_MODE_INPUT_OUTPUT_OD);
    gpio_set_pull_mode(gpio, GPIO_FLOATING);
}

/**
 * @brief RAII ownership of one transient OneWire RMT bus.
 * @details Releasing each job's bus bounds RMT usage across eight sensor ports.
 * Destruction also restores the isolator-facing pin to released open-drain HIGH.
 */
struct Bus {
    onewire_bus_handle_t handle = nullptr;
    gpio_num_t gpio;

    /**
     * @brief Bind a transient OneWire owner to a pin without allocating RMT resources.
     * @param[in] pin Sensor GPIO released by the destructor even if open() fails.
     */
    explicit Bus(gpio_num_t pin) : gpio(pin)
    {
    }

    /**
     * @brief Delete any allocated RMT bus and always release the sensor GPIO.
     */
    ~Bus()
    {
        close();
    }

    /**
     * @brief Release the RMT pair while an externally powered DS18B20 converts autonomously.
     * @note Closing a bus never drives the shared sensor line HIGH or sends a OneWire reset.
     */
    void close()
    {
        if (handle) {
            onewire_bus_del(handle);
            handle = nullptr;
        }
        release_pin(gpio);
    }

    /**
     * @brief Allocate the OneWire RMT bus for this job with the board external pull-ups.
     * @return ESP_OK or the OneWire/RMT allocation/configuration error.
     * @pre No RMT bus is currently open in this owner; close() permits reopening after conversion.
     */
    esp_err_t open()
    {
        onewire_bus_config_t config{};
        config.bus_gpio_num = gpio;
        config.flags.en_pull_up = false;  // External pull-ups are part of the board.
        onewire_bus_rmt_config_t rmt{};
        rmt.max_rx_bytes = 10;
        return onewire_new_bus_rmt(&config, &rmt, &handle);
    }
};

/**
 * @brief Reset a OneWire bus and send MATCH ROM for a validated DS18B20 address.
 * @param[in] bus Borrowed live bus used exclusively by the current sensor job.
 * @param[in] address Sixteen-character family-28 ROM string with a valid CRC.
 * @return ESP_OK, INVALID_ARG for a malformed ROM, or a protocol error.
 */
esp_err_t select_device(onewire_bus_handle_t bus, const std::string& address)
{
    std::array<std::uint8_t, 8> rom{};
    if (!meteo_parse_address(address, rom))
        return ESP_ERR_INVALID_ARG;
    auto result = onewire_bus_reset(bus);
    if (result != ESP_OK)
        return result;
    std::array<std::uint8_t, 9> command{};
    command[0] = 0x55;  // MATCH ROM
    std::copy(rom.begin(), rom.end(), command.begin() + 1);
    return onewire_bus_write_bytes(bus, command.data(), command.size());
}

/**
 * @brief Search a bounded number of ROMs and retain only family-28 CRC-valid devices.
 * @param[in] bus Exclusively owned live OneWire bus for the current job.
 * @param[in,out] devices Previous discoveries, replaced only after a completed bounded search.
 * @param[out] error Failure or truncation diagnostic; the caller supplies an initially empty
 * string.
 * @return True for completed discovery, including a sixteen-device truncation; false on
 * interruption.
 * @details Up to sixteen devices are exposed. Interrupted discovery keeps the old
 * address list as unavailable data instead of falsely erasing configured devices.
 */
bool discover(onewire_bus_handle_t bus,
              std::vector<MeteoDeviceReading>& devices,
              std::string& error)
{
    onewire_device_iter_handle_t iterator = nullptr;
    auto result = onewire_new_device_iter(bus, &iterator);
    if (result != ESP_OK) {
        error = failure("Поиск OneWire", result);
        return false;
    }
    std::vector<MeteoDeviceReading> found;
    bool complete = false;
    // Bound work even if unrelated 1-Wire families are connected to this line.
    for (unsigned visited = 0; visited < 64; ++visited) {
        onewire_device_t device{};
        result = onewire_device_iter_get_next(iterator, &device);
        if (result == ESP_ERR_NOT_FOUND) {
            complete = true;
            break;
        }
        if (result != ESP_OK) {
            error = failure("Поиск OneWire", result);
            break;
        }
        const auto address = meteo_rom_address(device.address);
        std::array<std::uint8_t, 8> bytes{};
        if (!meteo_parse_address(address, bytes))
            continue;
        if (found.size() == kMaxDevices) {
            error = "На шине больше 16 DS18B20; показаны первые 16";
            complete = true;
            break;
        }
        const auto previous = std::find_if(devices.begin(), devices.end(), [&](const auto& entry) {
            return entry.address == address;
        });
        if (previous != devices.end())
            found.push_back(*previous);
        else {
            MeteoDeviceReading entry;
            entry.address = address;
            entry.error = "Ожидание измерения";
            found.push_back(std::move(entry));
        }
    }
    onewire_del_device_iter(iterator);
    if (!complete) {
        if (error.empty())
            error = "Поиск OneWire превысил лимит устройств";
        // An interrupted search must not erase saved/discovered addresses.
        return false;
    }
    std::sort(found.begin(), found.end(), [](const auto& a, const auto& b) {
        return a.address < b.address;
    });
    devices = std::move(found);
    return true;
}

/**
 * @brief Convert and read devices independently without holding the cache mutex.
 * @param[in] job Owned GPIO/binding/discovery/device snapshot reserved by next_job().
 * @param[out] discoveryComplete Search result when attempted; unchanged if bus setup fails or no
 * scan runs.
 * @param[out] scanError Discovery or bus-initialization diagnostic when applicable.
 * @return Owned per-device readings, individual failure reasons and aggregate availability.
 * @details Parasite power is rejected because the isolated port has no strong
 * pull-up driver. Externally powered devices share a broadcast conversion; each
 * scratchpad is then CRC/resolution/range checked. One bad device does not hide
 * other good devices. The conversion delay yields this worker, not HTTP/control.
 */
MeteoPortReading read_onewire(const Job& job, bool& discoveryComplete, std::string& scanError)
{
    MeteoPortReading reading;
    reading.devices = job.devices;
    Bus bus(job.gpio);
    auto result = bus.open();
    if (result != ESP_OK) {
        reading.error = failure("Инициализация OneWire", result);
        scanError = reading.error;
        for (auto& device : reading.devices) {
            device.available = false;
            device.error = reading.error;
        }
        return reading;
    }
    if (job.discover)
        discoveryComplete = discover(bus.handle, reading.devices, scanError);
    if (job.discover && !discoveryComplete) {
        reading.error = scanError;
        for (auto& device : reading.devices) {
            device.available = false;
            device.error = reading.error;
        }
        return reading;
    }
    if (reading.devices.empty()) {
        reading.error = "DS18B20 не найдены на шине";
        return reading;
    }

    // Parasite power is deliberately rejected: the isolated port has no strong-pullup driver.
    bool poweredDevice = false;
    for (auto& device : reading.devices) {
        device.available = false;
        result = select_device(bus.handle, device.address);
        const std::uint8_t command = 0xb4;  // READ POWER SUPPLY
        if (result == ESP_OK)
            result = onewire_bus_write_bytes(bus.handle, &command, 1);
        std::uint8_t externalPower = 0;
        if (result == ESP_OK)
            result = onewire_bus_read_bit(bus.handle, &externalPower);
        if (result != ESP_OK)
            device.error = failure("Проверка питания DS18B20", result);
        else if (!externalPower)
            device.error = "DS18B20 требует внешнего питания по трём проводам";
        else {
            device.error.clear();
            poweredDevice = true;
        }
    }
    if (!poweredDevice) {
        reading.error = "Нет доступных DS18B20 с внешним питанием";
        return reading;
    }
    result = onewire_bus_reset(bus.handle);
    const std::uint8_t conversion[] = {0xcc, 0x44};  // SKIP ROM, CONVERT T on this bus.
    if (result == ESP_OK)
        result = onewire_bus_write_bytes(bus.handle, conversion, sizeof(conversion));
    if (result == ESP_OK) {
        // External power lets conversion continue without an allocated RMT channel pair.
        // Serve short iButton touches throughout the wait instead of blocking the reader 760 ms.
        bus.close();
        const auto deadline = now_ms() + 760;
        while (now_ms() < deadline) {
            ibutton_worker_step();
            const auto remaining = deadline - now_ms();
            if (remaining > 0)
                vTaskDelay(
                    std::max<TickType_t>(1, pdMS_TO_TICKS(std::min<std::int64_t>(25, remaining))));
        }
        result = bus.open();
        std::uint8_t complete = 0;
        if (result == ESP_OK)
            result = onewire_bus_read_bit(bus.handle, &complete);
        if (result == ESP_OK && !complete)
            result = ESP_ERR_TIMEOUT;
    }
    for (auto& device : reading.devices) {
        if (!device.error.empty())
            continue;
        auto deviceResult = result;
        if (deviceResult == ESP_OK)
            deviceResult = select_device(bus.handle, device.address);
        const std::uint8_t command = 0xbe;  // READ SCRATCHPAD
        if (deviceResult == ESP_OK)
            deviceResult = onewire_bus_write_bytes(bus.handle, &command, 1);
        std::array<std::uint8_t, 9> scratchpad{};
        if (deviceResult == ESP_OK)
            deviceResult = onewire_bus_read_bytes(bus.handle, scratchpad.data(), scratchpad.size());
        if (deviceResult != ESP_OK)
            device.error = failure("Чтение DS18B20", deviceResult);
        else if (meteo_decode_ds18b20(scratchpad, device.temperatureC, device.error)) {
            device.available = true;
            device.lastSuccessMs = now_ms();
            reading.available = true;
        }
    }
    if (!reading.available)
        reading.error = "Не удалось прочитать датчики OneWire";
    return reading;
}

/**
 * @brief Read one DHT22 sample and reject measurements outside the device range.
 * @param[in] gpio Exclusively owned sensor-port GPIO for this worker job.
 * @return Owned reading with temperature/humidity and success time, or an unavailable diagnostic.
 * @note Runs without sensor_mutex; the GPIO is released after the driver call.
 */
MeteoPortReading read_dht(gpio_num_t gpio)
{
    MeteoPortReading reading;
    std::int16_t humidity = 0, temperature = 0;
    const auto result = dht_read_data(DHT_TYPE_AM2301, gpio, &humidity, &temperature);
    release_pin(gpio);
    if (result != ESP_OK) {
        reading.error = failure("Чтение DHT22", result);
        return reading;
    }
    reading.temperatureC = temperature / 10.0;
    reading.humidityPct = humidity / 10.0;
    if (reading.temperatureC < -40 || reading.temperatureC > 80 || reading.humidityPct < 0
        || reading.humidityPct > 100) {
        reading.error = "Показания вне диапазона DHT22";
        return reading;
    }
    reading.available = true;
    reading.lastSuccessMs = now_ms();
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
        job.explicitScan = port.scanRequested;
        job.type = job.explicitScan ? MeteoSensorType::OneWire : port.type;
        job.discover =
            job.explicitScan || port.lastScanMs < 0 || now - port.lastScanMs >= kDiscoveryMs;
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
 * @brief Execute one fair queued job with I/O outside the sensor cache lock.
 * @return True when a reserved job ran, even if its generation changed before publication.
 * @note Called by one acquisition worker, or synchronously by the host-test adapter.
 * @details Only a matching generation may publish results. Explicit OneWire
 * probing of a DHT-owned port updates scan results, never its saved DHT reading.
 */
bool sensor_step()
{
    if (ibutton_worker_step())
        return true;
    Job job;
    if (!next_job(job))
        return false;
    bool complete = false;
    std::string scanError;
    auto reading = job.type == MeteoSensorType::Dht22 ? read_dht(job.gpio)
                                                      : read_onewire(job, complete, scanError);
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
 * @brief Run physical acquisition jobs independently of HTTP and controller tasks.
 * @note The unused FreeRTOS argument is ignored; idle iterations yield for 50 ms.
 */
void sensor_task(void*)
{
    runtime_task_observe(RuntimeTask::Meteo);
    while (true) {
        if (!sensor_step())
            vTaskDelay(pdMS_TO_TICKS(50));
    }
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
 * @brief Initialize released sensor pins and start the acquisition worker once.
 * @return ESP_OK or the worker-allocation error; repeated calls return the initial result.
 * @details Call after board activation and before controller configuration is pushed.
 * @endcond
 */
esp_err_t meteo_sensors_init()
{
    std::lock_guard<std::mutex> lock(sensor_mutex);
    if (started)
        return startup_error;
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.sensorPortCount; ++i) {
        const auto& definition = board.sensorPorts[i];
        PortState port;
        port.id = definition.name;
        port.gpio = static_cast<gpio_num_t>(definition.gpio);
        release_pin(port.gpio);
        port.reading.error = "Ожидание измерения";
        ports.push_back(std::move(port));
    }
    started = true;
    startup_error = xTaskCreate(sensor_task, "fcplcn_meteo", 6144, nullptr, 3, nullptr) == pdPASS
                        ? ESP_OK
                        : ESP_ERR_NO_MEM;
    return startup_error;
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
    if (startup_error != ESP_OK) {
        result.available = false;
        result.error = failure("Задача Метео", startup_error);
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

#ifdef FCPLCN_METEO_SENSORS_TESTING
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Execute one scheduled host-test job; @return true if a job was run.
 * @endcond
 */
bool meteo_sensors_test_step()
{
    return sensor_step();
}
#endif
