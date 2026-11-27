/**
 * @file sensor_worker.h
 * @brief Shared acquisition scheduling for Meteo and iButton.
 */
#pragma once

#include <cstdint>

#include "esp_err.h"

/**
 * @brief Initialize the sensor-port caches and start the acquisition task once.
 * @return ESP_OK or the initial worker-allocation error.
 */
esp_err_t sensor_worker_init();

/**
 * @brief Return the shared worker's startup result.
 * @return ESP_ERR_INVALID_STATE before startup, then the result of the first initialization.
 */
esp_err_t sensor_worker_status();

/** @brief Initialize the Meteo caches before starting the shared worker. */
void meteo_worker_prepare();

/**
 * @brief Run one due Meteo job on the shared worker.
 * @param waitForConversion Scheduler callback used after releasing the RMT bus.
 * @return True when a job ran.
 */
bool meteo_worker_step(void (*waitForConversion)(std::int64_t));
