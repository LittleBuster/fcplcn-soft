/**
 * @file recovery_mode.h
 * @brief Isolated read-only service access after a critical early startup failure.
 */
#pragma once

#include "esp_err.h"

/**
 * @brief Hold safe GPIO levels and serve an isolated recovery AP without loading saved secrets.
 * @param[in] stage Static startup-stage label that failed before hardware/control task creation.
 * @param[in] error Failure code shown without exposing saved settings.
 * @note Never returns. Only diagnostics and an explicit token-protected reboot are offered;
 * no NVS erase, configuration export, control API or authentication bypass is provided.
 * @pre Invoke before starting profile-bound I/O/control workers; safe GPIOs were attempted first.
 */
[[noreturn]] void recovery_mode_run(const char* stage, esp_err_t error);
