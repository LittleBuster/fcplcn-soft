/**
 * @file eeprom.h
 * @brief Profile-bound Microchip 24LC512 byte memory with bounded programming cycles.
 */
#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"

/**
 * @brief Read a range from the active board's 64-KiB 24LC512 EEPROM.
 * @param offset First byte address, 0..65535.
 * @param[out] data Destination of at least length bytes; may be partially filled on failure.
 * @param length Nonzero count whose entire range fits the device.
 * @return ESP_OK or a profile, argument, readiness or I2C error.
 * @pre Activate the board and initialize its hardware I2C buses first.
 * @note Serializes EEPROM readers/writers; the shared I2C lock is released between transfers.
 */
esp_err_t eeprom_read(std::uint16_t offset, std::uint8_t* data, std::size_t length);

/**
 * @brief Program and verify a bounded 24LC512 range without crossing physical pages.
 * @param offset First byte address, 0..65535.
 * @param data Borrowed source of at least length bytes, retained during the call only.
 * @param length Nonzero count whose entire range fits the device.
 * @return ESP_OK after ready/readback verification, or a profile/argument/I2C/timeout error.
 * @details Skips unchanged chunks. Changed chunks are at most 32 bytes and stay
 * inside 128-byte pages; each successful data write is followed by bounded ACK
 * polling and readback. A failed data write is never retried. Failure may leave
 * a partially programmed range; the journal owns record-level crash consistency.
 * @note Serializes EEPROM access, never holds the shared I2C lock while waiting.
 * A bus-failed probe may consume the transport's separate 20-ms timeout; ready
 * ACK/NACK probes finish immediately. The profile bounds the retry window;
 * shared-lock/scheduler latency and an active I2C transaction can extend wall time.
 * An ACK received after that deadline is never accepted as a successful operation.
 */
esp_err_t eeprom_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length);
