#pragma once

void metrics_test_log_warning(const char* tag, const char* format, ...);
#define ESP_LOGW(...) metrics_test_log_warning(__VA_ARGS__)
