/**
 * @file board_gpio.cpp
 * @brief Profile-specific GPIO operations used during boot and network recovery.
 */
#include "board_gpio.h"

#include "board_profile.h"
#include "driver/gpio.h"

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Hold a fitted expander in reset and preload safe GPIO levels.
 * @param[in] board Validated immutable profile.
 * @param[out] expanderResetRequested True if both reset pin operations succeeded.
 * @return First GPIO error, or ESP_OK. Every safe pin is attempted.
 * @details Assert reset first. Preload the output latches before setting their directions.
 * Leave reset asserted until the initialized I/O driver is authorized to release it.
 * @endcond
 */
esp_err_t board_gpio_prepare_safe_outputs(const BoardProfile& board, bool& expanderResetRequested)
{
    expanderResetRequested = false;
    esp_err_t first = ESP_OK;
    if (board.expanderResetGpio >= 0) {
        const auto reset = static_cast<gpio_num_t>(board.expanderResetGpio);
        first = gpio_set_level(reset, 0);
        const auto direction = gpio_set_direction(reset, GPIO_MODE_OUTPUT);
        if (first == ESP_OK)
            first = direction;
        expanderResetRequested = first == ESP_OK;
    }
    for (std::size_t i = 0; i < board.safeBootGpioCount; ++i) {
        const auto& pin = board.safeBootGpios[i];
        if (pin.gpio == board.expanderResetGpio)
            continue;
        const auto gpio = static_cast<gpio_num_t>(pin.gpio);
        const auto level = gpio_set_level(gpio, pin.levelHigh);
        if (first == ESP_OK)
            first = level;
        const auto direction = gpio_set_direction(gpio, GPIO_MODE_OUTPUT);
        if (first == ESP_OK)
            first = direction;
    }
    return first;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Set the button direction and pull mode, attempting both operations.
 * @param[in] button Physical button wiring from the active board.
 * @return Separate direction and pull setup results.
 * @endcond
 */
BoardRecoveryButtonSetup board_gpio_setup_recovery_button(const BoardRecoveryButton& button)
{
    const auto gpio = static_cast<gpio_num_t>(button.gpio);
    const auto direction = gpio_set_direction(gpio, GPIO_MODE_INPUT);
    const auto pull = gpio_set_pull_mode(gpio, button.pullUp ? GPIO_PULLUP_ONLY : GPIO_FLOATING);
    return {direction, pull};
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read the configured input using its logical polarity.
 * @param[in] button Physical button wiring from the active board.
 * @return True when the button is pressed.
 * @pre Both setup operations succeeded.
 * @endcond
 */
bool board_gpio_recovery_button_pressed(const BoardRecoveryButton& button)
{
    return gpio_get_level(static_cast<gpio_num_t>(button.gpio)) == (button.activeLow ? 0 : 1);
}
