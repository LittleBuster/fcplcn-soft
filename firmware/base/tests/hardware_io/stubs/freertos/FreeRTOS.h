#pragma once
#include <cstdint>
using BaseType_t = int;
using UBaseType_t = unsigned;
using TickType_t = std::uint32_t;
constexpr BaseType_t pdPASS = 1;
constexpr BaseType_t pdTRUE = 1;
constexpr BaseType_t pdFALSE = 0;
constexpr TickType_t portMAX_DELAY = UINT32_MAX;
#ifndef FCPLCN_TEST_TICK_MS
#define FCPLCN_TEST_TICK_MS 1
#endif
constexpr TickType_t portTICK_PERIOD_MS = FCPLCN_TEST_TICK_MS;
#define pdMS_TO_TICKS(ms) (static_cast<TickType_t>(ms) / portTICK_PERIOD_MS)
