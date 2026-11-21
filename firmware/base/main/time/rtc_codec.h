/**
 * @file rtc_codec.h
 * @brief Portable UTC calendar codecs for DS3231M, covering 2000 through 2099.
 */
#pragma once
#include <cstdint>
/**
 * @brief Decode and validate a seven-register calendar without changing process timezone.
 * @param[in] registers Seconds through year in DS3231M wire order; 12/24-hour modes accepted.
 * @param[in] status RTC status byte; OSF rejects an otherwise plausible calendar.
 * @param[out] unix_time UTC epoch seconds on success; unchanged on failure.
 * @return True for valid BCD, reserved bits and calendar date. Pure and thread-safe.
 */
bool rtc_decode_calendar(const std::uint8_t (&registers)[7],
                         std::uint8_t status,
                         std::int64_t& unix_time);

/**
 * @brief Encode a UTC epoch time as a 24-hour RTC calendar.
 * @param[in] unix_time Epoch seconds in [2000-01-01, 2100-01-01).
 * @param[out] registers Seven calendar bytes; unchanged when the input is out of range.
 * @return True on success. Pure and thread-safe; no RTC access is performed.
 */
bool rtc_encode_calendar(std::int64_t unix_time, std::uint8_t (&registers)[7]);
