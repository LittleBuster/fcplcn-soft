#include "test_driver.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "freertos/task.h"
#include <array>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>

struct FakeI2cBus {
    int index;
};

struct FakeI2cDevice {
    FakeI2cBus* bus;
    std::uint8_t address;
};

namespace {
struct Device {
    bool present = false, failRead = false, failWrite = false, nackAfterWrite = false,
         ignoreWrite = false, failLatchReadback = false, ignoreOnLatch = false;
    int readCountdown = -1, writeCountdown = -1, ignoreRegister = -1, nackRegister = -1;
    std::array<std::uint8_t, 256> regs{};
    std::uint16_t inputs = 0xffff, forcedGpioMask = 0, forcedGpioLevels = 0;
    std::size_t corruptOffset = 0;
    std::uint8_t corruptXor = 0;
};

std::array<std::array<Device, 128>, 2> devices;
std::array<std::uint8_t, 8192> framBytes{};
std::array<FakeI2cBus, 2> buses{{{0}, {1}}};
std::vector<std::unique_ptr<FakeI2cDevice>> handles;
std::vector<io_test::Transfer> history;
std::vector<io_test::GpioCall> gpioHistory;
std::mutex mutex;
std::atomic<std::int64_t> timeUs{1000000};
std::atomic<std::int64_t> nextReadElapsedUs{0};
std::atomic<unsigned> workers{0}, busCount{0}, delayMs{0};
std::array<std::atomic<unsigned>, 2> active{}, peak{};
std::array<int, 64> gpioLevels{};
int failedGpio = -1;

struct Defaults {
    Defaults()
    {
        for (auto address : {0x20, 0x21, 0x68})
            devices[0][address].present = true;
        devices[1][0x44].present = true;
        for (auto& bus : devices)
            for (auto& d : bus) {
                d.regs[0] = 0xff;
                d.regs[1] = 0xff;
            }
    }
} defaults;

struct Transaction {
    int bus;

    explicit Transaction(int b) : bus(b)
    {
        const auto n = ++active[b];
        auto old = peak[b].load();
        while (old < n && !peak[b].compare_exchange_weak(old, n)) {
        }
        if (delayMs)
            std::this_thread::sleep_for(std::chrono::milliseconds(delayMs.load()));
    }

    ~Transaction()
    {
        --active[bus];
    }
};

std::uint16_t pair(const Device& d, std::uint8_t reg)
{
    return d.regs[reg] | (static_cast<std::uint16_t>(d.regs[reg + 1]) << 8);
}

bool is_mcp(int bus, std::uint8_t address)
{
    return bus == 0 && (address == 0x20 || address == 0x21);
}

// Microchip DS20001952C table 3-1 and section 3.2.1. In byte mode,
// BANK=0 toggles A/B addresses; BANK=1 repeats the same register.
int canonical_register(const Device& d, std::uint8_t wire)
{
    if (!(d.regs[0x0a] & 0x80))
        return wire <= 0x15 ? wire : -1;
    if (wire <= 0x0a)
        return wire * 2;
    if (wire >= 0x10 && wire <= 0x1a)
        return (wire - 0x10) * 2 + 1;
    return -1;
}

std::uint8_t next_register(const Device& d, std::uint8_t wire)
{
    const auto iocon = d.regs[0x0a];
    if (iocon & 0x20)
        return (iocon & 0x80) ? wire : static_cast<std::uint8_t>(wire ^ 1);
    return wire >= ((iocon & 0x80) ? 0x1a : 0x15) ? 0 : static_cast<std::uint8_t>(wire + 1);
}

void write_canonical(Device& d, std::uint8_t reg, std::uint8_t value)
{
    if (reg == 0x0a || reg == 0x0b) {
        d.regs[0x0a] = d.regs[0x0b] = value & 0xfe;
        return;
    }
    if (reg == 0x12 || reg == 0x13) {
        d.regs[reg + 2] = value;
        return;
    }
    if (reg == 0x0e || reg == 0x0f || reg == 0x10 || reg == 0x11)
        return;
    d.regs[reg] = value;
}

void reset_registers(Device& d)
{
    d.regs.fill(0);
    d.regs[0] = d.regs[1] = 0xff;
}

std::uint8_t read_canonical(const Device& d, std::uint8_t reg)
{
    if (reg != 0x12 && reg != 0x13)
        return d.regs[reg];
    const auto direction = pair(d, 0), latch = pair(d, 0x14), polarity = pair(d, 2);
    const auto physical = static_cast<std::uint16_t>((d.inputs & direction) | (latch & ~direction));
    const auto levels = static_cast<std::uint16_t>((physical & ~d.forcedGpioMask)
                                                   | (d.forcedGpioLevels & d.forcedGpioMask));
    const auto gpio = static_cast<std::uint16_t>(levels ^ (polarity & direction));
    return reg == 0x12 ? static_cast<std::uint8_t>(gpio) : static_cast<std::uint8_t>(gpio >> 8);
}
}  // namespace

