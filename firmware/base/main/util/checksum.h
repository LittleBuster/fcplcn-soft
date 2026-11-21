/**
 * @file checksum.h
 * @brief Portable checksum algorithms shared by durable records and sensor ROMs.
 */
#pragma once
#include <cstddef>
#include <cstdint>

namespace fcplcn::util {
/**
 * @brief Compute the reflected IEEE CRC-32 used by durable FCPLCn records.
 * @param[in] data Borrowed input buffer valid for size bytes.
 * @param[in] size Number of input bytes.
 * @return Complemented CRC-32 using polynomial 0xEDB88320 and initial 0xFFFFFFFF.
 */
inline std::uint32_t crc32(const std::uint8_t* data, std::size_t size)
{
    std::uint32_t crc = 0xffffffff;
    for (std::size_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
    }
    return ~crc;
}

/**
 * @brief Compute the Dallas/Maxim CRC-8 used by OneWire ROMs and scratchpads.
 * @param[in] data Borrowed input buffer valid for size bytes.
 * @param[in] size Number of bytes, including a received CRC when checking a zero remainder.
 * @return Reflected CRC-8 using polynomial 0x8C and an initial value of zero.
 */
inline std::uint8_t crc8_dallas(const std::uint8_t* data, std::size_t size)
{
    std::uint8_t crc = 0;
    for (std::size_t i = 0; i < size; ++i) {
        auto byte = data[i];
        for (unsigned bit = 0; bit < 8; ++bit) {
            const bool mix = (crc ^ byte) & 1;
            crc >>= 1;
            if (mix)
                crc ^= 0x8c;
            byte >>= 1;
        }
    }
    return crc;
}
}  // namespace fcplcn::util
