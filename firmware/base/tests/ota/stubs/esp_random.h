/** @file esp_random.h @brief Host-only random-token adapter. */
#pragma once
#include <cstddef>
void esp_fill_random(void*, std::size_t);
