#pragma once
#include <cstdint>
#include <thread>
#include <vector>

namespace rtc_test {
struct Event {
    bool write;
    std::uint8_t reg;
    std::vector<std::uint8_t> bytes;
    std::thread::id thread;
};

void reset_model();
void calendar(std::int64_t unix_time, std::uint8_t status = 0);
void set_register(std::uint8_t reg, std::uint8_t value);
std::uint8_t get_register(std::uint8_t reg);
void present(bool value);
void now(std::int64_t microseconds);
void fail(bool write, std::uint8_t reg, int matching_call = 1);
void ignore_write(std::uint8_t reg);
void corrupt_calendar_readback(bool value);
void readback_offset(int seconds);
void clear_trace();
std::vector<Event> trace();
int max_parallel_transactions();
int task_count();
}  // namespace rtc_test
