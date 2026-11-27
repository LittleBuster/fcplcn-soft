/**
 * @file board_gpio.h
 * @brief Safe startup outputs and the physical recovery button.
 */
#pragma once

#include "esp_err.h"

struct BoardProfile;
struct BoardRecoveryButton;

/** @brief Separate setup results for recovery diagnostics. */
struct BoardRecoveryButtonSetup {
    esp_err_t direction;  ///< Input direction setup result.
    esp_err_t pull;  ///< Pull mode setup result.
};

/**
 * @brief Apply safe startup levels for the activated board.
 * @param[in] board Validated immutable profile.
 * @param[out] expanderResetRequested True after a fitted reset pin is successfully asserted.
 * @return The first GPIO error, or ESP_OK when all configured writes succeed.
 */
esp_err_t board_gpio_prepare_safe_outputs(const BoardProfile& board, bool& expanderResetRequested);

/**
 * @brief Set up the physical recovery button with the profile's input and pull modes.
 * @param[in] button Physical button wiring from the active board.
 * @return Results of both setup operations.
 */
BoardRecoveryButtonSetup board_gpio_setup_recovery_button(const BoardRecoveryButton& button);

/**
 * @brief Read the recovery button as a logical pressed state.
 * @param[in] button Physical button wiring from the active board.
 * @return True if the input level matches the active polarity.
 * @pre Both setup operations succeeded.
 */
bool board_gpio_recovery_button_pressed(const BoardRecoveryButton& button);
