/**
 * @file state_memory.h
 * @brief Board-selected nonvolatile state bytes independent of FRAM/EEPROM technology.
 */
#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"

/**
 * @brief Read state bytes using the active board's registered memory backend.
 * @param offset First byte address.
 * @param[out] data Destination of at least length bytes, possibly partly filled on failure.
 * @param length Nonzero count whose complete range fits the fitted device.
 * @return ESP_OK, backend/argument error, or ESP_ERR_NOT_SUPPORTED without supported memory.
 * @pre Activate the board and initialize its hardware I2C before accessing memory.
 */
esp_err_t state_memory_read(std::uint16_t offset, std::uint8_t* data, std::size_t length);

/**
 * @brief Write state bytes through the backend selected by the boot-active profile.
 * @param offset First byte address.
 * @param data Borrowed source buffer, retained during this call only.
 * @param length Nonzero count whose complete range fits the fitted device.
 * @return ESP_OK or the selected backend's first error; failures may leave partial writes.
 * @details EEPROM page boundaries, programming readiness and update-write policy
 * belong to its driver. Record verification and commit ordering belong to the journal.
 */
esp_err_t state_memory_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length);
