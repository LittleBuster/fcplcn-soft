#pragma once

inline void native_esp_log(const char*, const char*, ...)
{
}

#define ESP_LOGE(...) native_esp_log(__VA_ARGS__)
