#include "time/rtc_clock.h"
#include "time/rtc_codec.h"
#include "test_platform.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdlib>
#include <ctime>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
int checks = 0;

void check(bool condition, const char* message)
{
    ++checks;
    if (!condition)
        throw std::runtime_error(message);
}

std::int64_t utc(int year, int month, int day, int hour = 0, int minute = 0, int second = 0)
{
    std::tm date{};
    date.tm_year = year - 1900;
    date.tm_mon = month - 1;
    date.tm_mday = day;
    date.tm_hour = hour;
    date.tm_min = minute;
    date.tm_sec = second;
    // Pure calendar conversion, never sets the host clock or timezone.
    return static_cast<std::int64_t>(timegm(&date));
}

using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

Json status()
{
    Json result(rtc_clock_status_json(), cJSON_Delete);
    check(result != nullptr, "status JSON allocation");
    char* serialized = cJSON_PrintUnformatted(result.get());
    check(serialized != nullptr, "status JSON serialization");
    cJSON_free(serialized);
    return result;
}

const cJSON* field(const Json& json, const char* name)
{
    const auto* value = cJSON_GetObjectItemCaseSensitive(json.get(), name);
    check(value != nullptr, "required status field exists");
    return value;
}

void unavailable(bool present)
{
    check(!rtc_clock_get_unix().has_value(), "invalid RTC cannot supply Unix time");
    const auto json = status();
    check(cJSON_IsFalse(field(json, "valid")), "invalid status flag");
    check(cJSON_IsNull(field(json, "unixTime")), "invalid time is null");
    check(cJSON_IsTrue(field(json, "present")) == present, "presence reflects bus access");
    const auto* error = field(json, "error");
    check(cJSON_IsString(error) && error->valuestring[0] != '\0', "invalid time has diagnostic");
}

void available(std::int64_t expected)
{
    check(rtc_clock_get_unix() == expected, "confirmed RTC time");
    const auto json = status();
    check(cJSON_IsTrue(field(json, "valid")), "valid status flag");
    check(cJSON_IsTrue(field(json, "present")), "present status flag");
    const auto* time = field(json, "unixTime");
    check(cJSON_IsNumber(time) && static_cast<std::int64_t>(time->valuedouble) == expected,
          "public time matches confirmed time");
    check(std::string(field(json, "model")->valuestring) == "DS3231MZ+", "actual board RTC model");
    check(std::string(field(json, "busId")->valuestring) == "io-expanders", "actual board RTC bus");
    check(field(json, "address")->valueint == 0x68, "actual board RTC address");
}

