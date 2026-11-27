/**
 * @file chip_temperature.h
 * @brief ESP32 on-die temperature measurement for device diagnostics.
 */
#pragma once

#include <optional>
#include "esp_err.h"

/**
 * @brief Install and enable the internal temperature sensor.
 * @return ESP_OK when ready, or the installation/enable error.
 * @note Thread-safe and idempotent after success. An unsuccessful call may be retried.
 */
esp_err_t chip_temperature_init();

/**
 * @brief Read the current chip temperature in degrees Celsius.
 * @return A finite temperature, or nullopt when the sensor is unavailable.
 * @note Thread-safe. This reading describes the chip itself.
 */
std::optional<float> chip_temperature_read();
