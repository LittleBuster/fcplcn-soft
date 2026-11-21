#pragma once

#include <cstddef>
#include <cstdint>
#include "esp_err.h"

using nvs_handle_t = std::uint32_t;

enum nvs_open_mode_t { NVS_READONLY = 0, NVS_READWRITE = 1 };

esp_err_t nvs_open(const char* namespace_name, nvs_open_mode_t mode, nvs_handle_t* out_handle);
esp_err_t nvs_get_str(nvs_handle_t handle, const char* key, char* out_value, std::size_t* length);
esp_err_t nvs_set_str(nvs_handle_t handle, const char* key, const char* value);
esp_err_t nvs_get_blob(nvs_handle_t handle, const char* key, void* value, std::size_t* length);
esp_err_t nvs_set_blob(nvs_handle_t handle, const char* key, const void* value, std::size_t length);
esp_err_t nvs_commit(nvs_handle_t handle);
void nvs_close(nvs_handle_t handle);
