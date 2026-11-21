/** @file esp_app_desc.h @brief Host ABI mirror of the SDK application descriptor. */
#pragma once
#include <cstdint>
inline constexpr std::uint32_t ESP_APP_DESC_MAGIC_WORD = 0xabcd5432;

struct esp_app_desc_t {
    std::uint32_t magic_word, secure_version, reserv1[2];
    char version[32], project_name[32], time[16], date[16], idf_ver[32];
    unsigned char app_elf_sha256[32];
    std::uint16_t min_efuse_blk_rev_full, max_efuse_blk_rev_full;
    unsigned char mmu_page_size, spi_flash_mode, reserv3[2];
    std::uint32_t reserv2[18];
};

static_assert(sizeof(esp_app_desc_t) == 256);
const esp_app_desc_t* esp_app_get_description();
