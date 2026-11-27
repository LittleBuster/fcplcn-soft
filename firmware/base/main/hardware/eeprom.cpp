/**
 * @file eeprom.cpp
 * @brief Page-safe 24LC512 transfers, ACK polling and verified update writes.
 * @details Microchip DS20001754R sections 6-8: 128-byte physical pages, 16-bit
 * addresses, 5-ms maximum programming cycle and write-direction ACK polling.
 */
#include "eeprom.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <mutex>

#include "board_profile.h"
#include "hardware_io.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"

namespace {
constexpr std::size_t kCapacityBytes = 65536;
constexpr std::size_t kPageBytes = 128;
constexpr std::size_t kChunkBytes = 32;
constexpr std::uint32_t kPollPauseUs = 500;
constexpr std::uint32_t kProbeTimeoutMs = 20;
std::mutex memory_mutex;

/**
 * @brief Validate the fitted EEPROM and entire range before touching the bus.
 * @param offset First byte address.
 * @param data Borrowed buffer, checked for nonnullness only.
 * @param length Requested nonempty byte count.
 * @return ESP_OK, a mismatched-profile error or ESP_ERR_INVALID_ARG.
 */
esp_err_t validate(std::uint16_t offset, const void* data, std::size_t length)
{
    const auto& memory = board_profile_active().stateMemory;
    if (!memory || memory->kind != BoardMemoryKind::Eeprom24lc512
        || memory->capacityBytes != kCapacityBytes || memory->pageSizeBytes != kPageBytes
        || memory->writeCycleTimeoutMs < 5 || memory->writeCycleTimeoutMs > 100)
        return ESP_ERR_NOT_SUPPORTED;
    if (data == nullptr || length == 0 || length > kCapacityBytes - offset)
        return ESP_ERR_INVALID_ARG;
    return ESP_OK;
}

/**
 * @brief Wait for a write-direction ACK with a finite per-cycle deadline.
 * @param memory Immutable active EEPROM descriptor.
 * @return ESP_OK when ready, ESP_ERR_TIMEOUT on persistent NACK, or the first bus error.
 * @pre Hold memory_mutex, never the hardware I2C mutex.
 * @details Only NACK is retried. Short polling pauses avoid dependence on the
 * FreeRTOS tick period; each probe and pause releases the shared I2C service.
 * One failing bus transaction can take its separate 20-ms I2C timeout; a normal
 * ACK/NACK returns on the ISR immediately. Two default RTOS ticks avoid spurious
 * probe timeouts at a tick boundary. A bus error is never polled again.
 * The profile bounds the retry window, not scheduler/shared-bus lock latency or
 * cancellation of an already-running I2C transaction. ACK after the deadline fails.
 */
esp_err_t wait_ready(const BoardStateMemory& memory)
{
    const auto deadline = esp_timer_get_time() + memory.writeCycleTimeoutMs * 1000LL;
    for (;;) {
        if (esp_timer_get_time() >= deadline)
            return ESP_ERR_TIMEOUT;
        const auto result = hardware_i2c_probe(memory.i2cBusId, memory.address, kProbeTimeoutMs);
        if (result != ESP_OK && result != ESP_ERR_NOT_FOUND)
            return result;
        if (esp_timer_get_time() > deadline)
            return ESP_ERR_TIMEOUT;
        if (result == ESP_OK)
            return ESP_OK;
        // The device programs autonomously. No shared hardware lock is held here.
        esp_rom_delay_us(kPollPauseUs);
    }
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read a bounded range from the active board's 24LC512 EEPROM.
 * @param offset First byte address in the 65536-byte device.
 * @param[out] data Destination, possibly partially filled on a transport failure.
 * @param length Nonzero count whose complete range fits the device.
 * @return ESP_OK or a profile, argument, readiness or I2C error.
 * @endcond
 */
esp_err_t eeprom_read(std::uint16_t offset, std::uint8_t* data, std::size_t length)
{
    const auto error = validate(offset, data, length);
    if (error != ESP_OK)
        return error;
    std::lock_guard<std::mutex> lock(memory_mutex);
    const auto& memory = *board_profile_active().stateMemory;
    const auto ready = wait_ready(memory);
    if (ready != ESP_OK)
        return ready;
    for (std::size_t done = 0; done < length;) {
        const auto count = std::min(kChunkBytes, length - done);
        const auto result = hardware_i2c_memory_read(memory.i2cBusId,
                                                     memory.address,
                                                     static_cast<std::uint16_t>(offset + done),
                                                     data + done,
                                                     count);
        if (result != ESP_OK)
            return result;
        done += count;
    }
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Update and verify EEPROM bytes with page-safe transfers and ACK polling.
 * @param offset First byte address in the 65536-byte device.
 * @param data Borrowed source buffer, retained only during this call.
 * @param length Nonzero count whose complete range fits the device.
 * @return ESP_OK after verified programming, or the first error without a data-write retry.
 * @endcond
 */
esp_err_t eeprom_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length)
{
    const auto error = validate(offset, data, length);
    if (error != ESP_OK)
        return error;
    std::lock_guard<std::mutex> lock(memory_mutex);
    const auto& memory = *board_profile_active().stateMemory;
    auto result = wait_ready(memory);
    if (result != ESP_OK)
        return result;
    std::array<std::uint8_t, kChunkBytes> existing{};
    for (std::size_t done = 0; done < length;) {
        const auto address = static_cast<std::uint16_t>(offset + done);
        const auto count =
            std::min({kChunkBytes, length - done, kPageBytes - address % kPageBytes});
        result = hardware_i2c_memory_read(
            memory.i2cBusId, memory.address, address, existing.data(), count);
        if (result != ESP_OK)
            return result;
        if (std::memcmp(existing.data(), data + done, count) != 0) {
            result = hardware_i2c_memory_write(
                memory.i2cBusId, memory.address, address, data + done, count);
            if (result != ESP_OK)
                return result;
            result = wait_ready(memory);
            if (result != ESP_OK)
                return result;
            result = hardware_i2c_memory_read(
                memory.i2cBusId, memory.address, address, existing.data(), count);
            if (result != ESP_OK)
                return result;
            if (std::memcmp(existing.data(), data + done, count) != 0)
                return ESP_ERR_INVALID_RESPONSE;
        }
        done += count;
    }
    return ESP_OK;
}
