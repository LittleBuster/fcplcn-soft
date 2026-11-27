/**
 * @file meteo_codec.cpp
 * @brief Portable Dallas CRC, canonical ROM and DS18B20 scratchpad decoding.
 * @details All byte order and resolution handling are explicit. Invalid data does
 * not overwrite the caller's last temperature or parsed ROM. No runtime services,
 * GPIO, storage or synchronization are needed by these pure codecs.
 */
#include "meteo_codec.h"
#include "checksum.h"

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Calculate the Dallas/Maxim reflected CRC-8 used by DS18B20.
 * @param bytes Borrowed readable buffer; may be nullptr only when size is zero.
 * @param size Number of bytes to process.
 * @return CRC-8 with initial value zero and reflected polynomial 0x8c.
 * @endcond
 */
std::uint8_t meteo_crc8(const std::uint8_t* bytes, std::size_t size)
{
    return fcplcn::util::crc8_dallas(bytes, size);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Format an onewire_bus ROM value without changing byte order.
 * @param address ROM whose least-significant byte is the family byte.
 * @return Sixteen lowercase hex characters; formatting alone does not validate CRC/family.
 * @endcond
 */
std::string meteo_rom_address(std::uint64_t address)
{
    static constexpr char digits[] = "0123456789abcdef";
    std::string result(16, '0');
    for (unsigned i = 0; i < 8; ++i) {
        const auto byte = static_cast<std::uint8_t>(address >> (8 * i));
        result[2 * i] = digits[byte >> 4];
        result[2 * i + 1] = digits[byte & 0x0f];
    }
    return result;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Parse a hexadecimal OneWire ROM of the requested family and validate its CRC.
 * @param text Exactly sixteen hex characters in wire order, accepting uppercase.
 * @param family Expected family byte.
 * @param[out] bytes Wire-order ROM, assigned only on success.
 * @return True when the family and CRC both match.
 * @endcond
 */
bool onewire_parse_address(std::string_view text,
                           std::uint8_t family,
                           std::array<std::uint8_t, 8>& bytes)
{
    if (text.size() != 16)
        return false;
    const auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9')
            return c - '0';
        if (c >= 'a' && c <= 'f')
            return c - 'a' + 10;
        if (c >= 'A' && c <= 'F')
            return c - 'A' + 10;
        return -1;
    };
    std::array<std::uint8_t, 8> parsed{};
    for (std::size_t i = 0; i < parsed.size(); ++i) {
        const auto high = nibble(text[2 * i]), low = nibble(text[2 * i + 1]);
        if (high < 0 || low < 0)
            return false;
        parsed[i] = static_cast<std::uint8_t>((high << 4) | low);
    }
    if (parsed[0] != family || meteo_crc8(parsed.data(), 7) != parsed[7])
        return false;
    bytes = parsed;
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Parse and validate a DS18B20 ROM.
 * @param text Exactly sixteen hex characters; uppercase input is accepted.
 * @param[out] bytes Wire-order ROM, assigned only on success.
 * @return True only for family 0x28 with a correct ROM CRC.
 * @endcond
 */
bool meteo_parse_address(std::string_view text, std::array<std::uint8_t, 8>& bytes)
{
    return onewire_parse_address(text, 0x28, bytes);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decode a CRC-valid scratchpad and its configured temperature resolution.
 * @param data Nine wire-order scratchpad bytes including CRC.
 * @param[out] temperatureC Celsius temperature, assigned only on success.
 * @param[out] error Diagnostic on failure; cleared on success.
 * @return True for a supported configuration and a temperature in -55..125 C.
 * @details Undefined low bits in 9/10/11-bit conversions are masked before the
 * signed fixed-point value is converted. This function does not start a conversion.
 * @endcond
 */
bool meteo_decode_ds18b20(const std::array<std::uint8_t, 9>& data,
                          double& temperatureC,
                          std::string& error)
{
    if (meteo_crc8(data.data(), 8) != data[8]) {
        error = "Ошибка CRC DS18B20";
        return false;
    }
    if ((data[4] & 0x9f) != 0x1f) {
        error = "Некорректные данные DS18B20";
        return false;
    }
    std::uint16_t raw =
        static_cast<std::uint16_t>(data[0]) | static_cast<std::uint16_t>(data[1]) << 8;
    const unsigned unused = 3 - ((data[4] >> 5) & 3);
    raw &= static_cast<std::uint16_t>(0xffffu << unused);
    const double value = static_cast<std::int16_t>(raw) / 16.0;
    if (value < -55 || value > 125) {
        error = "Температура вне диапазона DS18B20";
        return false;
    }
    temperatureC = value;
    error.clear();
    return true;
}