namespace io_test {
const std::vector<GpioCall>& gpio_calls()
{
    return gpioHistory;
}

void set_present(int bus, std::uint8_t address, bool value)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].present = value;
}

void input_levels(int bus, std::uint8_t address, std::uint16_t value)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].inputs = value;
}

void fail_next_read(int bus, std::uint8_t address)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].failRead = true;
}

void fail_read_after(int bus, std::uint8_t address, int successfulReads)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].readCountdown = successfulReads;
}

void fail_next_write(int bus, std::uint8_t address)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].failWrite = true;
}

void fail_next_gpio_write(int gpio)
{
    std::lock_guard<std::mutex> l(mutex);
    failedGpio = gpio;
}

void fail_write_after(int bus, std::uint8_t address, int successfulWrites)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].writeCountdown = successfulWrites;
}

void reset_mcp(int bus, std::uint8_t address)
{
    std::lock_guard<std::mutex> l(mutex);
    reset_registers(devices[bus][address]);
}

void corrupt_register(int bus, std::uint8_t address, std::uint8_t reg, std::uint8_t value)
{
    std::lock_guard<std::mutex> l(mutex);
    auto& d = devices[bus][address];
    if (reg == 0x0a || reg == 0x0b)
        d.regs[0x0a] = d.regs[0x0b] = value & 0xfe;
    else
        d.regs[reg] = value;
}

void corrupt_pair(int bus, std::uint8_t address, std::uint8_t reg, std::uint16_t value)
{
    corrupt_register(bus, address, reg, static_cast<std::uint8_t>(value));
    corrupt_register(bus, address, reg + 1, static_cast<std::uint8_t>(value >> 8));
}

void force_gpio(int bus, std::uint8_t address, std::uint16_t mask, std::uint16_t levels)
{
    std::lock_guard<std::mutex> l(mutex);
    auto& d = devices[bus][address];
    d.forcedGpioMask = mask;
    d.forcedGpioLevels = levels;
}

void corrupt_next_read(int bus, std::uint8_t address, std::size_t byteOffset, std::uint8_t xorMask)
{
    std::lock_guard<std::mutex> l(mutex);
    auto& d = devices[bus][address];
    d.corruptOffset = byteOffset;
    d.corruptXor = xorMask;
}

void nack_after_next_write(int bus, std::uint8_t address)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].nackAfterWrite = true;
}

void ignore_next_write(int bus, std::uint8_t address)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].ignoreWrite = true;
}

void ignore_next_write_to(int bus, std::uint8_t address, std::uint8_t reg)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].ignoreRegister = reg;
}

void nack_after_next_write_to(int bus, std::uint8_t address, std::uint8_t reg)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].nackRegister = reg;
}

void fail_readback_after_next_latch_write(int bus, std::uint8_t address)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].failLatchReadback = true;
}

void ignore_next_nonzero_latch_write(int bus, std::uint8_t address)
{
    std::lock_guard<std::mutex> l(mutex);
    devices[bus][address].ignoreOnLatch = true;
}

std::uint16_t register_pair(int bus, std::uint8_t address, std::uint8_t reg)
{
    std::lock_guard<std::mutex> l(mutex);
    return pair(devices[bus][address], reg);
}

std::vector<Transfer> transfers()
{
    std::lock_guard<std::mutex> l(mutex);
    return history;
}

void advance(std::uint32_t ms)
{
    timeUs += static_cast<std::int64_t>(ms) * 1000;
}

void elapse_next_read_ms(std::uint32_t ms)
{
    nextReadElapsedUs = static_cast<std::int64_t>(ms) * 1000;
}

unsigned worker_creations()
{
    return workers;
}

unsigned bus_creations()
{
    return busCount;
}

void transfer_delay(unsigned value)
{
    delayMs = value;
}

