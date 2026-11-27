/**
 * @file chip_temperature.cpp
 * @brief Serialized access to the ESP32 on-die temperature sensor.
 */
#include "chip_temperature.h"

#include <cmath>
#include <mutex>
#include "driver/temperature_sensor.h"

namespace {
std::mutex sensor_mutex;
temperature_sensor_handle_t sensor = nullptr;
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Install and enable the internal temperature sensor.
 * @return ESP_OK when ready, or the installation/enable error.
 * @note Thread-safe and idempotent after success. An unsuccessful call may be retried.
 * @endcond
 */
esp_err_t chip_temperature_init()
{
    std::lock_guard<std::mutex> lock(sensor_mutex);
    if (sensor != nullptr)
        return ESP_OK;
    // One supported range covering normal operating chip temperatures.
    const temperature_sensor_config_t settings = TEMPERATURE_SENSOR_CONFIG_DEFAULT(20, 100);
    temperature_sensor_handle_t candidate = nullptr;
    auto result = temperature_sensor_install(&settings, &candidate);
    if (result != ESP_OK)
        return result;
    result = temperature_sensor_enable(candidate);
    if (result != ESP_OK) {
        temperature_sensor_uninstall(candidate);
        return result;
    }
    sensor = candidate;
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read the current chip temperature in degrees Celsius.
 * @return A finite temperature, or nullopt when the sensor is unavailable.
 * @note Thread-safe. This reading describes the chip itself.
 * @endcond
 */
std::optional<float> chip_temperature_read()
{
    std::lock_guard<std::mutex> lock(sensor_mutex);
    float celsius = 0;
    if (sensor != nullptr && temperature_sensor_get_celsius(sensor, &celsius) == ESP_OK
        && std::isfinite(celsius))
        return celsius;
    return std::nullopt;
}
