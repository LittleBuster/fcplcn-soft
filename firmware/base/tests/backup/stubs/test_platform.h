#pragma once
#include <cstdint>
#include "hardware/hardware_io.h"
#include <string>
#include <vector>

namespace backup_test {
void reset();
void reboot_hardware();
void advance(std::int64_t us, bool sample = true);
void input(unsigned index, bool value, bool valid = true);
void relay_valid(unsigned index, bool valid);
void fail_commit();
void fail_write();
void corrupt_storage();
bool relay(unsigned index);
HardwareRelayRecovery recovery_policy(unsigned index);
unsigned recovery_policy_calls();
unsigned commits();
unsigned nvs_commits();
unsigned fram_commits();
void fail_fram_commit();
void set_fram_present(bool value);
void corrupt_fram();
void erase_fram();
std::vector<std::string> events();
void set_mac_suffix(unsigned suffix);
void raw_put(const std::string& space,
             const std::string& key,
             const std::vector<unsigned char>& bytes);
std::vector<unsigned char> raw_get(const std::string& space, const std::string& key);
bool raw_has(const std::string& space, const std::string& key);
void clear_pending();
}  // namespace backup_test
