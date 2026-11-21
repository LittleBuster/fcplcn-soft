#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace auth_test {
extern std::int64_t now_us;
extern std::map<std::string, std::vector<unsigned char>> storage;
extern bool fail_next_commit;
}  // namespace auth_test
