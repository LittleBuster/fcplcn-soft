#include "system/system_metrics.h"
#include "test_driver.h"

#include <atomic>
#include <cmath>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
#define REQUIRE(condition)                                                                         \
    do {                                                                                           \
        if (!(condition))                                                                          \
            throw std::runtime_error(std::string(__func__) + ": " #condition);                     \
    } while (false)

Json snapshot()
{
    Json value(system_metrics_json(), cJSON_Delete);
    REQUIRE(value != nullptr);
    return value;
}

const cJSON* temperature(const Json& value)
{
    const auto* result = cJSON_GetObjectItemCaseSensitive(value.get(), "chipTemperatureC");
    REQUIRE(result != nullptr);
    return result;
}

void null_temperature()
{
    const auto value = snapshot();
    REQUIRE(cJSON_IsNull(temperature(value)));
}

void numeric_temperature(double expected)
{
    const auto value = snapshot();
    const auto* item = temperature(value);
    REQUIRE(cJSON_IsNumber(item));
    REQUIRE(std::abs(item->valuedouble - expected) < 0.000001);
}

void before_init()
{
    null_temperature();
    REQUIRE(test_driver::reads == 0);
}

void install_failure()
{
    test_driver::install_result = ESP_FAIL;
    system_metrics_init();
    null_temperature();
    REQUIRE(test_driver::installs == 1);
    REQUIRE(test_driver::enables == 0);
    REQUIRE(test_driver::reads == 0);
    REQUIRE(test_driver::warnings == 1);
}

void enable_failure()
{
    test_driver::enable_result = ESP_FAIL;
    system_metrics_init();
    null_temperature();
    REQUIRE(test_driver::enables == 1);
    REQUIRE(test_driver::uninstalls == 1);
    REQUIRE(test_driver::reads == 0);
    test_driver::enable_result = ESP_OK;
    system_metrics_init();
    numeric_temperature(43.25);
    REQUIRE(test_driver::installs == 2);
    REQUIRE(test_driver::uninstalls == 1);
}

void retry()
{
    test_driver::install_result = ESP_FAIL;
    system_metrics_init();
    test_driver::install_result = ESP_OK;
    system_metrics_init();
    numeric_temperature(43.25);
    REQUIRE(test_driver::installs == 2);
    REQUIRE(test_driver::installed_config.range_min == 20);
    REQUIRE(test_driver::installed_config.range_max == 100);
}

void read_failure()
{
    system_metrics_init();
    test_driver::read_result = ESP_FAIL;
    null_temperature();
    test_driver::read_result = ESP_OK;
    test_driver::reading = std::numeric_limits<float>::quiet_NaN();
    null_temperature();
    test_driver::reading = std::numeric_limits<float>::infinity();
    null_temperature();
    test_driver::reading = 43.25F;
    numeric_temperature(43.25);
}

void zero()
{
    test_driver::reading = 0;
    system_metrics_init();
    numeric_temperature(0);
}

void idempotent()
{
    std::vector<std::thread> threads;
    for (int i = 0; i < 8; ++i)
        threads.emplace_back(system_metrics_init);
    for (auto& thread : threads)
        thread.join();
    system_metrics_init();
    REQUIRE(test_driver::installs == 1);
    REQUIRE(test_driver::enables == 1);
    numeric_temperature(43.25);
}

void concurrent_reads()
{
    system_metrics_init();
    test_driver::read_delay_ms = 1;
    std::atomic<unsigned> ready{0}, failures{0};
    std::atomic<bool> start{false};
    std::vector<std::thread> threads;
    for (int i = 0; i < 8; ++i)
        threads.emplace_back([&] {
            ++ready;
            while (!start.load())
                std::this_thread::yield();
            for (int sample = 0; sample < 10; ++sample) {
                Json value(system_metrics_json(), cJSON_Delete);
                const auto* item =
                    value ? cJSON_GetObjectItemCaseSensitive(value.get(), "chipTemperatureC")
                          : nullptr;
                if (!cJSON_IsNumber(item) || std::abs(item->valuedouble - 43.25) > 0.000001)
                    ++failures;
            }
        });
    while (ready.load() != 8)
        std::this_thread::yield();
    start = true;
    for (auto& thread : threads)
        thread.join();
    REQUIRE(failures == 0);
    REQUIRE(test_driver::reads == 80);
    REQUIRE(test_driver::max_parallel_reads == 1);
}
}  // namespace

int main(int argc, char** argv)
{
    const std::pair<const char*, std::function<void()>> cases[] = {
        {"before_init", before_init},
        {"install_failure", install_failure},
        {"enable_failure", enable_failure},
        {"retry", retry},
        {"read_failure", read_failure},
        {"zero", zero},
        {"idempotent", idempotent},
        {"concurrent_reads", concurrent_reads},
    };
    try {
        if (argc != 2)
            throw std::runtime_error("Pass exactly one metrics case name");
        for (const auto& item : cases)
            if (item.first == std::string(argv[1])) {
                item.second();
                std::cout << "PASS " << item.first << '\n';
                return 0;
            }
        throw std::runtime_error("Unknown metrics case");
    } catch (const std::exception& error) {
        std::cerr << "FAIL " << error.what() << '\n';
        return 1;
    }
}
