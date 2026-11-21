/** @file esp_ota_ops.h @brief Fault-injectable inactive-slot OTA SDK adapter. */
#pragma once
#include <cstddef>
#include <cstdint>
#include "esp_err.h"
using esp_ota_handle_t = std::uint32_t;
inline constexpr std::size_t OTA_WITH_SEQUENTIAL_WRITES = 0xfffffffe;

struct esp_partition_t {
    std::size_t size;
    char label[17];
};

const esp_partition_t* esp_ota_get_running_partition();
const esp_partition_t* esp_ota_get_next_update_partition(const esp_partition_t*);
esp_err_t esp_ota_begin(const esp_partition_t*, std::size_t, esp_ota_handle_t*);
esp_err_t esp_ota_write(esp_ota_handle_t, const void*, std::size_t);
esp_err_t esp_ota_abort(esp_ota_handle_t);
esp_err_t esp_ota_end(esp_ota_handle_t);
esp_err_t esp_ota_set_boot_partition(const esp_partition_t*);
