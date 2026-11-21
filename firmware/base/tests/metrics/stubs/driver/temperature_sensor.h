#pragma once

#include <cstdint>
#include "esp_err.h"

struct temperature_sensor_obj_t;
using temperature_sensor_handle_t = temperature_sensor_obj_t*;

enum temperature_sensor_clk_src_t { TEMPERATURE_SENSOR_CLK_SRC_DEFAULT = 0 };

struct temperature_sensor_config_t {
    int range_min;
    int range_max;
    temperature_sensor_clk_src_t clk_src;

    struct {
        std::uint32_t allow_pd;
    } flags;
};

#define TEMPERATURE_SENSOR_CONFIG_DEFAULT(minimum, maximum)                                        \
    {(minimum), (maximum), TEMPERATURE_SENSOR_CLK_SRC_DEFAULT, {0}}

esp_err_t temperature_sensor_install(const temperature_sensor_config_t* config,
                                     temperature_sensor_handle_t* output);
esp_err_t temperature_sensor_enable(temperature_sensor_handle_t sensor);
esp_err_t temperature_sensor_uninstall(temperature_sensor_handle_t sensor);
esp_err_t temperature_sensor_get_celsius(temperature_sensor_handle_t sensor, float* output);
