/**
 * @file fram.cpp
 * @brief Bounded FM24CL64B-GTR transfers over the shared hardware I2C service.
 */
#include "fram.h"

#include <algorithm>

#include "board_profile.h"
#include "hardware_io.h"

namespace {
constexpr std::size_t kCapacityBytes = 8192;
constexpr std::size_t kChunkBytes = 32;

/**
 * @brief Validate the fitted component and entire range before any I2C transaction.
 * @param offset First device byte address.
 * @param data Borrowed buffer; only its nonnullness is checked.
 * @param length Requested nonempty byte count.
 * @return ESP_OK, ESP_ERR_NOT_SUPPORTED without the expected profile, or ESP_ERR_INVALID_ARG.
 */
esp_err_t validate(std::uint16_t offset, const void* data, std::size_t length)
{
    const auto& fram = board_profile_active().stateMemory;
    if (!fram || fram->kind != BoardMemoryKind::Fram || fram->capacityBytes != kCapacityBytes)
        return ESP_ERR_NOT_SUPPORTED;
    if (data == nullptr || length == 0 || offset >= kCapacityBytes
        || length > kCapacityBytes - offset)
        return ESP_ERR_INVALID_ARG;
    return ESP_OK;
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read a bounded byte range from the active board's F-RAM.
 * @param offset First byte address in the 8192-byte device.
 * @param[out] data Destination; may be partially filled on failure.
 * @param length Nonzero count; the whole range must fit in the device.
 * @return ESP_OK, argument/profile error, or the first I2C error.
 * @endcond
 */
esp_err_t fram_read(std::uint16_t offset, std::uint8_t* data, std::size_t length)
{
    const auto error = validate(offset, data, length);
    if (error != ESP_OK)
        return error;
    const auto& fram = *board_profile_active().stateMemory;
    for (std::size_t done = 0; done < length;) {
        const auto count = std::min(kChunkBytes, length - done);
        const auto transfer = hardware_i2c_memory_read(fram.i2cBusId,
                                                       fram.address,
                                                       static_cast<std::uint16_t>(offset + done),
                                                       data + done,
                                                       count);
        if (transfer != ESP_OK)
            return transfer;
        done += count;
    }
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Write a bounded byte range to the active board's F-RAM.
 * @param offset First byte address in the 8192-byte device.
 * @param data Borrowed source bytes.
 * @param length Nonzero count; the whole range must fit in the device.
 * @return ESP_OK, argument/profile error, or the first I2C error; failure may leave a partial
 * write.
 * @endcond
 */
esp_err_t fram_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length)
{
    const auto error = validate(offset, data, length);
    if (error != ESP_OK)
        return error;
    const auto& fram = *board_profile_active().stateMemory;
    for (std::size_t done = 0; done < length;) {
        const auto count = std::min(kChunkBytes, length - done);
        const auto transfer = hardware_i2c_memory_write(fram.i2cBusId,
                                                        fram.address,
                                                        static_cast<std::uint16_t>(offset + done),
                                                        data + done,
                                                        count);
        if (transfer != ESP_OK)
            return transfer;
        done += count;
    }
    return ESP_OK;
}
