/**
 * @file ethernet_w5500.cpp
 * @brief Reset, SPI and MAC/PHY initialization for the board-profile W5500.
 */
#include "ethernet_w5500.h"
#include "board_profile.h"

#include <algorithm>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_eth_mac_w5500.h"
#include "esp_eth_phy_w5500.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {
/**
 * @brief Suspend the current task for at least one scheduler tick.
 * @param[in] ms Requested delay in milliseconds, rounded by pdMS_TO_TICKS.
 */
void pause_ms(std::uint32_t ms)
{
    vTaskDelay(std::max<TickType_t>(1, pdMS_TO_TICKS(ms)));
}

/**
 * @brief Preload inactive chip select and execute the board's W5500 reset pulse.
 * @param[in] board Active profile SPI and reset settings.
 * @return ESP_OK after the reset recovery interval or the first GPIO error.
 */
esp_err_t reset_chip(const BoardW5500& board)
{
    const auto cs = static_cast<gpio_num_t>(board.csGpio);
    const auto reset = static_cast<gpio_num_t>(board.resetGpio);
    auto error = gpio_set_level(cs, 1);
    if (error != ESP_OK)
        return error;
    error = gpio_set_direction(cs, GPIO_MODE_OUTPUT);
    if (error != ESP_OK)
        return error;
    error = gpio_set_level(reset, 0);
    if (error != ESP_OK)
        return error;
    error = gpio_set_direction(reset, GPIO_MODE_OUTPUT);
    if (error != ESP_OK)
        return error;
    pause_ms(board.resetAssertMs);
    error = gpio_set_level(reset, 1);
    if (error == ESP_OK)
        pause_ms(board.resetRecoverMs);
    return error;
}
}  // namespace

/**
 * @brief Prepare a stopped Ethernet driver and program its hardware MAC address.
 * @param[in] board W5500 wiring and policy from the activated board profile.
 * @return ESP_OK for an existing or newly installed driver; otherwise the first failure.
 * @pre Called only by the network manager, with one immutable board profile per boot.
 * @details The SPI bus remains initialized across retries. A successful driver is ready for
 * netif attachment and start by the caller.
 */
esp_err_t EthernetW5500::initialize(const BoardW5500& board)
{
    if (driver_ != nullptr)
        return ESP_OK;
    if (!board.present)
        return ESP_ERR_NOT_SUPPORTED;
    auto error = reset_chip(board);
    if (error != ESP_OK)
        return error;

    const auto spi_host = board.spiBus == BoardSpiBus::Spi2 ? SPI2_HOST : SPI3_HOST;
    if (!spi_ready_) {
        spi_bus_config_t bus{};
        bus.mosi_io_num = board.mosiGpio;
        bus.miso_io_num = board.misoGpio;
        bus.sclk_io_num = board.clockGpio;
        bus.quadwp_io_num = -1;
        bus.quadhd_io_num = -1;
        bus.max_transfer_sz = 1600;
        error = spi_bus_initialize(spi_host, &bus, SPI_DMA_CH_AUTO);
        if (error != ESP_OK)
            return error;
        spi_ready_ = true;
    }
    error = gpio_install_isr_service(0);
    if (error != ESP_OK && error != ESP_ERR_INVALID_STATE)
        return error;

    spi_device_interface_config_t spi{};
    spi.mode = board.spiMode;
    spi.clock_speed_hz = static_cast<int>(board.spiClockHz);
    spi.spics_io_num = board.csGpio;
    spi.queue_size = 16;
    eth_w5500_config_t w5500 = ETH_W5500_DEFAULT_CONFIG(spi_host, &spi);
    w5500.base.int_gpio_num = board.interruptGpio;
    eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
    mac_config.rx_task_stack_size = 4096;
    eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
    phy_config.reset_gpio_num = -1;  // The board reset and recovery delays ran above.
    mac_ = esp_eth_mac_new_w5500(&w5500, &mac_config);
    phy_ = esp_eth_phy_new_w5500(&phy_config);
    if (mac_ == nullptr || phy_ == nullptr) {
        discard();
        return ESP_ERR_NO_MEM;
    }

    esp_eth_config_t driver_config = ETH_DEFAULT_CONFIG(mac_, phy_);
    error = esp_eth_driver_install(&driver_config, &driver_);
    if (error == ESP_OK)
        error = esp_read_mac(mac_address_.data(), ESP_MAC_ETH);
    if (error == ESP_OK)
        error = esp_eth_ioctl(driver_, ETH_CMD_S_MAC_ADDR, mac_address_.data());
    if (error != ESP_OK)
        discard();
    return error;
}

/**
 * @brief Uninstall an unused driver and release the MAC and PHY allocations.
 * @pre The driver is stopped and all borrowed netif glue references have been released.
 * @note Keep the SPI host initialized for the next attempt with this board profile.
 */
void EthernetW5500::discard()
{
    if (driver_ != nullptr) {
        esp_eth_driver_uninstall(driver_);
        driver_ = nullptr;
    }
    if (phy_ != nullptr) {
        phy_->del(phy_);
        phy_ = nullptr;
    }
    if (mac_ != nullptr) {
        mac_->del(mac_);
        mac_ = nullptr;
    }
    mac_address_ = {};
}

/**
 * @brief Borrow the installed Ethernet driver for network attachment or lifecycle calls.
 * @return The SDK handle, or nullptr before successful initialization.
 */
esp_eth_handle_t EthernetW5500::handle() const
{
    return driver_;
}

/**
 * @brief Read the hardware MAC bytes for network diagnostics.
 * @return Borrowed address bytes, valid until discard.
 * @pre Driver initialization succeeded.
 */
const std::array<std::uint8_t, ETH_ADDR_LEN>& EthernetW5500::mac_address() const
{
    return mac_address_;
}