void codec()
{
    check(utc(2000, 1, 1) == 946684800, "independent epoch2000");
    check(utc(2100, 1, 1) == 4102444800, "independent epoch2100");
    std::uint8_t bytes[7]{};
    std::int64_t decoded = 0;
    check(!rtc_encode_calendar(946684799, bytes), "pre2000 rejected");
    check(!rtc_encode_calendar(4102444800, bytes), "2100 rejected");
    check(!rtc_encode_calendar(-1, bytes), "negative Unix rejected");

    // Exhaust every calendar day, and both ends of that day, across the complete
    // supported century. timegm is an independent host calendar implementation.
    for (auto day = utc(2000, 1, 1); day < utc(2100, 1, 1); day += 86400) {
        for (auto offset : {0, 86399}) {
            const auto timestamp = day + offset;
            check(rtc_encode_calendar(timestamp, bytes), "every supported date encodes");
            check((bytes[2] & 0xc0) == 0 && (bytes[5] & 0x80) == 0,
                  "encoder produces24h/currentcentury");
            check(rtc_decode_calendar(bytes, 0, decoded) && decoded == timestamp,
                  "century exhaustive roundtrip");
            const auto host_time = static_cast<std::time_t>(timestamp);
            std::tm reference{};
            gmtime_r(&host_time, &reference);
            check(bytes[3] == reference.tm_wday + 1,
                  "encoded weekday matches independent calendar");
        }
    }
    check(rtc_encode_calendar(utc(2026, 11, 14, 23, 59, 58), bytes), "reference calendar");
    check(bytes[0] == 0x58 && bytes[1] == 0x59 && bytes[2] == 0x23 && bytes[4] == 0x14
              && bytes[5] == 0x11 && bytes[6] == 0x26,
          "known BCD fields");
    std::uint8_t base[7]{};
    std::copy_n(bytes, 7, base);
    for (std::size_t index = 0; index < 7; ++index) {
        std::copy_n(base, 7, bytes);
        bytes[index] = 0x0a;
        decoded = 42;
        check(!rtc_decode_calendar(bytes, 0, decoded) && decoded == 42,
              "invalid BCD rejected without publishing output");
    }
    for (auto index : {0, 1, 2, 3, 4, 5}) {
        std::copy_n(base, 7, bytes);
        bytes[index] |= 0x80;
        check(!rtc_decode_calendar(bytes, 0, decoded), "reserved/century bits rejected");
    }
    for (auto pair : {std::pair<int, int>{0, 0x60},
                      {1, 0x60},
                      {2, 0x24},
                      {3, 0},
                      {3, 8},
                      {4, 0},
                      {5, 0},
                      {5, 0x13}}) {
        std::copy_n(base, 7, bytes);
        bytes[pair.first] = static_cast<std::uint8_t>(pair.second);
        check(!rtc_decode_calendar(bytes, 0, decoded), "outofrange calendar field rejected");
    }
    for (auto year : {2000, 2004, 2024, 2096}) {
        rtc_encode_calendar(utc(year, 2, 29), bytes);
        check(rtc_decode_calendar(bytes, 0, decoded) && decoded == utc(year, 2, 29),
              "leapday accepted");
        bytes[4] = 0x30;
        check(!rtc_decode_calendar(bytes, 0, decoded), "Feb30 rejected");
    }
    rtc_encode_calendar(utc(2025, 2, 28), bytes);
    bytes[4] = 0x29;
    check(!rtc_decode_calendar(bytes, 0, decoded), "nonleap Feb29 rejected");
    rtc_encode_calendar(utc(2026, 4, 30), bytes);
    bytes[4] = 0x31;
    check(!rtc_decode_calendar(bytes, 0, decoded), "April31 rejected");
    rtc_encode_calendar(utc(2026, 11, 14), base);
    for (auto pair :
         {std::pair<int, int>{0x52, 0}, {0x61, 13}, {0x72, 12}, {0x41, 1}, {0x71, 23}}) {
        std::copy_n(base, 7, bytes);
        bytes[2] = static_cast<std::uint8_t>(pair.first);
        check(rtc_decode_calendar(bytes, 0, decoded) && decoded == utc(2026, 11, 14, pair.second),
              "12hour AMPM conversion");
    }
    for (auto hour : {0x40, 0x60, 0x53, 0x73}) {
        std::copy_n(base, 7, bytes);
        bytes[2] = static_cast<std::uint8_t>(hour);
        check(!rtc_decode_calendar(bytes, 0, decoded), "12hour zero/13 rejected");
    }
    check(!rtc_decode_calendar(base, 0x80, decoded), "OSF always rejects time");
    check(rtc_decode_calendar(base, 0x7f, decoded),
          "unrelated status bits do not invalidate calendar");
}

