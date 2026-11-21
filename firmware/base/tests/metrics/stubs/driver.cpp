#include "test_driver.h"
#include "esp_log.h"

#include <chrono>
#include <thread>

struct temperature_sensor_obj_t {
    bool enabled = false;
};

namespace {
temperature_sensor_obj_t device;
std::atomic<unsigned> active_reads{0};
}  // namespace

namespace test_driver {
esp_err_t install_result = ESP_OK;
esp_err_t enable_result = ESP_OK;
esp_err_t read_result = ESP_OK;
float reading = 43.25F;
unsigned read_delay_ms = 0;
temperature_sensor_config_t installed_config{};
std::atomic<unsigned> installs{0}, enables{0}, uninstalls{0}, reads{0}, warnings{0},
    max_parallel_reads{0};
}  // namespace test_driver

const char* esp_err_to_name(esp_err_t error)
{
    return error == ESP_OK ? "ESP_OK" : "ESP_FAIL";
}

void metrics_test_log_warning(const char*, const char*, ...)
{
    ++test_driver::warnings;
}

esp_err_t temperature_sensor_install(const temperature_sensor_config_t* config,
                                     temperature_sensor_handle_t* output)
{
    ++test_driver::installs;
    if (!config || !output)
        return ESP_ERR_INVALID_ARG;
    test_driver::installed_config = *config;
    if (test_driver::install_result != ESP_OK)
        return test_driver::install_result;
    device.enabled = false;
    *output = &device;
    return ESP_OK;
}

esp_err_t temperature_sensor_enable(temperature_sensor_handle_t sensor)
{
    ++test_driver::enables;
    if (sensor != &device)
        return ESP_ERR_INVALID_ARG;
    if (test_driver::enable_result == ESP_OK)
        device.enabled = true;
    return test_driver::enable_result;
}

esp_err_t temperature_sensor_uninstall(temperature_sensor_handle_t sensor)
{
    ++test_driver::uninstalls;
    if (sensor != &device)
        return ESP_ERR_INVALID_ARG;
    device.enabled = false;
    return ESP_OK;
}

esp_err_t temperature_sensor_get_celsius(temperature_sensor_handle_t sensor, float* output)
{
    ++test_driver::reads;
    if (sensor != &device || !device.enabled || !output)
        return ESP_ERR_INVALID_STATE;
    const unsigned active = active_reads.fetch_add(1) + 1;
    unsigned maximum = test_driver::max_parallel_reads.load();
    while (maximum < active
           && !test_driver::max_parallel_reads.compare_exchange_weak(maximum, active)) {
    }
    if (test_driver::read_delay_ms)
        std::this_thread::sleep_for(std::chrono::milliseconds(test_driver::read_delay_ms));
    *output = test_driver::reading;
    active_reads.fetch_sub(1);
    return test_driver::read_result;
}
