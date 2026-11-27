/**
 * @file sensor_ports.cpp
 * @brief DHT22 and OneWire transactions on isolated PLC GPIO.
 */
#include "sensor_ports.h"

#include <algorithm>
#include <array>
#include <utility>

#include "dht.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "meteo_codec.h"
#include "onewire_bus.h"
#include "onewire_device.h"

namespace {
constexpr std::size_t kMaxDevices = 16;
constexpr unsigned kDs18b20SearchLimit = 64;
constexpr unsigned kIbuttonSearchLimit = 32;
constexpr std::int64_t kDs18b20ConversionMs = 760;

/**
 * @brief Timestamp a successful port transaction.
 * @return Monotonic ESP uptime in whole milliseconds.
 */
std::int64_t now_ms()
{
    return esp_timer_get_time() / 1000;
}

/**
 * @brief Append the underlying IDF error name to a diagnostic.
 * @param action Borrowed null-terminated operation label.
 * @param error Driver result to append.
 * @return Owned diagnostic string.
 */
std::string failure(const char* action, esp_err_t error)
{
    return std::string(action) + ": " + esp_err_to_name(error);
}

/**
 * @brief Scoped ownership of a transient RMT channel pair on a sensor pin.
 * @note Only the sensor acquisition worker opens the bus. Destroying it releases the GPIO.
 */
struct Bus {
    onewire_bus_handle_t handle = nullptr;
    int gpio;

    /**
     * @brief Retain the pin number for cleanup, even if allocation fails.
     * @param pin Profile GPIO number.
     */
    explicit Bus(int pin) : gpio(pin)
    {
    }

    /** @brief Release the RMT channels and restore the open-drain GPIO. */
    ~Bus()
    {
        close();
    }

    /**
     * @brief Release the pin and RMT channels without sending a OneWire reset.
     * @note Externally powered DS18B20 devices can continue converting while the bus is closed.
     */
    void close()
    {
        if (handle) {
            onewire_bus_del(handle);
            handle = nullptr;
        }
        sensor_port_release(gpio);
    }

