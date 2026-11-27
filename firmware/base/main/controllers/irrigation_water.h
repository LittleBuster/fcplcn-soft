/**
 * @file irrigation_water.h
 * @brief Short-lived hub observations of tanks on other local PLCs.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

struct cJSON;

inline constexpr std::size_t kIrrigationWaterReplyMaxBytes = 768;

/** @brief Retire all pending requests and water permissions on a connection transition. */
void irrigation_water_connection(bool connected);

/** @brief Start a challenge using the current boot ID and request send time. */
cJSON* irrigation_water_request(std::string_view bootId, std::int64_t nowUs);

/** @brief Read the local bottom contacts to advertise to the hub. */
cJSON* irrigation_water_source(std::string_view bootId);

/** @brief Validate a complete reply and attach it to the pending challenge. */
bool irrigation_water_receive(std::string_view payload,
                              bool retained,
                              std::string_view ownId,
                              std::string_view bootId,
                              std::int64_t nowUs);
