#pragma once
#include <cstdint>
#include "hardware/hardware_io.h"
#include <string>
#include <vector>

namespace socket_test {
void reset();
void reboot_hardware();
void advance(std::int64_t us, bool sample = true);
void input(unsigned index, bool value, bool valid = true);
void relay_valid(unsigned index, bool valid);
void fail_commit();
void fail_write();
void fail_write_after_apply();
void physical_relay(unsigned index, bool value);
void advance_on_relay_read(std::int64_t us);
void advance_on_relay_write(std::int64_t us);
void advance_on_commit(std::int64_t us);
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
}  // namespace socket_test
