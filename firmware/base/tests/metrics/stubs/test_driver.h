#pragma once

#include <atomic>
#include "driver/temperature_sensor.h"

namespace test_driver {
extern esp_err_t install_result;
extern esp_err_t enable_result;
extern esp_err_t read_result;
extern float reading;
extern unsigned read_delay_ms;
extern temperature_sensor_config_t installed_config;
extern std::atomic<unsigned> installs;
extern std::atomic<unsigned> enables;
extern std::atomic<unsigned> uninstalls;
extern std::atomic<unsigned> reads;
extern std::atomic<unsigned> warnings;
extern std::atomic<unsigned> max_parallel_reads;
}  // namespace test_driver
