/** @file platform.h @brief Isolated host flash fault controls and observations. */
#pragma once
#include <cstdint>
#include <vector>

namespace ota_test {
extern std::int64_t now_us, begin_advance_us, end_advance_us;
extern bool no_partition, restore_pending, fail_begin, fail_write, fail_end, fail_select;
extern unsigned begins, writes, aborts, ends, selections;
extern std::vector<unsigned char> flash;
void reset();
}  // namespace ota_test
