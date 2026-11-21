/**
 * @file system_metrics.h
 * @brief ESP32 chip temperature and nonsecret runtime/reset/heap diagnostics.
 */
#pragma once
#include "cJSON.h"
/** @brief Install and enable the internal temperature sensor if available.
 * @note Thread-safe and idempotent after success. Failure is nonfatal and leaves metrics unknown.
 */
void system_metrics_init();

/** @brief Read chip temperature and target runtime/reset/heap diagnostics.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr if the root cannot be allocated.
 * @note Thread-safe. A failed/non-finite reading is JSON null and is never a control measurement.
 */
cJSON* system_metrics_json();