    /**
     * @brief Allocate RMT channels, using the board's external pull-up.
     * @return ESP_OK or an allocation/configuration error.
     * @pre No bus is open in this owner.
     */
    esp_err_t open()
    {
        onewire_bus_config_t config{};
        config.bus_gpio_num = gpio;
        config.flags.en_pull_up = false;
        onewire_bus_rmt_config_t rmt{};
        rmt.max_rx_bytes = 10;
        return onewire_new_bus_rmt(&config, &rmt, &handle);
    }
};

/**
 * @brief Reset the bus and send MATCH ROM for a specific DS18B20.
 * @param bus Borrowed, exclusively owned OneWire bus.
 * @param address Canonical family-28 ROM with a valid CRC.
 * @return ESP_OK, ESP_ERR_INVALID_ARG for malformed ROM, or a transport error.
 */
esp_err_t select_ds18b20(onewire_bus_handle_t bus, const std::string& address)
{
    std::array<std::uint8_t, 8> rom{};
    if (!meteo_parse_address(address, rom)) {
        return ESP_ERR_INVALID_ARG;
    }
    const auto result = onewire_bus_reset(bus);
    if (result != ESP_OK) {
        return result;
    }
    std::array<std::uint8_t, 9> command{};
    command[0] = 0x55;  // MATCH ROM
    std::copy(rom.begin(), rom.end(), command.begin() + 1);
    return onewire_bus_write_bytes(bus, command.data(), command.size());
}

/**
 * @brief Search a bounded number of ROMs and keep valid DS18B20 devices.
 * @param bus Borrowed, exclusively owned OneWire bus.
 * @param[out] addresses Discovered ROMs, assigned only when the search completes.
 * @param[out] error Failure or truncation diagnostic. The caller supplies an empty string.
 * @return True when the search completes, including truncation to sixteen devices.
 */
bool discover_ds18b20(onewire_bus_handle_t bus,
                      std::vector<std::string>& addresses,
                      std::string& error)
{
    onewire_device_iter_handle_t iterator = nullptr;
    auto result = onewire_new_device_iter(bus, &iterator);
    if (result != ESP_OK) {
        error = failure("Поиск OneWire", result);
        return false;
    }
    std::vector<std::string> found;
    bool complete = false;
    for (unsigned visited = 0; visited < kDs18b20SearchLimit; ++visited) {
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
        auto address = meteo_rom_address(device.address);
        std::array<std::uint8_t, 8> rom{};
        if (!meteo_parse_address(address, rom)) {
            continue;
        }
        if (found.size() == kMaxDevices) {
            error = "На шине больше 16 DS18B20; показаны первые 16";
            complete = true;
            break;
        }
        found.push_back(std::move(address));
    }
    onewire_del_device_iter(iterator);
    if (!complete) {
        if (error.empty()) {
            error = "Поиск OneWire превысил лимит устройств";
        }
        return false;
    }
    std::sort(found.begin(), found.end());
    addresses = std::move(found);
    return true;
}

/**
 * @brief Check that a DS18B20 has external power before issuing a conversion.
 * @param bus Borrowed OneWire bus containing the target ROM.
 * @param address CRC-valid family-28 ROM.
 * @return Empty on success, or the reason the device cannot safely convert.
 */
std::string ds18b20_power_error(onewire_bus_handle_t bus, const std::string& address)
{
    auto result = select_ds18b20(bus, address);
    const std::uint8_t command = 0xb4;  // READ POWER SUPPLY
    if (result == ESP_OK) {
        result = onewire_bus_write_bytes(bus, &command, 1);
    }
    std::uint8_t externalPower = 0;
    if (result == ESP_OK) {
        result = onewire_bus_read_bit(bus, &externalPower);
    }
    if (result != ESP_OK) {
        return failure("Проверка питания DS18B20", result);
    }
    return externalPower ? "" : "DS18B20 требует внешнего питания по трём проводам";
}

/**
 * @brief Convert externally powered DS18B20 devices and confirm completion.
 * @param bus Exclusive bus owner, reopened after the conversion delay.
 * @param waitForConversion Scheduler callback invoked with the RMT bus closed.
 * @return ESP_OK, ESP_ERR_TIMEOUT or a bus error.
 */
esp_err_t convert_ds18b20(Bus& bus, void (*waitForConversion)(std::int64_t))
{
    auto result = onewire_bus_reset(bus.handle);
    const std::uint8_t conversion[] = {0xcc, 0x44};  // SKIP ROM, CONVERT T
    if (result == ESP_OK) {
        result = onewire_bus_write_bytes(bus.handle, conversion, sizeof(conversion));
    }
    if (result != ESP_OK) {
        return result;
    }
    bus.close();
    waitForConversion(kDs18b20ConversionMs);
    result = bus.open();
    std::uint8_t complete = 0;
    if (result == ESP_OK) {
        result = onewire_bus_read_bit(bus.handle, &complete);
        if (result == ESP_OK && !complete) {
            return ESP_ERR_TIMEOUT;
        }
    }
    return result;
}

/**
 * @brief Read and validate a DS18B20 scratchpad after a completed conversion.
 * @param bus Borrowed, exclusively owned OneWire bus.
 * @param[in,out] sample Target ROM and destination for temperature, sample time or error.
 */
void read_ds18b20(onewire_bus_handle_t bus, Ds18b20Sample& sample)
{
    auto result = select_ds18b20(bus, sample.address);
    const std::uint8_t command = 0xbe;  // READ SCRATCHPAD
    if (result == ESP_OK) {
        result = onewire_bus_write_bytes(bus, &command, 1);
    }
    std::array<std::uint8_t, 9> scratchpad{};
    if (result == ESP_OK) {
        result = onewire_bus_read_bytes(bus, scratchpad.data(), scratchpad.size());
    }
    if (result != ESP_OK) {
        sample.error = failure("Чтение DS18B20", result);
    } else if (meteo_decode_ds18b20(scratchpad, sample.temperatureC, sample.error)) {
        sample.sampledAtMs = now_ms();
    }
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Release the isolator-facing line without actively driving it HIGH.
 * @param gpio Profile GPIO number.
 * @endcond
 */
void sensor_port_release(int gpio)
{
    const auto pin = static_cast<gpio_num_t>(gpio);
    gpio_set_level(pin, 1);
    gpio_set_direction(pin, GPIO_MODE_INPUT_OUTPUT_OD);
    gpio_set_pull_mode(pin, GPIO_FLOATING);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read DHT22 and check the device's temperature and humidity ranges.
 * @param gpio Exclusively owned sensor GPIO.
 * @return Owned sample or diagnostic. The GPIO is released after every attempt.
 * @endcond
 */
Dht22Sample sensor_port_read_dht22(int gpio)
{
    Dht22Sample reading;
    std::int16_t humidity = 0, temperature = 0;
    const auto result =
        dht_read_data(DHT_TYPE_AM2301, static_cast<gpio_num_t>(gpio), &humidity, &temperature);
    sensor_port_release(gpio);
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
    reading.sampledAtMs = now_ms();
    return reading;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Discover, convert and read DS18B20 without taking application locks.
 * @param gpio Exclusively owned sensor GPIO.
 * @param discover Whether a new bounded discovery should run.
 * @param addresses Owned list of prior ROMs, retained if a new search fails.
 * @param waitForConversion Scheduler callback invoked with the RMT bus closed.
 * @return Owned per-device results with independent diagnostics.
 * @endcond
 */
Ds18b20Poll sensor_port_poll_ds18b20(int gpio,
                                     bool discover,
                                     std::vector<std::string> addresses,
                                     void (*waitForConversion)(std::int64_t))
{
    Ds18b20Poll poll;
    Bus bus(gpio);
    const auto initialized = bus.open();
    if (initialized != ESP_OK) {
        poll.error = failure("Инициализация OneWire", initialized);
        poll.discoveryError = poll.error;
    } else if (discover) {
        poll.discoveryComplete = discover_ds18b20(bus.handle, addresses, poll.discoveryError);
        if (!poll.discoveryComplete) {
            poll.error = poll.discoveryError;
        }
    }
    poll.samples.reserve(addresses.size());
    for (auto& address : addresses) {
        poll.samples.push_back({std::move(address), 0, -1, poll.error});
    }
    if (!poll.error.empty()) {
        return poll;
    }
    if (poll.samples.empty()) {
        poll.error = "DS18B20 не найдены на шине";
        return poll;
    }

    // The isolated port has no strong pull-up for parasite-powered devices.
    bool poweredDevice = false;
    for (auto& sample : poll.samples) {
        sample.error = ds18b20_power_error(bus.handle, sample.address);
        poweredDevice |= sample.error.empty();
    }
    if (!poweredDevice) {
        poll.error = "Нет доступных DS18B20 с внешним питанием";
        return poll;
    }

    const auto converted = convert_ds18b20(bus, waitForConversion);
    bool available = false;
    for (auto& sample : poll.samples) {
        if (!sample.error.empty()) {
            continue;
        }
        if (converted != ESP_OK) {
            sample.error = failure("Чтение DS18B20", converted);
        } else {
            read_ds18b20(bus.handle, sample);
        }
        available |= sample.sampledAtMs >= 0;
    }
    if (!available) {
        poll.error = "Не удалось прочитать датчики OneWire";
    }
    return poll;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Search iButton ROMs and distinguish confirmed absence from corrupted bus traffic.
 * @param gpio Exclusively owned sensor GPIO.
 * @return Owned physical presence and CRC-valid family-01 ROMs or a diagnostic.
 * @endcond
 */
IbuttonObservation sensor_port_observe_ibutton(int gpio)
{
    IbuttonObservation result;
    Bus bus(gpio);
    auto error = bus.open();
    if (error == ESP_OK) {
        error = onewire_bus_reset(bus.handle);
    }
    if (error == ESP_ERR_NOT_FOUND && bus.handle
        && gpio_get_level(static_cast<gpio_num_t>(gpio)) == 1) {
        result.available = true;
        return result;
    }
    if (error != ESP_OK) {
        result.error = failure("Считыватель iButton", error);
        return result;
    }
    result.present = true;
    onewire_device_iter_handle_t iterator = nullptr;
    error = onewire_new_device_iter(bus.handle, &iterator);
    if (error != ESP_OK) {
        result.error = failure("Поиск iButton", error);
        return result;
    }
    bool complete = false;
    for (unsigned visited = 0; visited < kIbuttonSearchLimit; ++visited) {
        onewire_device_t device{};
        error = onewire_device_iter_get_next(iterator, &device);
        if (error == ESP_ERR_NOT_FOUND) {
            // A presence pulse followed by an empty search is not a confirmed release.
            complete = visited > 0;
            if (!complete) {
                result.error = "iButton исчез во время чтения";
            }
            break;
        }
        if (error != ESP_OK) {
            result.error = failure("Чтение ROM iButton", error);
            break;
        }
        std::array<std::uint8_t, 8> bytes{};
        for (unsigned i = 0; i < bytes.size(); ++i) {
            bytes[i] = static_cast<std::uint8_t>(device.address >> (i * 8));
        }
        if (meteo_crc8(bytes.data(), bytes.size() - 1) != bytes.back()) {
            result.error = "Неверная CRC серийного номера iButton";
            break;
        }
        if (bytes.front() != 0x01) {
            continue;
        }
        if (result.addresses.size() == kMaxDevices) {
            result.error = "На шине больше 16 iButton";
            break;
        }
        result.addresses.push_back(meteo_rom_address(device.address));
    }
    onewire_del_device_iter(iterator);
    if (!complete) {
        if (result.error.empty()) {
            result.error = "Поиск iButton превысил лимит устройств";
        }
        result.addresses.clear();
        return result;
    }
    std::sort(result.addresses.begin(), result.addresses.end());
    const auto end = std::unique(result.addresses.begin(), result.addresses.end());
    result.addresses.erase(end, result.addresses.end());
    result.available = true;
    return result;
}
