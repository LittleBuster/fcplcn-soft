/** @file esp_app_format.h @brief Host ABI mirror of the ESP image prefix used before erase. */
#pragma once
#include <cstdint>
inline constexpr unsigned ESP_IMAGE_HEADER_MAGIC = 0xe9, ESP_IMAGE_MAX_SEGMENTS = 16;
inline constexpr unsigned ESP_CHIP_ID_ESP32S3 = 9;

struct __attribute__((packed)) esp_image_header_t {
    unsigned char magic, segment_count, spi_mode, spi_speed_size;
    std::uint32_t entry_addr;
    unsigned char wp_pin, spi_pin_drv[3];
    std::uint16_t chip_id;
    unsigned char min_chip_rev;
    std::uint16_t min_chip_rev_full, max_chip_rev_full;
    unsigned char reserved[4], hash_appended;
};

static_assert(sizeof(esp_image_header_t) == 24);

struct esp_image_segment_header_t {
    std::uint32_t load_addr, data_len;
};
