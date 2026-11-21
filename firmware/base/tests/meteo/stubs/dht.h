#pragma once
#include <cstdint>
#include "driver/gpio.h"

enum dht_sensor_type_t { DHT_TYPE_AM2301 = 1 };

esp_err_t dht_read_data(dht_sensor_type_t type,
                        gpio_num_t pin,
                        std::int16_t* humidity,
                        std::int16_t* temperature);