void boot_osf()
{
    rtc_test::reset_model();
    rtc_test::calendar(utc(2026, 11, 14), 0x8f);
    rtc_test::set_register(0x0e, 0xff);
    rtc_clock_init();
    check(rtc_test::task_count() == 1, "polling task scheduled once");
    check(rtc_test::get_register(0x0e) == 0x1c, "EOSC/BBSQW/alarms disabled and INTCN enabled");
    check(rtc_test::get_register(0x0f) == 0x87, "EN32KHZ disabled but OSF preserved at init");
    unavailable(true);
    for (const auto& event : rtc_test::trace()) {
        if (event.write && event.reg == 0x0f)
            check((event.bytes[0] & 0x80) != 0, "init never clears OSF");
    }
    rtc_clock_init();
    check(rtc_test::task_count() == 1, "repeated init does not duplicate task");
    rtc_test::set_register(0x0f, 0);
    rtc_clock_poll();
    available(utc(2026, 11, 14));
}

void read_faults()
{
    const auto good = utc(2026, 11, 14, 10, 20, 30);
    rtc_test::reset_model();
    rtc_test::calendar(good);
    rtc_clock_init();
    available(good);
    rtc_test::now(5'999'999);
    available(good);
    rtc_test::now(6'000'000);
    unavailable(true);
    rtc_clock_poll();
    available(good);
    rtc_test::present(false);
    rtc_clock_poll();
    unavailable(false);
    rtc_test::present(true);
    rtc_clock_poll();
    available(good);
    rtc_test::fail(false, 0);
    rtc_clock_poll();
    unavailable(false);
    rtc_clock_poll();
    available(good);
    rtc_test::fail(false, 0x0f);
    rtc_clock_poll();
    unavailable(false);
    rtc_clock_poll();
    available(good);
    rtc_test::set_register(0, 0x6a);
    rtc_clock_poll();
    unavailable(true);
    rtc_test::calendar(good);
    rtc_test::set_register(4, 0x31);
    rtc_test::set_register(5, 0x04);
    rtc_clock_poll();
    unavailable(true);
    rtc_test::calendar(utc(2000, 1, 1));
    rtc_clock_poll();
    unavailable(true);
    rtc_test::calendar(good, 0x80);
    rtc_clock_poll();
    unavailable(true);
    rtc_test::calendar(good);
    rtc_test::set_register(5, 0x91);
    rtc_clock_poll();
    unavailable(true);
    rtc_test::calendar(good);
    rtc_clock_poll();
    available(good);
}

void verify_confirmation_order()
{
    bool calendar_written = false, calendar_confirmed = false, osf_cleared = false;
    for (const auto& event : rtc_test::trace()) {
        if (event.write && event.reg == 0 && event.bytes.size() == 7)
            calendar_written = true;
        if (!event.write && event.reg == 0 && event.bytes.size() == 7 && calendar_written)
            calendar_confirmed = true;
        if (event.write && event.reg == 0x0f && (event.bytes[0] & 0x80) == 0) {
            check(calendar_written && calendar_confirmed,
                  "OSF clear follows calendar write/readback");
            osf_cleared = true;
        }
    }
    check(osf_cleared, "successful write cleared OSF");
}

void write_confirm()
{
    const auto good = utc(2026, 11, 14, 10, 20, 30);
    rtc_test::reset_model();
    rtc_test::calendar(good, 0x80);
    rtc_clock_init();
    unavailable(true);
    rtc_test::clear_trace();
    check(rtc_clock_set_unix(good + 3600) == ESP_OK, "write succeeds after verification");
    available(good + 3600);
    verify_confirmation_order();
    check((rtc_test::get_register(0x0f) & 0x88) == 0, "write clears OSF and unused32kHz");
    rtc_test::readback_offset(1);
    check(rtc_clock_set_unix(good + 7200) == ESP_OK, "one second rollover accepted");
    available(good + 7201);
    rtc_test::readback_offset(0);
    rtc_test::clear_trace();
    check(rtc_clock_set_unix(utc(2023, 12, 31, 23, 59, 59)) == ESP_ERR_INVALID_ARG,
          "pre2024 setter rejected");
    check(rtc_clock_set_unix(utc(2100, 1, 1)) == ESP_ERR_INVALID_ARG, "2100 setter rejected");
    check(rtc_test::trace().empty(), "invalid setter performs no bus transactions");
    check(rtc_clock_set_unix(utc(2024, 1, 1)) == ESP_OK, "firmware lower boundary accepted");
    available(utc(2024, 1, 1));
    check(rtc_clock_set_unix(utc(2099, 12, 31, 23, 59, 59)) == ESP_OK,
          "firmware upper boundary accepted");
    available(utc(2099, 12, 31, 23, 59, 59));
}

