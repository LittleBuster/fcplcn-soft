#include "test_platform.h"
#include "hardware/hardware_io.h"
#include "hardware/rtc_codec.h"
#include "freertos/task.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>

namespace {
struct Failure {
    bool write;
    std::uint8_t reg;
    int remaining;
};

std::mutex model_mutex;
std::array<std::uint8_t, 256> registers{};
std::vector<rtc_test::Event> events;
std::vector<Failure> failures;
std::atomic<std::int64_t> clock_us{1'000'000};
std::atomic<int> active{0}, max_active{0};
bool device_present = true;
bool corrupt_readback = false;
bool calendar_written = false;
int offset_seconds = 0;
int ignored_reg = -1;
int tasks = 0;

struct Transaction {
    Transaction()
    {
        const auto current = ++active;
        auto maximum = max_active.load();
        while (maximum < current && !max_active.compare_exchange_weak(maximum, current)) {
        }
        std::this_thread::sleep_for(std::chrono::microseconds(100));
    }

    ~Transaction()
    {
        --active;
    }
};

bool fail_transaction(bool write, std::uint8_t reg)
{
    for (auto i = failures.begin(); i != failures.end(); ++i) {
        if (i->write == write && i->reg == reg && --i->remaining == 0) {
            failures.erase(i);
            return true;
        }
    }
    return false;
}
}  // namespace

namespace rtc_test {
void reset_model()
{
    std::lock_guard<std::mutex> lock(model_mutex);
    registers.fill(0);
    events.clear();
    failures.clear();
    device_present = true;
    corrupt_readback = false;
    calendar_written = false;
    offset_seconds = 0;
    ignored_reg = -1;
    clock_us = 1'000'000;
    max_active = 0;
}

void calendar(std::int64_t unix_time, std::uint8_t status)
{
    std::uint8_t bytes[7]{};
    rtc_encode_calendar(unix_time, bytes);
    std::lock_guard<std::mutex> lock(model_mutex);
    std::copy(std::begin(bytes), std::end(bytes), registers.begin());
    registers[0x0f] = status;
    calendar_written = false;
}

void set_register(std::uint8_t reg, std::uint8_t value)
{
    std::lock_guard<std::mutex> lock(model_mutex);
    registers[reg] = value;
}

std::uint8_t get_register(std::uint8_t reg)
{
    std::lock_guard<std::mutex> lock(model_mutex);
    return registers[reg];
}

void present(bool value)
{
    std::lock_guard<std::mutex> lock(model_mutex);
    device_present = value;
}

void now(std::int64_t us)
{
    clock_us = us;
}

void fail(bool write, std::uint8_t reg, int matching_call)
{
    std::lock_guard<std::mutex> lock(model_mutex);
    failures.push_back({write, reg, matching_call});
}

void ignore_write(std::uint8_t reg)
{
    std::lock_guard<std::mutex> lock(model_mutex);
    ignored_reg = reg;
}

void corrupt_calendar_readback(bool value)
{
    std::lock_guard<std::mutex> lock(model_mutex);
    corrupt_readback = value;
}

void readback_offset(int seconds)
{
    std::lock_guard<std::mutex> lock(model_mutex);
    offset_seconds = seconds;
}

void clear_trace()
{
    std::lock_guard<std::mutex> lock(model_mutex);
    events.clear();
    max_active = 0;
}

std::vector<Event> trace()
{
    std::lock_guard<std::mutex> lock(model_mutex);
    return events;
}

int max_parallel_transactions()
{
    return max_active;
}

int task_count()
{
    return tasks;
}
}  // namespace rtc_test

std::int64_t esp_timer_get_time()
{
    return clock_us.load();
}

const char* esp_err_to_name(esp_err_t error)
{
    switch (error) {
        case ESP_OK:
            return "ESP_OK";
        case ESP_FAIL:
            return "ESP_FAIL";
        case ESP_ERR_INVALID_ARG:
            return "ESP_ERR_INVALID_ARG";
        case ESP_ERR_NOT_FOUND:
            return "ESP_ERR_NOT_FOUND";
        case ESP_ERR_NOT_SUPPORTED:
            return "ESP_ERR_NOT_SUPPORTED";
        default:
            return "ESP_ERR_TIMEOUT";
    }
}

void rtc_test_log(const char*, const char*, ...)
{
}

BaseType_t
xTaskCreate(TaskFunction_t, const char*, std::uint32_t, void*, UBaseType_t, TaskHandle_t* handle)
{
    ++tasks;
    if (handle != nullptr)
        *handle = reinterpret_cast<void*>(1);
    return pdPASS;
}

void vTaskDelay(TickType_t)
{
}

esp_err_t hardware_i2c_read(std::string_view bus,
                            std::uint8_t address,
                            std::uint8_t reg,
                            std::uint8_t* bytes,
                            std::size_t length)
{
    Transaction transaction;
    std::lock_guard<std::mutex> lock(model_mutex);
    if (bus != "io-expanders" || address != 0x68 || bytes == nullptr || length == 0
        || length > 256U - reg)
        return ESP_ERR_INVALID_ARG;
    events.push_back({false, reg, {}, std::this_thread::get_id()});
    if (!device_present)
        return ESP_ERR_NOT_FOUND;
    if (fail_transaction(false, reg))
        return ESP_ERR_TIMEOUT;
    std::copy_n(registers.begin() + reg, length, bytes);
    if (reg == 0 && length == 7 && calendar_written) {
        if (corrupt_readback)
            bytes[0] = 0x6a;
        else if (offset_seconds != 0) {
            std::uint8_t calendar[7]{};
            std::copy_n(bytes, 7, calendar);
            std::int64_t value = 0;
            if (rtc_decode_calendar(calendar, 0, value)
                && rtc_encode_calendar(value + offset_seconds, calendar))
                std::copy_n(calendar, 7, bytes);
        }
    }
    events.back().bytes.assign(bytes, bytes + length);
    return ESP_OK;
}

esp_err_t hardware_i2c_write(std::string_view bus,
                             std::uint8_t address,
                             std::uint8_t reg,
                             const std::uint8_t* bytes,
                             std::size_t length)
{
    Transaction transaction;
    std::lock_guard<std::mutex> lock(model_mutex);
    if (bus != "io-expanders" || address != 0x68 || bytes == nullptr || length == 0
        || length > 256U - reg)
        return ESP_ERR_INVALID_ARG;
    events.push_back(
        {true, reg, std::vector<std::uint8_t>(bytes, bytes + length), std::this_thread::get_id()});
    if (!device_present)
        return ESP_ERR_NOT_FOUND;
    if (fail_transaction(true, reg))
        return ESP_ERR_TIMEOUT;
    if (ignored_reg != reg)
        std::copy_n(bytes, length, registers.begin() + reg);
    if (reg == 0 && length == 7)
        calendar_written = true;
    return ESP_OK;
}
