#pragma once
#include <cstdint>
using BaseType_t = int;
using UBaseType_t = unsigned;
using TickType_t = std::uint32_t;
constexpr BaseType_t pdPASS = 1;
#define pdMS_TO_TICKS(value) (static_cast<TickType_t>(value))
