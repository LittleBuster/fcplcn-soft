#pragma once
#include <cstdint>
#include "esp_err.h"
using gpio_num_t = int;
constexpr int GPIO_NUM_NC = -1;

enum gpio_mode_t {
    GPIO_MODE_DISABLE = 0,
    GPIO_MODE_INPUT = 1,
    GPIO_MODE_OUTPUT = 2,
    GPIO_MODE_OUTPUT_OD = 6,
    GPIO_MODE_INPUT_OUTPUT = 3,
    GPIO_MODE_INPUT_OUTPUT_OD = 7
};

enum gpio_pullup_t { GPIO_PULLUP_DISABLE = 0, GPIO_PULLUP_ENABLE = 1 };

enum gpio_pulldown_t { GPIO_PULLDOWN_DISABLE = 0, GPIO_PULLDOWN_ENABLE = 1 };

enum gpio_pull_mode_t { GPIO_PULLUP_ONLY = 0, GPIO_FLOATING = 3 };

enum gpio_int_type_t { GPIO_INTR_DISABLE = 0 };

struct gpio_config_t {
    std::uint64_t pin_bit_mask;
    gpio_mode_t mode;
    gpio_pullup_t pull_up_en;
    gpio_pulldown_t pull_down_en;
    gpio_int_type_t intr_type;
};

esp_err_t gpio_config(const gpio_config_t* config);
esp_err_t gpio_set_level(gpio_num_t gpio, std::uint32_t level);
int gpio_get_level(gpio_num_t gpio);
esp_err_t gpio_set_direction(gpio_num_t gpio, gpio_mode_t mode);
esp_err_t gpio_set_pull_mode(gpio_num_t gpio, gpio_pull_mode_t mode);
