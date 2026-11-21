/**
 * @file fram.h
 * @brief Profile-bound FM24CL64B-GTR nonvolatile byte memory.
 * @details Records and crash consistency belong to the state journal. These calls
 * transfer bytes with a 16-bit big-endian address and reject device-address wrap.
 */
#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"

/**
 * @brief Read a bounded byte range from the active board's F-RAM.
 * @param offset First byte address in the 8192-byte device.
 * @param[out] data Destination of at least length bytes; may be partially filled on failure.
 * @param length Nonzero transfer count; the complete range must fit in the device.
 * @return ESP_OK, argument/profile error, or the first I2C error.
 * @pre Initialize hardware I2C after activating the board profile.
 * @details Transfers are split into at most 32 bytes with the hardware lock released
 * between chunks so relay polling can proceed. No retry or data modification occurs.
 */
esp_err_t fram_read(std::uint16_t offset, std::uint8_t* data, std::size_t length);

/**
 * @brief Write a bounded byte range to the active board's F-RAM.
 * @param offset First byte address in the 8192-byte device.
 * @param data Source of at least length bytes, retained only during this call.
 * @param length Nonzero transfer count; the complete range must fit in the device.
 * @return ESP_OK, argument/profile error, or the first I2C error; failure may leave a partial
 * write.
 * @pre Initialize hardware I2C after activating the board profile.
 * @details Each transaction contains at most 32 payload bytes. F-RAM requires no
 * programming delay or ACK polling. The caller verifies record contents and commits.
 */
esp_err_t fram_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length);
