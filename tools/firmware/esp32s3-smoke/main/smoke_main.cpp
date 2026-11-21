#include <cstdint>
#include <cstdlib>
#include <inttypes.h>

#include "driver/uart.h"
#include "esp_chip_info.h"
#include "esp_err.h"
#include "esp_eth_mac_w5500.h"
#include "esp_eth_phy_w5500.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mqtt_client.h"
#include "product_identity.h"

namespace {
constexpr char kTag[] = FCPLCN_PRODUCT_NAME;
constexpr std::uint32_t kExpectedFlash = 16U * 1024U * 1024U;
constexpr std::size_t kExpectedPsram = 8U * 1024U * 1024U;
constexpr std::size_t kSampleBytes = 64U * 1024U;

[[noreturn]] void fail(const char* reason)
{
    ESP_LOGE(kTag, "%s", reason);
    std::abort();
}
}  // namespace

extern "C" void app_main()
{
    ESP_LOGI(kTag, "%s | %s", FCPLCN_PRODUCT_NAME, FCPLCN_PRODUCT_FULL_NAME);
    esp_chip_info_t chip{};
    esp_chip_info(&chip);
    ESP_LOGI(
        kTag, "ESP-IDF %s; cores=%u", esp_get_idf_version(), static_cast<unsigned>(chip.cores));
    ESP_LOGI(kTag, "Build environment verification image; relay GPIOs are not configured");

    std::uint32_t flash_bytes = 0;
    ESP_ERROR_CHECK(esp_flash_get_size(nullptr, &flash_bytes));
    ESP_LOGI(kTag,
             "Flash=%" PRIu32 " bytes; PSRAM=%u bytes",
             flash_bytes,
             static_cast<unsigned>(esp_psram_get_size()));
    if (chip.model != CHIP_ESP32S3 || chip.cores != 2 || flash_bytes != kExpectedFlash) {
        fail("Expected ESP32-S3 with two cores and 16 MiB flash");
    }
    if (!esp_psram_is_initialized() || esp_psram_get_size() != kExpectedPsram) {
        fail("Expected 8 MiB initialized Octal PSRAM");
    }

    auto* sample = static_cast<std::uint8_t*>(
        heap_caps_malloc(kSampleBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (sample == nullptr) {
        fail("PSRAM allocation failed");
    }
    volatile std::uint8_t* memory = sample;
    for (std::size_t i = 0; i < kSampleBytes; ++i) {
        memory[i] = static_cast<std::uint8_t>((i * 37U) ^ 0xA5U);
    }
    for (std::size_t i = 0; i < kSampleBytes; ++i) {
        if (memory[i] != static_cast<std::uint8_t>((i * 37U) ^ 0xA5U)) {
            heap_caps_free(sample);
            fail("PSRAM sample verification failed");
        }
    }
    heap_caps_free(sample);
    ESP_LOGI(kTag, "N16R8 memory checks passed; W5500, MQTT, UART and HTTP headers compiled");

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}
