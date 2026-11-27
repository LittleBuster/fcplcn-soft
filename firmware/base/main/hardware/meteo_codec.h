/**
 * @file meteo_codec.h
 * @brief Portable DS18B20 ROM, CRC and scratchpad codecs.
 * @details No GPIO, clocks, locks or storage are used. ROM strings contain the
 * eight bytes in wire order: family 28 first and CRC last, in lowercase hex.
 */
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

/**
 * @brief Calculate the Dallas/Maxim reflected CRC-8 used by DS18B20.
 * @param bytes Borrowed readable buffer; may be nullptr only when size is zero.
 * @param size Number of bytes to process.
 * @return CRC-8 with initial value zero and reflected polynomial 0x8c.
 */
std::uint8_t meteo_crc8(const std::uint8_t* bytes, std::size_t size);

/**
 * @brief Format an onewire_bus ROM value without changing byte order.
 * @param address ROM whose least-significant byte is the family byte.
 * @return Sixteen lowercase hex characters; formatting alone does not validate CRC/family.
 */
std::string meteo_rom_address(std::uint64_t address);

/**
 * @brief Parse a OneWire ROM of the expected family and validate its CRC.
 * @param text Exactly sixteen hexadecimal characters in wire order.
 * @param family Required first byte.
 * @param[out] bytes Wire-order ROM, assigned only on success.
 * @return True when the family and CRC both match.
 */
bool onewire_parse_address(std::string_view text,
                           std::uint8_t family,
                           std::array<std::uint8_t, 8>& bytes);

/**
 * @brief Parse and validate a DS18B20 ROM.
 * @param text Exactly sixteen hex characters; uppercase input is accepted.
 * @param[out] bytes Wire-order ROM, assigned only on success.
 * @return True only for family 0x28 with a correct ROM CRC.
 */
bool meteo_parse_address(std::string_view text, std::array<std::uint8_t, 8>& bytes);

/**
 * @brief Decode a CRC-valid scratchpad and its configured temperature resolution.
 * @param data Nine wire-order scratchpad bytes including CRC.
 * @param[out] temperatureC Celsius temperature, assigned only on success.
 * @param[out] error Diagnostic on failure; cleared on success.
 * @return True for a supported configuration and a temperature in -55..125 C.
 * @details Undefined low bits in 9/10/11-bit conversions are masked before the
 * signed fixed-point value is converted. This function does not start a conversion.
 */
bool meteo_decode_ds18b20(const std::array<std::uint8_t, 9>& data,
                          double& temperatureC,
                          std::string& error);
