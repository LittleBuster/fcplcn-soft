/**
 * @file rtc_codec.cpp
 * @brief Portable DS3231M UTC calendar validation and encoding.
 * @details Calendar conversion is independent of libc timezone state. Decode validates BCD,
 * reserved bits, leap years and the real month length before assigning the epoch value.
 */
#include "rtc_codec.h"
#include "ds3231.h"

namespace {
constexpr std::int64_t kEpoch2000 = 946684800;

/**
 * @brief Apply the Gregorian leap-year rule without timezone or libc state.
 * @param[in] year Full calendar year.
 * @return True for a year with a February 29.
 */
bool leap(int year)
{
    return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
}

/**
 * @brief Obtain a calendar month length including the leap-year February case.
 * @param[in] year Full Gregorian year.
 * @param[in] month Valid one-based month in the range 1..12.
 * @return Number of days in the selected month.
 */
int days_in_month(int year, int month)
{
    constexpr int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    return days[month - 1] + (month == 2 && leap(year) ? 1 : 0);
}

/**
 * @brief Decode packed BCD only when both decimal digits are valid.
 * @param[in] value Masked register value containing two BCD nibbles.
 * @param[in] minimum Lowest accepted decoded value.
 * @param[in] maximum Highest accepted decoded value.
 * @param[out] out Decoded number when both nibbles are valid, including out-of-range results.
 * @return True when decimal nibbles and the inclusive numeric bounds are valid.
 */
bool bcd(std::uint8_t value, int minimum, int maximum, int& out)
{
    if ((value & 15) > 9 || (value >> 4) > 9)
        return false;
    out = (value >> 4) * 10 + (value & 15);
    return out >= minimum && out <= maximum;
}

/**
 * @brief Convert a valid two-digit decimal calendar field to packed BCD.
 * @param[in] value Validated nonnegative decimal field no larger than 99.
 * @return Tens in the high nibble and units in the low nibble.
 */
std::uint8_t encode(int value)
{
    return static_cast<std::uint8_t>((value / 10) * 16 + value % 10);
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decode and validate a seven-register calendar without changing process timezone.
 * @param[in] r Seconds through year in DS3231M wire order; 12/24-hour modes accepted.
 * @param[in] status RTC status byte; OSF rejects an otherwise plausible calendar.
 * @param[out] unix_time UTC epoch seconds on success; unchanged on failure.
 * @return True for valid BCD, reserved bits and calendar date. Pure and thread-safe.
 * @endcond
 */
bool rtc_decode_calendar(const std::uint8_t (&r)[7], std::uint8_t status, std::int64_t& unix_time)
{
    if ((status & 0x80) || (r[0] & 0x80) || (r[1] & 0x80) || (r[2] & 0x80) || (r[3] & 0xf8)
        || (r[4] & 0xc0) || (r[5] & 0xe0))
        return false;
    int second, minute, hour, weekday, day, month, year;
    if (!bcd(r[0], 0, 59, second) || !bcd(r[1], 0, 59, minute) || !bcd(r[3], 1, 7, weekday)
        || !bcd(r[4], 1, 31, day) || !bcd(r[5], 1, 12, month) || !bcd(r[6], 0, 99, year))
        return false;
    if (r[2] & 0x40) {
        if (!bcd(r[2] & 0x1f, 1, 12, hour))
            return false;
        hour = hour % 12 + ((r[2] & 0x20) ? 12 : 0);
    } else if (!bcd(r[2] & 0x3f, 0, 23, hour))
        return false;
    year += 2000;
    if (day > days_in_month(year, month))
        return false;
    std::int64_t days = day - 1;
    for (int y = 2000; y < year; ++y)
        days += leap(y) ? 366 : 365;
    for (int m = 1; m < month; ++m)
        days += days_in_month(year, m);
    unix_time = kEpoch2000 + days * 86400 + hour * 3600 + minute * 60 + second;
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Encode a UTC epoch time as a 24-hour RTC calendar.
 * @param[in] unix_time Epoch seconds in [2000-01-01, 2100-01-01).
 * @param[out] r Seven calendar bytes; unchanged when the input is out of range.
 * @return True on success. Pure and thread-safe; no RTC access is performed.
 * @endcond
 */
bool rtc_encode_calendar(std::int64_t unix_time, std::uint8_t (&r)[7])
{
    if (unix_time < kEpoch2000 || unix_time >= kDs3231UnixEnd)
        return false;
    std::int64_t days = (unix_time - kEpoch2000) / 86400;
    const int weekday = static_cast<int>((unix_time / 86400 + 4) % 7) + 1;
    int year = 2000;
    while (days >= (leap(year) ? 366 : 365)) {
        days -= leap(year) ? 366 : 365;
        ++year;
    }
    int month = 1;
    while (days >= days_in_month(year, month)) {
        days -= days_in_month(year, month);
        ++month;
    }
    r[0] = encode(static_cast<int>(unix_time % 60));
    r[1] = encode(static_cast<int>(unix_time / 60 % 60));
    r[2] = encode(static_cast<int>(unix_time / 3600 % 24));
    r[3] = encode(weekday);
    r[4] = encode(static_cast<int>(days) + 1);
    r[5] = encode(month);
    r[6] = encode(year - 2000);
    return true;
}
