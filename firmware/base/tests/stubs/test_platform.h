#pragma once

#include <string>
#include "esp_err.h"

namespace test_platform {
void reset();
void fail_next_commit(esp_err_t error = ESP_FAIL);
void fail_next_mac_read(esp_err_t error = ESP_FAIL);
std::string stored_config();
void replace_stored_config(const std::string& value);
unsigned commit_count();
}  // namespace test_platform
