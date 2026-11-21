/**
 * @file recovery_mode.h
 * @brief Isolated read-only service access after a critical early startup failure.
 */
#pragma once

#include "esp_err.h"

/** @brief Facts established before an early-boot failure; no physical output inference. */
struct RecoveryBootState {
    const char* boardId = nullptr;  ///< Static activated board identity, or nullptr when unknown.
    bool safeGpiosAttempted = false;  ///< Safe-level initialization was started for that board.
    bool safeGpiosConfigured = false;  ///< All safe GPIO SDK operations succeeded.
    bool expanderResetRequested =
        false;  ///< A fitted reset output was successfully configured LOW.
};

/**
 * @brief Preserve known safe-level requests and serve an isolated recovery AP and serve an isolated
 * recovery AP without loading saved secrets.
 * @param[in] stage Static startup-stage label that failed before hardware/control task creation.
 * @param[in] error Failure code shown without exposing saved settings.
 * @param[in] boot Established boot facts; boardId must have static lifetime when nonnull.
 * @note Never returns. Only diagnostics and an explicit token-protected reboot are offered;
 * no NVS erase, configuration export, control API or authentication bypass is provided.
 * @pre Invoke before starting profile-bound I/O/control workers. An unknown profile leaves GPIOs
 * untouched.
 */
[[noreturn]] void
recovery_mode_run(const char* stage, esp_err_t error, RecoveryBootState boot = {});
