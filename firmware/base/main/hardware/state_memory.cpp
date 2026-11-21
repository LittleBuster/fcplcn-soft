/**
 * @file state_memory.cpp
 * @brief Immutable-profile dispatch to the fitted FRAM or EEPROM state-memory driver.
 */
#include "hardware/state_memory.h"

#include "hardware/board_profile.h"
#include "hardware/eeprom.h"
#include "hardware/fram.h"

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read through the memory technology fitted to the boot-active board.
 * @param offset First byte address.
 * @param[out] data Destination, possibly partly filled on failure.
 * @param length Nonempty requested byte count.
 * @return ESP_OK, a backend error or ESP_ERR_NOT_SUPPORTED for an absent/unknown backend.
 * @endcond
 */
esp_err_t state_memory_read(std::uint16_t offset, std::uint8_t* data, std::size_t length)
{
    const auto& memory = board_profile_active().stateMemory;
    if (!memory)
        return ESP_ERR_NOT_SUPPORTED;
    switch (memory->kind) {
        case BoardMemoryKind::Fram:
            return fram_read(offset, data, length);
        case BoardMemoryKind::Eeprom24lc512:
            return eeprom_read(offset, data, length);
    }
    return ESP_ERR_NOT_SUPPORTED;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Write through the memory technology fitted to the boot-active board.
 * @param offset First byte address.
 * @param data Borrowed source bytes retained during this call only.
 * @param length Nonempty requested byte count.
 * @return ESP_OK, a backend error or ESP_ERR_NOT_SUPPORTED for an absent/unknown backend.
 * @endcond
 */
esp_err_t state_memory_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length)
{
    const auto& memory = board_profile_active().stateMemory;
    if (!memory)
        return ESP_ERR_NOT_SUPPORTED;
    switch (memory->kind) {
        case BoardMemoryKind::Fram:
            return fram_write(offset, data, length);
        case BoardMemoryKind::Eeprom24lc512:
            return eeprom_write(offset, data, length);
    }
    return ESP_ERR_NOT_SUPPORTED;
}
