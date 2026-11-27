/**
 * @file ethernet_w5500.h
 * @brief Board-local W5500 transport and Ethernet driver ownership.
 */
#pragma once

#include <array>
#include <cstdint>

#include "esp_eth_driver.h"

struct BoardW5500;

/** @brief Owns the W5500 resources for the lifetime of the network manager. */
class EthernetW5500 {
public:
    EthernetW5500() = default;
    EthernetW5500(const EthernetW5500&) = delete;
    EthernetW5500& operator=(const EthernetW5500&) = delete;

    esp_err_t initialize(const BoardW5500& board);
    void discard();
    esp_eth_handle_t handle() const;
    const std::array<std::uint8_t, ETH_ADDR_LEN>& mac_address() const;

private:
    esp_eth_handle_t driver_ = nullptr;
    esp_eth_mac_t* mac_ = nullptr;
    esp_eth_phy_t* phy_ = nullptr;
    bool spi_ready_ = false;
    std::array<std::uint8_t, ETH_ADDR_LEN> mac_address_{};
};
