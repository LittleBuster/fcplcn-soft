#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include "esp_err.h"

namespace io_test {
struct Transfer {
    std::string operation;
    int bus;
    std::uint8_t address;
    std::uint16_t reg;
    std::vector<std::uint8_t> data;
    int timeout;
};

void set_present(int bus, std::uint8_t address, bool present);
void input_levels(int bus, std::uint8_t address, std::uint16_t levels);
void fail_next_read(int bus, std::uint8_t address);
void fail_read_after(int bus, std::uint8_t address, int successfulReads);
void fail_next_write(int bus, std::uint8_t address);
void fail_next_gpio_write(int gpio);
void fail_write_after(int bus, std::uint8_t address, int successfulWrites);
// Wire-independent EMI injection; registers use the BANK=0 canonical map.
void reset_mcp(int bus, std::uint8_t address);
void corrupt_register(int bus, std::uint8_t address, std::uint8_t reg, std::uint8_t value);
void corrupt_pair(int bus, std::uint8_t address, std::uint8_t reg, std::uint16_t value);
void force_gpio(int bus, std::uint8_t address, std::uint16_t mask, std::uint16_t levels);
void corrupt_next_read(int bus, std::uint8_t address, std::size_t byteOffset, std::uint8_t xorMask);
void nack_after_next_write(int bus, std::uint8_t address);
void ignore_next_write(int bus, std::uint8_t address);
void ignore_next_write_to(int bus, std::uint8_t address, std::uint8_t reg);
void nack_after_next_write_to(int bus, std::uint8_t address, std::uint8_t reg);
void fail_readback_after_next_latch_write(int bus, std::uint8_t address);
void ignore_next_nonzero_latch_write(int bus, std::uint8_t address);
// Physical register values, independent of IOCON.BANK/SEQOP wire mapping.
std::uint16_t register_pair(int bus, std::uint8_t address, std::uint8_t reg);
std::vector<Transfer> transfers();
void advance(std::uint32_t ms);
void elapse_next_read_ms(std::uint32_t ms);
unsigned worker_creations();
unsigned bus_creations();
void transfer_delay(unsigned milliseconds);
unsigned max_parallel(int bus);
}  // namespace io_test
