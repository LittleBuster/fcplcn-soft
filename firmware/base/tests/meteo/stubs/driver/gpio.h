#pragma once
#include <cstdint>
#include "esp_err.h"
using gpio_num_t = int;

enum gpio_mode_t { GPIO_MODE_INPUT = 1, GPIO_MODE_INPUT_OUTPUT_OD = 7 };

enum gpio_pull_mode_t { GPIO_FLOATING = 0 };

esp_err_t gpio_set_level(gpio_num_t gpio, std::uint32_t level);
esp_err_t gpio_set_direction(gpio_num_t gpio, gpio_mode_t mode);
esp_err_t gpio_set_pull_mode(gpio_num_t gpio, gpio_pull_mode_t mode);
int gpio_get_level(gpio_num_t gpio);
