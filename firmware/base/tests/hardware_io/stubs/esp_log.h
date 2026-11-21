#pragma once

template <typename... Args> inline void fcplcn_test_log(Args&&...)
{
}

#define ESP_LOGI(...) fcplcn_test_log(__VA_ARGS__)
#define ESP_LOGW(...) fcplcn_test_log(__VA_ARGS__)
#define ESP_LOGE(...) fcplcn_test_log(__VA_ARGS__)
#define ESP_LOGD(...) fcplcn_test_log(__VA_ARGS__)
