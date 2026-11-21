#pragma once
#include <cstdint>
using esp_err_t = std::int32_t;
inline constexpr esp_err_t ESP_OK = 0;
inline constexpr esp_err_t ESP_FAIL = -1;
inline constexpr esp_err_t ESP_ERR_INVALID_STATE = 0x103;
inline constexpr esp_err_t ESP_ERR_INVALID_SIZE = 0x104;
inline constexpr esp_err_t ESP_ERR_NOT_FOUND = 0x105;
inline constexpr esp_err_t ESP_ERR_INVALID_RESPONSE = 0x108;