void write_faults()
{
    const auto old = utc(2026, 11, 14, 10, 20, 30);
    for (int scenario = 0; scenario < 9; ++scenario) {
        rtc_test::reset_model();
        rtc_test::calendar(old, 0x80);
        rtc_clock_poll();
        rtc_test::clear_trace();
        switch (scenario) {
            case 0:
                rtc_test::fail(true, 0);
                break;
            case 1:
                rtc_test::fail(false, 0);
                break;
            case 2:
                rtc_test::corrupt_calendar_readback(true);
                break;
            case 3:
                rtc_test::ignore_write(0);
                break;
            case 4:
                rtc_test::fail(false, 0x0f);
                break;
            case 5:
                rtc_test::fail(true, 0x0f);
                break;
            case 6:
                rtc_test::fail(false, 0, 2);
                break;  // Final poll after OSF clear fails.
            case 7:
                rtc_test::ignore_write(0x0f);
                break;
            case 8:
                rtc_test::readback_offset(2);
                break;
        }
        check(rtc_clock_set_unix(old + 3600) != ESP_OK, "fault cannot report successful RTC write");
        check(!rtc_clock_get_unix().has_value(), "failed write cannot leave valid cached time");
        if (scenario != 6)
            check((rtc_test::get_register(0x0f) & 0x80) != 0,
                  "OSF retained without successful confirmation");
        const auto json = status();
        check(cJSON_IsNull(field(json, "unixTime")), "write failure public time null");
    }
    rtc_test::reset_model();
    rtc_test::calendar(old, 0x80);
    rtc_clock_poll();
    check(rtc_clock_set_unix(old + 3600) == ESP_OK, "driver recovers after transient write faults");
    available(old + 3600);
}

void concurrent()
{
    const auto good = utc(2026, 11, 14, 10, 20, 30);
    rtc_test::reset_model();
    rtc_test::calendar(good);
    rtc_clock_init();
    rtc_test::clear_trace();
    std::atomic<bool> failed{false};
    std::vector<std::thread> threads;
    for (int thread = 0; thread < 4; ++thread) {
        threads.emplace_back([&, thread] {
            for (int i = 0; i < 20; ++i) {
                if (thread % 2 == 0) {
                    if (rtc_clock_set_unix(good + thread * 100 + i) != ESP_OK)
                        failed = true;
                } else {
                    rtc_clock_poll();
                    if (!rtc_clock_get_unix().has_value())
                        failed = true;
                    auto json = Json(rtc_clock_status_json(), cJSON_Delete);
                    if (!json)
                        failed = true;
                }
            }
        });
    }
    for (auto& thread : threads)
        thread.join();
    check(!failed, "concurrent setters/pollers/readers succeed");
    check(rtc_test::max_parallel_transactions() == 1, "driver serializes complete transactions");
    check(rtc_clock_get_unix().has_value(), "concurrent activity leaves confirmed valid time");
}
}  // namespace

int main(int argc, char** argv)
{
    try {
        const std::string name = argc == 2 ? argv[1] : "";
        if (name == "codec")
            codec();
        else if (name == "boot_osf")
            boot_osf();
        else if (name == "read_faults")
            read_faults();
        else if (name == "write_confirm")
            write_confirm();
        else if (name == "write_faults")
            write_faults();
        else if (name == "concurrent")
            concurrent();
        else
            throw std::runtime_error("unknown test case");
        std::cout << "PASS RTC " << name << " (" << checks << " checks)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL RTC: " << error.what() << '\n';
        return 1;
    }
}
