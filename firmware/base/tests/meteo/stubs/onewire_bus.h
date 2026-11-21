#pragma once
#include <cstddef>
#include <cstdint>
#include "esp_err.h"
struct FakeBus;
using onewire_bus_handle_t = FakeBus*;

struct onewire_bus_config_t {
    int bus_gpio_num;

    struct {
        bool en_pull_up;
    } flags;
};

struct onewire_bus_rmt_config_t {
    std::uint32_t max_rx_bytes;
};

esp_err_t onewire_new_bus_rmt(const onewire_bus_config_t*,
                              const onewire_bus_rmt_config_t*,
                              onewire_bus_handle_t*);
esp_err_t onewire_bus_del(onewire_bus_handle_t);
esp_err_t onewire_bus_reset(onewire_bus_handle_t);
esp_err_t onewire_bus_write_bytes(onewire_bus_handle_t, const std::uint8_t*, std::uint8_t);
esp_err_t onewire_bus_read_bytes(onewire_bus_handle_t, std::uint8_t*, std::size_t);
esp_err_t onewire_bus_read_bit(onewire_bus_handle_t, std::uint8_t*);
