/**
 * @file sensor_worker.cpp
 * @brief Single owner of the sensor buses across periodic polls and discovery.
 */
#include "sensors/sensor_worker.h"

#include <algorithm>
#include <atomic>
#include <mutex>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "platform/runtime_supervisor.h"
#include "sensors/ibutton.h"
#include "sensors/meteo_sensors.h"

namespace {
std::once_flag startup;
std::atomic<esp_err_t> startup_error{ESP_ERR_INVALID_STATE};

/**
 * @brief Read the worker's monotonic clock in whole milliseconds.
 * @return ESP uptime independent of wall-clock changes.
 */
std::int64_t now_ms()
{
    return esp_timer_get_time() / 1000;
}

/**
 * @brief Service short iButton touches while externally powered DS18B20 devices convert.
 * @param delayMs Minimum conversion time in milliseconds.
 * @pre The DS18B20 driver has closed its transient bus before yielding to the reader.
 */
void wait_for_conversion(std::int64_t delayMs)
{
    const auto deadline = now_ms() + delayMs;
    while (now_ms() < deadline) {
        ibutton_worker_step();
        const auto remaining = deadline - now_ms();
        if (remaining > 0) {
            vTaskDelay(
                std::max<TickType_t>(1, pdMS_TO_TICKS(std::min<std::int64_t>(25, remaining))));
        }
    }
}

/**
 * @brief Give due iButton work priority before taking the next Meteo job.
 * @return True if at least one job was executed.
 */
bool sensor_step()
{
    return ibutton_worker_step() || meteo_worker_step(wait_for_conversion);
}

/**
 * @brief Run acquisition independently of HTTP and controller tasks.
 * @note The unused FreeRTOS argument is ignored. Idle iterations yield for 50 ms.
 */
void sensor_task(void*)
{
    runtime_task_observe(RuntimeTask::Meteo);
    while (true) {
        if (!sensor_step()) {
            vTaskDelay(pdMS_TO_TICKS(50));
        }
    }
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Initialize the sensor-port caches and start the acquisition task once.
 * @return ESP_OK or the initial worker-allocation error.
 * @endcond
 */
esp_err_t sensor_worker_init()
{
    std::call_once(startup, [] {
        meteo_worker_prepare();
        startup_error.store(xTaskCreate(sensor_task, "fcplcn_meteo", 6144, nullptr, 3, nullptr)
                                    == pdPASS
                                ? ESP_OK
                                : ESP_ERR_NO_MEM);
    });
    return sensor_worker_status();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Return the startup result without waiting for a sensor or acquiring a cache lock.
 * @return ESP_ERR_INVALID_STATE before startup, then the first initialization result.
 * @endcond
 */
esp_err_t sensor_worker_status()
{
    return startup_error.load();
}

#ifdef FCPLCN_METEO_SENSORS_TESTING
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Execute one scheduled host-test job using the production scheduler.
 * @return True if a job was run.
 * @endcond
 */
bool meteo_sensors_test_step()
{
    return sensor_step();
}
#endif
