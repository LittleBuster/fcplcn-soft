#include "sensors/meteo_codec.h"
#include "sensors/meteo_sensors.h"
#include "sensors/ibutton.h"
#include "hardware/board_profile.h"
#include "dht.h"
#include "esp_timer.h"
#include "freertos/task.h"
#include "onewire_device.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <map>
#include <stdexcept>

#define CHECK(value)                                                                               \
    do {                                                                                           \
        if (!(value))                                                                              \
            throw std::runtime_error(std::string("Check failed at line ")                          \
                                     + std::to_string(__LINE__) + ": " #value);                    \
    } while (0)

struct FakeDevice {
    std::uint64_t address;
    double temperature;
    bool externalPower = true;
    bool badCrc = false;
};

struct FakeBus {
    int gpio;
    std::uint64_t selected = 0;
    std::uint8_t command = 0;
};

struct FakeIterator {
    FakeBus* bus;
    std::size_t index = 0;
};

namespace {
std::map<int, std::vector<FakeDevice>> wire;
std::map<int, std::uint8_t> lastCommand;
bool lineLow = false;
std::int64_t clockMs = 1000;
std::function<void()> duringDelay;
std::function<void()> duringSearch;
bool openFails = false, conversionReady = true;
int activeBuses = 0, conversionCount = 0, dhtReads = 0;
std::int16_t dhtHumidity = 563, dhtTemperature = -123;

std::uint64_t rom(unsigned serial)
{
    std::array<std::uint8_t, 8> bytes{
        0x28, static_cast<std::uint8_t>(serial), 0x11, 0x22, 0x33, 0x44, 0x55, 0};
    bytes[7] = meteo_crc8(bytes.data(), 7);
    std::uint64_t result = 0;
    for (unsigned i = 0; i < bytes.size(); ++i)
        result |= static_cast<std::uint64_t>(bytes[i]) << (8 * i);
    return result;
}

std::uint64_t key_rom(unsigned serial)
{
    std::array<std::uint8_t, 8> bytes{
        0x01, static_cast<std::uint8_t>(serial), 0x11, 0x22, 0x33, 0x44, 0x55, 0};
    bytes[7] = meteo_crc8(bytes.data(), 7);
    std::uint64_t result = 0;
    for (unsigned i = 0; i < bytes.size(); ++i)
        result |= static_cast<std::uint64_t>(bytes[i]) << (8 * i);
    return result;
}

void key_step(unsigned milliseconds = 100)
{
    clockMs += milliseconds;
    CHECK(ibutton_worker_step());
    CHECK(activeBuses == 0);
}

void init();

void key_ready()
{
    init();
    CHECK(ibutton_configure("sens-0/2") == ESP_OK);
    key_step();
    key_step();
}

FakeDevice* selected(FakeBus* bus)
{
    auto& devices = wire[bus->gpio];
    auto item = std::find_if(devices.begin(), devices.end(), [&](const auto& d) {
        return d.address == bus->selected;
    });
    return item == devices.end() ? nullptr : &*item;
}

std::array<std::uint8_t, 9> scratch(double temperature, std::uint8_t config = 0x7f)
{
    const auto raw = static_cast<std::uint16_t>(static_cast<std::int16_t>(temperature * 16));
    std::array<std::uint8_t, 9> result{static_cast<std::uint8_t>(raw),
                                       static_cast<std::uint8_t>(raw >> 8),
                                       75,
                                       70,
                                       config,
                                       0xff,
                                       0x0c,
                                       0x10,
                                       0};
    result[8] = meteo_crc8(result.data(), 8);
    return result;
}

void init()
{
    CHECK(board_profile_activate(kDefaultBoardProfileId));
    CHECK(meteo_sensors_init() == ESP_OK);
}

void configure(MeteoSensorType type = MeteoSensorType::OneWire, bool enabled = true)
{
    meteo_sensors_configure(enabled, {{"sens-0/1", type}});
}

void step()
{
    CHECK(meteo_sensors_test_step());
    CHECK(activeBuses == 0);
}

void codec()
{
    double value = 999;
    std::string error;
    CHECK(meteo_decode_ds18b20(scratch(25.0625), value, error));
    CHECK(value == 25.0625);
    CHECK(meteo_decode_ds18b20(scratch(-10.125), value, error));
    CHECK(value == -10.125);
    CHECK(meteo_decode_ds18b20(scratch(12.4375, 0x1f), value, error));
    CHECK(value == 12.0);
    auto bad = scratch(85);
    bad[0] ^= 1;
    CHECK(!meteo_decode_ds18b20(bad, value, error));
    CHECK(value == 12.0);
    CHECK(!meteo_decode_ds18b20({}, value, error));
    CHECK(!meteo_decode_ds18b20(scratch(126), value, error));
    std::array<std::uint8_t, 8> bytes{};
    auto text = meteo_rom_address(rom(1));
    CHECK(text.substr(0, 2) == "28");
    CHECK(meteo_parse_address(text, bytes));
    text.back() = text.back() == '0' ? '1' : '0';
    CHECK(!meteo_parse_address(text, bytes));
    CHECK(!meteo_parse_address("280000000000000g", bytes));
}

void multiwire()
{
    init();
    wire[39] = {{rom(1), 23.5}, {rom(2), -8.25}};
    configure();
    MeteoScanSnapshot scan;
    CHECK(meteo_sensors_request_scan("sens-0/1", true, scan) == ESP_OK);
    CHECK(scan.busy && !scan.complete);
    CHECK(conversionCount == 0);  // Request never performs IO.
    step();
    CHECK(meteo_sensors_request_scan("sens-0/1", false, scan) == ESP_OK);
    CHECK(!scan.busy && scan.complete && scan.devices.size() == 2);
    const auto result = meteo_sensors_read("sens-0/1");
    CHECK(result.available && result.devices.size() == 2);
    CHECK(result.devices[0].temperatureC == 23.5 && result.devices[1].temperatureC == -8.25);
    CHECK(result.devices[0].address != result.devices[1].address);
    CHECK(conversionCount == 1);
}

void dht()
{
    init();
    configure(MeteoSensorType::Dht22);
    step();
    auto result = meteo_sensors_read("sens-0/1");
    CHECK(result.available && result.temperatureC == -12.3 && result.humidityPct == 56.3);
    CHECK(result.devices.empty());
    CHECK(!meteo_sensors_test_step());
    clockMs += 5000;
    dhtHumidity = 1001;
    step();
    result = meteo_sensors_read("sens-0/1");
    CHECK(!result.available && !result.error.empty());
    CHECK(dhtReads == 2);
}

void scan_disabled()
{
    init();
    wire[39] = {{rom(3), 19}};
    MeteoScanSnapshot scan;
    CHECK(meteo_sensors_request_scan("sens-0/1", true, scan) == ESP_OK);
    step();
    CHECK(meteo_sensors_request_scan("sens-0/1", false, scan) == ESP_OK);
    CHECK(scan.complete && scan.devices.size() == 1);
    CHECK(!meteo_sensors_read("sens-0/1").available);
    CHECK(meteo_sensors_request_scan("sens-99/1", true, scan) == ESP_ERR_NOT_FOUND);
}

void read_faults()
{
    init();
    wire[39] = {{rom(4), 21}};
    configure();
    step();
    CHECK(meteo_sensors_read("sens-0/1").devices[0].available);
    clockMs += 5000;
    wire[39][0].badCrc = true;
    step();
    auto result = meteo_sensors_read("sens-0/1");
    CHECK(!result.devices[0].available && !result.devices[0].error.empty());
    clockMs += 5000;
    wire[39][0].badCrc = false;
    step();
    CHECK(meteo_sensors_read("sens-0/1").devices[0].available);
    clockMs += 5000;
    openFails = true;
    step();
    CHECK(!meteo_sensors_read("sens-0/1").devices[0].available);
    clockMs += 5000;
    openFails = false;
    step();
    CHECK(meteo_sensors_read("sens-0/1").devices[0].available);
}

void conversion_timeout()
{
    init();
    wire[39] = {{rom(5), 85}};
    configure();
    conversionReady = false;
    step();
    const auto result = meteo_sensors_read("sens-0/1");
    CHECK(!result.available && !result.devices[0].available);
    CHECK(result.devices[0].lastSuccessMs == -1);
}

void stale()
{
    init();
    wire[39] = {{rom(6), 22}};
    configure();
    step();
    clockMs += 15001;
    const auto reading = meteo_sensors_read("sens-0/1");
    CHECK(!reading.devices[0].available && !reading.available && !reading.error.empty());
    configure(MeteoSensorType::OneWire, false);
    CHECK(!meteo_sensors_test_step());
    CHECK(!meteo_sensors_read("sens-0/1").available);
}

void reconfigure()
{
    init();
    wire[39] = {{rom(7), 85}};
    configure();
    duringDelay = [] {
        configure(MeteoSensorType::Dht22);
    };
    step();  // The binding changes while the old DS18B20 conversion is in flight.
    CHECK(!meteo_sensors_read("sens-0/1").available);
    step();
    const auto result = meteo_sensors_read("sens-0/1");
    CHECK(result.available && result.devices.empty());
    CHECK(result.temperatureC == -12.3);
}

void parasite()
{
    init();
    wire[39] = {{rom(8), 21, false}, {rom(9), 24, true}};
    configure();
    step();
    const auto result = meteo_sensors_read("sens-0/1");
    CHECK(!result.devices[0].available && !result.devices[0].error.empty());
    CHECK(result.devices[1].available && result.devices[1].temperatureC == 24);
}

void fair_ports()
{
    init();
    wire[39] = {{rom(10), 22}};
    meteo_sensors_configure(
        true, {{"sens-0/1", MeteoSensorType::OneWire}, {"sens-0/2", MeteoSensorType::Dht22}});
    step();
    step();
    CHECK(meteo_sensors_read("sens-0/1").available && meteo_sensors_read("sens-0/2").available);
    MeteoScanSnapshot scan;
    clockMs += 2100;
    CHECK(meteo_sensors_request_scan("sens-0/1", true, scan) == ESP_OK);
    CHECK(scan.busy && !scan.complete
          && scan.devices.size() == 1);  // Refresh is a new unfinished job.
    step();
    CHECK(dhtReads == 1 && activeBuses == 0);
}

void ibutton_codec()
{
    std::array<std::uint8_t, 8> bytes{};
    auto address = meteo_rom_address(key_rom(1));
    CHECK(ibutton_parse_address(address, bytes));
    CHECK(bytes[0] == 1);
    std::transform(address.begin(), address.end(), address.begin(), [](char letter) {
        return letter >= 'a' && letter <= 'f' ? static_cast<char>(letter - 'a' + 'A') : letter;
    });
    CHECK(ibutton_parse_address(address, bytes));
    CHECK(!ibutton_parse_address(meteo_rom_address(rom(1)), bytes));
    CHECK(!ibutton_parse_address("010000000000000g", bytes));
    CHECK(!ibutton_parse_address("01", bytes));
    address.back() = address.back() == '0' ? '1' : '0';
    CHECK(!ibutton_parse_address(address, bytes));
}

void ibutton_touch()
{
    init();
    wire[40] = {{key_rom(1), 0}};
    CHECK(ibutton_configure("sens-0/2") == ESP_OK);
    for (unsigned i = 0; i < 5; ++i)
        key_step();
    CHECK(ibutton_read().eventSequence == 0);  // A key held over startup is never a press.
    wire[40].clear();
    key_step();
    key_step();
    wire[40] = {{key_rom(1), 0}};
    key_step();
    CHECK(ibutton_read().eventSequence == 0);
    key_step();
    const auto first = ibutton_read();
    CHECK(first.available && first.present && first.eventSequence == 1);
    CHECK(first.eventAddress == meteo_rom_address(key_rom(1)) && first.eventAtMs == clockMs);
    for (unsigned i = 0; i < 10; ++i)
        key_step();
    CHECK(ibutton_read().eventSequence == 1);
    wire[40].clear();
    key_step();
    wire[40] = {{key_rom(1), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 1);  // A one-sample bounce cannot rearm the key.
    wire[40].clear();
    key_step();
    key_step();
    wire[40] = {{key_rom(2), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 2);
    CHECK(ibutton_read().eventAddress == meteo_rom_address(key_rom(2)));
}

void ibutton_faults()
{
    key_ready();
    wire[40] = {{key_rom(3), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 1);
    openFails = true;
    key_step();
    CHECK(!ibutton_read().available);
    openFails = false;
    for (unsigned i = 0; i < 3; ++i)
        key_step();
    CHECK(ibutton_read().available && ibutton_read().eventSequence == 1);
    wire[40].clear();
    lineLow = true;
    key_step();
    key_step();
    CHECK(!ibutton_read().available);  // A shorted line is a fault, never a confirmed release.
    lineLow = false;
    wire[40] = {{key_rom(3), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 1);
    wire[40].clear();
    key_step();
    key_step();
    wire[40] = {{key_rom(3), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 2);
}

void ibutton_scan()
{
    init();
    wire[39] = {{key_rom(5), 0}, {rom(5), 24}, {key_rom(4), 0}};
    IbuttonScanSnapshot scan;
    CHECK(ibutton_request_scan("sens-0/1", true, scan) == ESP_OK);
    CHECK(scan.busy && !scan.complete && activeBuses == 0);
    CHECK(ibutton_worker_step());
    CHECK(ibutton_request_scan("sens-0/1", false, scan) == ESP_OK);
    CHECK(!scan.busy && scan.complete && scan.error.empty() && scan.addresses.size() == 2);
    CHECK(std::is_sorted(scan.addresses.begin(), scan.addresses.end()));
    CHECK(ibutton_read().eventSequence == 0);
    CHECK(ibutton_request_scan("sens-0/1", true, scan) == ESP_OK);
    CHECK(!scan.busy);  // Refresh cannot run unbounded back-to-back searches.
    clockMs += 2000;
    CHECK(ibutton_request_scan("sens-0/1", true, scan) == ESP_OK && scan.busy);
    CHECK(ibutton_worker_step());
    CHECK(ibutton_request_scan("sens-9/1", true, scan) == ESP_ERR_NOT_FOUND);
    CHECK(activeBuses == 0);
}

void ibutton_stale()
{
    key_ready();
    CHECK(ibutton_read().available);
    clockMs += 1501;
    CHECK(!ibutton_read().available && !ibutton_read().error.empty());
    key_step();
    CHECK(ibutton_read().available);
    CHECK(ibutton_configure("") == ESP_OK);
    CHECK(!ibutton_read().available && !ibutton_worker_step());
}

void ibutton_rebind()
{
    key_ready();
    wire[40] = {{key_rom(6), 0}};
    key_step();
    key_step();
    const auto before = ibutton_read();
    CHECK(before.eventSequence == 1);
    wire[17] = {{key_rom(7), 0}};
    CHECK(ibutton_configure("sens-0/3") == ESP_OK);
    CHECK(ibutton_read().generation != before.generation);
    for (unsigned i = 0; i < 4; ++i)
        key_step();
    CHECK(ibutton_read().eventSequence == before.eventSequence);
    CHECK(ibutton_read().eventAddress.empty());
    wire[17].clear();
    key_step();
    key_step();
    wire[17] = {{key_rom(7), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == before.eventSequence + 1);
}

void ibutton_during_conversion()
{
    key_ready();
    wire[39] = {{rom(11), 22}};
    configure();
    const auto started = clockMs;
    // A callback on every conversion slice simulates a brief key touching between 100 and 350 ms.
    std::function<void()> contact;
    contact = [&] {
        const auto elapsed = clockMs - started;
        if (elapsed >= 100 && elapsed < 350)
            wire[40] = {{key_rom(8), 0}};
        else
            wire[40].clear();
        if (elapsed < 760)
            duringDelay = contact;
    };
    duringDelay = contact;
    step();
    const auto key = ibutton_read();
    CHECK(key.eventSequence == 1 && key.eventAddress == meteo_rom_address(key_rom(8)));
    CHECK(key.eventAtMs - started < 350);
    CHECK(meteo_sensors_read("sens-0/1").devices[0].available);
    CHECK(conversionCount == 1 && activeBuses == 0);
    duringDelay = {};
}

void ibutton_crc()
{
    key_ready();
    wire[40] = {{key_rom(9) ^ (1ULL << 56), 0}};
    key_step();
    key_step();
    CHECK(!ibutton_read().available && ibutton_read().eventSequence == 0);
    wire[40] = {{key_rom(9), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 0);  // Fault recovery does not manufacture a touch.
    wire[40].clear();
    key_step();
    key_step();
    wire[40] = {{key_rom(9), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 1);
}

void ibutton_multiple()
{
    key_ready();
    wire[40] = {{key_rom(10), 0}, {key_rom(11), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().available && ibutton_read().addresses.size() == 2);
    CHECK(ibutton_read().eventSequence == 0);
    wire[40] = {{key_rom(10), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 0);
    wire[40].clear();
    key_step();
    key_step();
    wire[40] = {{rom(1), 22}};
    key_step();
    CHECK(ibutton_read().available && ibutton_read().present && ibutton_read().addresses.empty());
    CHECK(ibutton_read().eventSequence == 0);
}

void ibutton_scan_cancel()
{
    init();
    wire[17] = {{key_rom(12), 0}};
    IbuttonScanSnapshot scan;
    CHECK(ibutton_request_scan("sens-0/3", true, scan) == ESP_OK && scan.busy);
    meteo_sensors_configure(false, {});  // A no-op cannot cancel a legitimate enrollment search.
    CHECK(ibutton_worker_step());
    CHECK(ibutton_request_scan("sens-0/3", false, scan) == ESP_OK);
    CHECK(scan.complete && scan.addresses.size() == 1);
    clockMs += 2000;
    CHECK(ibutton_request_scan("sens-0/3", true, scan) == ESP_OK && scan.busy);
    configure(MeteoSensorType::Dht22);
    CHECK(!ibutton_worker_step());  // Changed physical Meteo ownership cancels queued searches.
    CHECK(ibutton_request_scan("sens-0/3", false, scan) == ESP_OK && scan.busy);
    duringSearch = [] {
        ibutton_cancel_scans();
    };
    CHECK(ibutton_worker_step());
    CHECK(ibutton_request_scan("sens-0/3", false, scan) == ESP_OK);
    CHECK(scan.busy && !scan.complete && scan.addresses.empty());  // Old results cannot publish.
    CHECK(ibutton_worker_step());
    CHECK(ibutton_request_scan("sens-0/3", false, scan) == ESP_OK);
    CHECK(scan.complete && scan.addresses.size() == 1);
}

void ibutton_enrollment_release()
{
    key_ready();
    wire[40] = {{key_rom(13), 0}};
    key_step();  // The first sample has not yet generated a touch.
    const auto before = ibutton_read();
    ibutton_require_release();
    CHECK(ibutton_read().generation != before.generation);
    for (unsigned i = 0; i < 4; ++i)
        key_step();
    CHECK(ibutton_read().available && ibutton_read().present);
    CHECK(ibutton_read().eventSequence == 0);
    IbuttonScanSnapshot scan;
    CHECK(ibutton_request_scan("sens-0/2", true, scan) == ESP_OK);
    CHECK(ibutton_worker_step());
    CHECK(ibutton_request_scan("sens-0/2", false, scan) == ESP_OK);
    CHECK(scan.complete && scan.addresses.size() == 1);  // Enrollment still reads the held ROM.
    CHECK(ibutton_read().eventSequence == 0);
    wire[40].clear();
    key_step();
    key_step();
    wire[40] = {{key_rom(13), 0}};
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 1);
    ibutton_require_release();  // Explicit web arming cannot be undone by the still-held key.
    key_step();
    key_step();
    CHECK(ibutton_read().eventSequence == 1 && ibutton_read().eventAddress.empty());
}
}  // namespace

const char* esp_err_to_name(esp_err_t error)
{
    return error == ESP_OK ? "ESP_OK" : "FAKE_IO_ERROR";
}

std::int64_t esp_timer_get_time()
{
    return clockMs * 1000;
}

BaseType_t
xTaskCreate(TaskFunction_t, const char*, std::uint32_t, void*, UBaseType_t, TaskHandle_t*)
{
    return pdPASS;
}

void vTaskDelay(TickType_t ticks)
{
    clockMs += ticks;
    if (duringDelay) {
        auto callback = std::move(duringDelay);
        duringDelay = {};
        callback();
    }
}

esp_err_t gpio_set_level(gpio_num_t, std::uint32_t level)
{
    CHECK(level == 1);
    return ESP_OK;
}

esp_err_t gpio_set_direction(gpio_num_t, gpio_mode_t mode)
{
    CHECK(mode == GPIO_MODE_INPUT_OUTPUT_OD);
    return ESP_OK;
}

esp_err_t gpio_set_pull_mode(gpio_num_t, gpio_pull_mode_t mode)
{
    CHECK(mode == GPIO_FLOATING);
    return ESP_OK;
}

int gpio_get_level(gpio_num_t)
{
    return lineLow ? 0 : 1;
}

esp_err_t
dht_read_data(dht_sensor_type_t type, gpio_num_t, std::int16_t* humidity, std::int16_t* temperature)
{
    CHECK(type == DHT_TYPE_AM2301);
    ++dhtReads;
    *humidity = dhtHumidity;
    *temperature = dhtTemperature;
    return ESP_OK;
}

esp_err_t onewire_new_bus_rmt(const onewire_bus_config_t* config,
                              const onewire_bus_rmt_config_t* rmt,
                              onewire_bus_handle_t* bus)
{
    CHECK(!config->flags.en_pull_up && rmt->max_rx_bytes >= 9);
    CHECK(activeBuses == 0);
    if (openFails)
        return ESP_FAIL;
    *bus = new FakeBus{config->bus_gpio_num, 0, lastCommand[config->bus_gpio_num]};
    ++activeBuses;
    return ESP_OK;
}

esp_err_t onewire_bus_del(onewire_bus_handle_t bus)
{
    delete bus;
    --activeBuses;
    return ESP_OK;
}

esp_err_t onewire_bus_reset(onewire_bus_handle_t bus)
{
    return wire[bus->gpio].empty() ? ESP_ERR_NOT_FOUND : ESP_OK;
}

esp_err_t
onewire_bus_write_bytes(onewire_bus_handle_t bus, const std::uint8_t* data, std::uint8_t size)
{
    CHECK(size > 0);
    bus->command = data[size - 1];
    lastCommand[bus->gpio] = bus->command;
    if (data[0] == 0x55) {
        CHECK(size == 9);
        bus->selected = 0;
        for (unsigned i = 0; i < 8; ++i)
            bus->selected |= static_cast<std::uint64_t>(data[i + 1]) << (8 * i);
    } else if (data[0] == 0xcc) {
        CHECK(size == 2 && data[1] == 0x44);
        ++conversionCount;
    }
    return ESP_OK;
}

esp_err_t onewire_bus_read_bit(onewire_bus_handle_t bus, std::uint8_t* bit)
{
    if (bus->command == 0xb4) {
        const auto* device = selected(bus);
        *bit = device ? device->externalPower : 1;
    } else {
        CHECK(bus->command == 0x44);
        *bit = conversionReady;
    }
    return ESP_OK;
}

esp_err_t onewire_bus_read_bytes(onewire_bus_handle_t bus, std::uint8_t* bytes, std::size_t size)
{
    CHECK(bus->command == 0xbe && size == 9);
    const auto* device = selected(bus);
    if (!device) {
        std::fill_n(bytes, size, 0xff);
        return ESP_OK;
    }
    auto data = scratch(device->temperature);
    if (device->badCrc)
        data[8] ^= 1;
    std::copy(data.begin(), data.end(), bytes);
    return ESP_OK;
}

esp_err_t onewire_new_device_iter(onewire_bus_handle_t bus, onewire_device_iter_handle_t* iter)
{
    *iter = new FakeIterator{bus};
    return ESP_OK;
}

esp_err_t onewire_del_device_iter(onewire_device_iter_handle_t iter)
{
    delete iter;
    return ESP_OK;
}

esp_err_t onewire_device_iter_get_next(onewire_device_iter_handle_t iter, onewire_device_t* result)
{
    if (duringSearch) {
        auto callback = std::move(duringSearch);
        duringSearch = {};
        callback();
    }
    auto& devices = wire[iter->bus->gpio];
    if (iter->index == devices.size())
        return ESP_ERR_NOT_FOUND;
    result->bus = iter->bus;
    result->address = devices[iter->index++].address;
    return ESP_OK;
}

int main(int argc, char** argv)
{
    try {
        CHECK(argc == 2);
        const std::map<std::string, void (*)()> cases{
            {"codec", codec},
            {"multiwire", multiwire},
            {"dht", dht},
            {"scan_disabled", scan_disabled},
            {"read_faults", read_faults},
            {"conversion_timeout", conversion_timeout},
            {"stale", stale},
            {"reconfigure", reconfigure},
            {"parasite", parasite},
            {"fair_ports", fair_ports},
            {"ibutton_codec", ibutton_codec},
            {"ibutton_touch", ibutton_touch},
            {"ibutton_faults", ibutton_faults},
            {"ibutton_scan", ibutton_scan},
            {"ibutton_stale", ibutton_stale},
            {"ibutton_rebind", ibutton_rebind},
            {"ibutton_during_conversion", ibutton_during_conversion},
            {"ibutton_crc", ibutton_crc},
            {"ibutton_multiple", ibutton_multiple},
            {"ibutton_scan_cancel", ibutton_scan_cancel},
            {"ibutton_enrollment_release", ibutton_enrollment_release}};
        cases.at(argv[1])();
        std::cout << argv[1] << ": PASS\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
