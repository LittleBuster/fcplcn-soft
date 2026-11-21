#pragma once
#include <cstddef>
#include <cstdint>
#include "esp_err.h"
esp_err_t state_memory_read(std::uint16_t offset, std::uint8_t* data, std::size_t length);
esp_err_t state_memory_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length);