unsigned max_parallel(int bus)
{
    return peak[bus];
}
}  // namespace io_test

const char* esp_err_to_name(esp_err_t e)
{
    switch (e) {
        case ESP_OK:
            return "ESP_OK";
        case ESP_ERR_TIMEOUT:
            return "ESP_ERR_TIMEOUT";
        case ESP_ERR_NOT_FOUND:
            return "ESP_ERR_NOT_FOUND";
        case ESP_ERR_INVALID_RESPONSE:
            return "ESP_ERR_INVALID_RESPONSE";
        case ESP_ERR_INVALID_ARG:
            return "ESP_ERR_INVALID_ARG";
        default:
            return "ESP_ERR_INVALID_STATE";
    }
}

std::int64_t esp_timer_get_time()
{
    return timeUs;
}

void esp_rom_delay_us(std::uint32_t us)
{
    timeUs += us;
}

esp_err_t gpio_set_level(gpio_num_t gpio, std::uint32_t level)
{
    gpioHistory.push_back({io_test::GpioOperation::Level, gpio, level != 0});
    if (failedGpio == gpio) {
        failedGpio = -1;
        return ESP_FAIL;
    }
    gpioLevels.at(gpio) = level != 0;
    return ESP_OK;
}

int gpio_get_level(gpio_num_t gpio)
{
    return gpioLevels.at(gpio);
}

esp_err_t gpio_config(const gpio_config_t*)
{
    return ESP_OK;
}

esp_err_t gpio_set_direction(gpio_num_t gpio, gpio_mode_t mode)
{
    gpioHistory.push_back({io_test::GpioOperation::Direction, gpio, mode});
    return ESP_OK;
}

esp_err_t gpio_set_pull_mode(gpio_num_t gpio, gpio_pull_mode_t mode)
{
    gpioHistory.push_back({io_test::GpioOperation::Pull, gpio, mode});
    return ESP_OK;
}

BaseType_t
xTaskCreate(TaskFunction_t, const char*, std::uint32_t, void*, UBaseType_t, TaskHandle_t*)
{
    ++workers;
    return pdPASS;
}

void vTaskDelay(TickType_t ticks)
{
    io_test::advance(ticks);
}

esp_err_t i2c_new_master_bus(const i2c_master_bus_config_t* config, i2c_master_bus_handle_t* output)
{
    const bool internal = (config->sda_io_num == 4 && config->scl_io_num == 5)
                          || (config->sda_io_num == 2 && config->scl_io_num == 1);
    const bool external = (config->sda_io_num == 41 && config->scl_io_num == 42)
                          || (config->sda_io_num == 6 && config->scl_io_num == 7);
    const int index = internal ? 0 : external ? 1 : -1;
    if (index < 0)
        return ESP_ERR_INVALID_ARG;
    *output = &buses[index];
    ++busCount;
    return ESP_OK;
}

esp_err_t i2c_master_bus_reset(i2c_master_bus_handle_t)
{
    return ESP_OK;
}

esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t bus,
                                    const i2c_device_config_t* config,
                                    i2c_master_dev_handle_t* output)
{
    std::lock_guard<std::mutex> l(mutex);
    handles.push_back(std::make_unique<FakeI2cDevice>(
        FakeI2cDevice{bus, static_cast<std::uint8_t>(config->device_address)}));
    *output = handles.back().get();
    return ESP_OK;
}

esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t)
{
    return ESP_OK;
}

esp_err_t i2c_del_master_bus(i2c_master_bus_handle_t)
{
    return ESP_OK;
}

