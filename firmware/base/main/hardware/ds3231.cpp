/**
 * @file ds3231.cpp
 * @brief DS3231M register access over the profile's shared I2C bus.
 */
#include "ds3231.h"
#include "board_profile.h"
#include "hardware_io.h"
#include "rtc_codec.h"

namespace {
constexpr std::uint8_t kCalendarRegister = 0x00;
constexpr std::uint8_t kControlRegister = 0x0e;
constexpr std::uint8_t kStatusRegister = 0x0f;
constexpr std::uint8_t kOscillatorStop = 0x80;
constexpr std::uint8_t kEnable32Khz = 0x08;

/**
 * @brief Read sequential RTC registers from the configured bus and address.
 * @param[in] rtc Active profile's RTC connection.
 * @param[in] reg First register.
 * @param[out] bytes Borrowed writable buffer of at least length bytes.
 * @param[in] length Byte count.
 * @return Shared I2C read result.
 */
esp_err_t
read_registers(const BoardRtc& rtc, std::uint8_t reg, std::uint8_t* bytes, std::size_t length)
{
    return hardware_i2c_read(rtc.i2cBusId, rtc.address, reg, bytes, length);
}

/**
 * @brief Write sequential RTC registers on the configured bus and address.
 * @param[in] rtc Active profile's RTC connection.
 * @param[in] reg First register.
 * @param[in] bytes Borrowed readable buffer of at least length bytes.
 * @param[in] length Byte count.
 * @return Shared I2C write result.
 */
esp_err_t write_registers(const BoardRtc& rtc,
                          std::uint8_t reg,
                          const std::uint8_t* bytes,
                          std::size_t length)
{
    return hardware_i2c_write(rtc.i2cBusId, rtc.address, reg, bytes, length);
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Enable battery-backed timekeeping and disable unused outputs and alarms.
 * @param[in] rtc Active profile's RTC connection.
 * @param[out] present Whether the initial control and status registers could be read.
 * @return ESP_OK after configuration, or the first I2C error.
 * @note OSF is retained. The caller serializes operations on the RTC.
 * @endcond
 */
esp_err_t ds3231_configure(const BoardRtc& rtc, bool& present)
{
    std::uint8_t flags[2]{};
    esp_err_t result = read_registers(rtc, kControlRegister, flags, sizeof(flags));
    present = result == ESP_OK;
    if (!present)
        return result;

    // Run on battery and disable square-wave and alarm outputs. Preserve NA bits.
    const std::uint8_t control = (flags[0] & 0x18) | 0x04;
    if (flags[0] != control)
        result = write_registers(rtc, kControlRegister, &control, 1);
    if (result == ESP_OK && (flags[1] & kEnable32Khz)) {
        const std::uint8_t status = flags[1] & ~kEnable32Khz;
        result = write_registers(rtc, kStatusRegister, &status, 1);
    }
    return result;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read calendar registers and check oscillator status.
 * @param[in] rtc Active profile's RTC connection.
 * @param[out] time Calendar and status on a successful transfer, unchanged on I2C error.
 * @return ESP_OK on a successful transfer, even if the calendar is invalid, or an I2C error.
 * @note The caller serializes operations on the RTC.
 * @endcond
 */
esp_err_t ds3231_read_time(const BoardRtc& rtc, Ds3231Time& time)
{
    std::uint8_t calendar[7]{}, status = 0;
    auto result = read_registers(rtc, kCalendarRegister, calendar, sizeof(calendar));
    if (result == ESP_OK)
        result = read_registers(rtc, kStatusRegister, &status, 1);
    if (result != ESP_OK)
        return result;

    std::int64_t unix_time = 0;
    time.oscillatorStopped = (status & kOscillatorStop) != 0;
    time.unixTime = rtc_decode_calendar(calendar, status, unix_time)
                        ? std::optional<std::int64_t>(unix_time)
                        : std::nullopt;
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Write the calendar and clear OSF after calendar readback matches.
 * @param[in] rtc Active profile's RTC connection.
 * @param[in] unix_time Authorized UTC epoch seconds in the chip's calendar range.
 * @return Result and operation for diagnosing a failed write.
 * @note The caller serializes operations on the RTC.
 * @endcond
 */
Ds3231WriteResult ds3231_write_time(const BoardRtc& rtc, std::int64_t unix_time)
{
    std::uint8_t calendar[7]{};
    if (!rtc_encode_calendar(unix_time, calendar))
        return {ESP_ERR_INVALID_ARG, Ds3231WriteStage::WriteCalendar};
    auto result = write_registers(rtc, kCalendarRegister, calendar, sizeof(calendar));
    if (result != ESP_OK)
        return {result, Ds3231WriteStage::WriteCalendar};

    std::uint8_t readback[7]{};
    result = read_registers(rtc, kCalendarRegister, readback, sizeof(readback));
    if (result != ESP_OK)
        return {result, Ds3231WriteStage::ReadCalendar};
    std::int64_t confirmed = 0;
    if (!rtc_decode_calendar(readback, 0, confirmed) || confirmed < unix_time
        || confirmed > unix_time + 1)
        return {ESP_FAIL, Ds3231WriteStage::VerifyCalendar};

    std::uint8_t status = 0;
    result = read_registers(rtc, kStatusRegister, &status, 1);
    if (result == ESP_OK) {
        status &= ~(kOscillatorStop | kEnable32Khz);
        result = write_registers(rtc, kStatusRegister, &status, 1);
    }
    return {result, Ds3231WriteStage::ClearOscillatorStop};
}
