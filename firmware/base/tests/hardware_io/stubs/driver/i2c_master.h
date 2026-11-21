#pragma once
#include <cstddef>
#include <cstdint>
#include "driver/gpio.h"
struct FakeI2cBus;
struct FakeI2cDevice;
using i2c_master_bus_handle_t = FakeI2cBus*;
using i2c_master_dev_handle_t = FakeI2cDevice*;
using i2c_port_num_t = int;
constexpr int I2C_CLK_SRC_DEFAULT = 0;
constexpr int I2C_ADDR_BIT_LEN_7 = 0;

struct i2c_master_bus_config_t {
    int i2c_port;
    gpio_num_t sda_io_num;
    gpio_num_t scl_io_num;
    int clk_source;
    std::uint8_t glitch_ignore_cnt;
    int intr_priority;
    std::size_t trans_queue_depth;

    struct {
        unsigned enable_internal_pullup : 1;
        unsigned allow_pd : 1;
    } flags;
};

struct i2c_device_config_t {
    int dev_addr_length;
    std::uint16_t device_address;
    std::uint32_t scl_speed_hz;
    std::uint32_t scl_wait_us;

    struct {
        unsigned disable_ack_check : 1;
    } flags;
};

esp_err_t i2c_new_master_bus(const i2c_master_bus_config_t*, i2c_master_bus_handle_t*);
esp_err_t i2c_master_bus_reset(i2c_master_bus_handle_t);
esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t,
                                    const i2c_device_config_t*,
                                    i2c_master_dev_handle_t*);
esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t);
esp_err_t i2c_del_master_bus(i2c_master_bus_handle_t);
esp_err_t i2c_master_transmit(i2c_master_dev_handle_t, const std::uint8_t*, std::size_t, int);
esp_err_t i2c_master_transmit_receive(
    i2c_master_dev_handle_t, const std::uint8_t*, std::size_t, std::uint8_t*, std::size_t, int);
esp_err_t i2c_master_probe(i2c_master_bus_handle_t, std::uint16_t, int);