esp_err_t i2c_master_transmit(i2c_master_dev_handle_t handle,
                              const std::uint8_t* bytes,
                              std::size_t len,
                              int timeout)
{
    Transaction transaction(handle->bus->index);
    std::lock_guard<std::mutex> l(mutex);
    if (len < 2)
        return ESP_ERR_INVALID_ARG;
    const bool fram = handle->bus->index == 0 && handle->address == 0x50;
    if (fram && len < 3)
        return ESP_ERR_INVALID_ARG;
    const auto first = fram ? 2U : 1U;
    const std::uint16_t offset =
        fram ? (static_cast<std::uint16_t>(bytes[0]) << 8) | bytes[1] : bytes[0];
    auto& d = devices[handle->bus->index][handle->address];
    history.push_back({"write",
                       handle->bus->index,
                       handle->address,
                       offset,
                       {bytes + first, bytes + len},
                       timeout});
    if (!d.present || d.failWrite) {
        d.failWrite = false;
        return ESP_ERR_TIMEOUT;
    }
    if (d.writeCountdown == 0) {
        d.writeCountdown = -1;
        return ESP_ERR_TIMEOUT;
    }
    if (d.writeCountdown > 0)
        --d.writeCountdown;
    const bool ignoreRegister = d.ignoreRegister == bytes[0];
    if (ignoreRegister)
        d.ignoreRegister = -1;
    const bool ignoreOn = d.ignoreOnLatch && bytes[0] == 0x14 && len == 3 && (bytes[1] || bytes[2]);
    if (ignoreOn)
        d.ignoreOnLatch = false;
    const bool apply = !d.ignoreWrite && !ignoreRegister && !ignoreOn;
    d.ignoreWrite = false;
    if (fram) {
        for (std::size_t i = first; i < len; ++i)
            if (apply)
                framBytes[(offset + i - first) % framBytes.size()] = bytes[i];
        if (d.nackAfterWrite) {
            d.nackAfterWrite = false;
            return ESP_ERR_TIMEOUT;
        }
        return ESP_OK;
    }
    std::uint8_t pointer = bytes[0];
    for (std::size_t i = 1; i < len; ++i) {
        if (is_mcp(handle->bus->index, handle->address)) {
            const auto reg = canonical_register(d, pointer);
            if (apply && reg >= 0)
                write_canonical(d, static_cast<std::uint8_t>(reg), bytes[i]);
            pointer = next_register(d, pointer);
        } else {
            if (apply)
                d.regs[pointer] = bytes[i];
            ++pointer;
        }
    }
    if (d.failLatchReadback && bytes[0] == 0x14) {
        d.failLatchReadback = false;
        d.failRead = true;
    }
    if (d.nackAfterWrite || d.nackRegister == bytes[0]) {
        d.nackAfterWrite = false;
        d.nackRegister = -1;
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t handle,
                                      const std::uint8_t* bytes,
                                      std::size_t len,
                                      std::uint8_t* out,
                                      std::size_t outlen,
                                      int timeout)
{
    Transaction transaction(handle->bus->index);
    std::lock_guard<std::mutex> l(mutex);
    const bool fram = handle->bus->index == 0 && handle->address == 0x50;
    if (len != (fram ? 2U : 1U))
        return ESP_ERR_INVALID_ARG;
    const std::uint16_t offset =
        fram ? (static_cast<std::uint16_t>(bytes[0]) << 8) | bytes[1] : bytes[0];
    auto& d = devices[handle->bus->index][handle->address];
    history.push_back({"read", handle->bus->index, handle->address, offset, {}, timeout});
    if (!d.present || d.failRead) {
        d.failRead = false;
        return ESP_ERR_TIMEOUT;
    }
    if (d.readCountdown == 0) {
        d.readCountdown = -1;
        return ESP_ERR_TIMEOUT;
    }
    if (d.readCountdown > 0)
        --d.readCountdown;
    timeUs += nextReadElapsedUs.exchange(0);
    std::uint8_t pointer = bytes[0];
    for (std::size_t i = 0; i < outlen; ++i) {
        if (fram)
            out[i] = framBytes[(offset + i) % framBytes.size()];
        else if (is_mcp(handle->bus->index, handle->address)) {
            const auto reg = canonical_register(d, pointer);
            out[i] = reg < 0 ? 0 : read_canonical(d, static_cast<std::uint8_t>(reg));
            pointer = next_register(d, pointer);
        } else
            out[i] = d.regs[pointer++];
    }
    if (d.corruptXor && d.corruptOffset < outlen) {
        out[d.corruptOffset] ^= d.corruptXor;
        d.corruptXor = 0;
    }
    return ESP_OK;
}

esp_err_t i2c_master_probe(i2c_master_bus_handle_t bus, std::uint16_t address, int timeout)
{
    // Like ESP-IDF, a zero-tick ISR wait cannot wait for an ordinary wire ACK.
    if (pdMS_TO_TICKS(timeout) == 0)
        return ESP_ERR_TIMEOUT;
    Transaction transaction(bus->index);
    std::lock_guard<std::mutex> l(mutex);
    history.push_back({"probe", bus->index, static_cast<std::uint8_t>(address), 0, {}, timeout});
    return devices[bus->index][address].present ? ESP_OK : ESP_ERR_NOT_FOUND;
}
