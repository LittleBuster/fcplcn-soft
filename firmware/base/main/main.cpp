/**
 * @file main.cpp
 * @brief Firmware entry point and fail-closed boot sequencing.
 * @details Load the atomic settings bundle and validate/activate its board before profile GPIO
 * setup. Initialize safe outputs, local sensors and autonomous controller policies
 * before networking and HTTP. Optional peripheral failures remain diagnostic; NVS,
 * authentication and unknown-profile errors stop startup. Network recovery retains
 * the account and unrelated local control settings.
 */
#include "security/auth.h"
#include "hardware/board_profile.h"
#include "config/config.h"
#include "hardware/hardware_io.h"
#include "sensors/meteo_sensors.h"
#include "network/network.h"
#include "product_identity.h"
#include "time/rtc_clock.h"
#include "controllers/socket_controller.h"
#include "config/settings_store.h"
#include "system/system_metrics.h"
#include "system/firmware_update.h"
#include "system/runtime_supervisor.h"
#include "system/recovery_mode.h"
#include "time/time_service.h"
#include "web/web_server.h"

#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

namespace {
RecoveryBootState boot_state{};

/**
 * @brief Return to the previous confirmed image after a critical failure of a trial OTA boot.
 * @note The SDK restarts on successful rollback. If no valid fallback exists, preserve recovery
 * mode.
 */
void rollback_failed_trial()
{
    esp_ota_img_states_t state{};
    const auto* running = esp_ota_get_running_partition();
    if (running && esp_ota_get_state_partition(running, &state) == ESP_OK
        && state == ESP_OTA_IMG_PENDING_VERIFY)
        esp_ota_mark_app_invalid_rollback_and_reboot();
}

/**
 * @brief Assert safe physical outputs after validating the persisted active profile.
 * @param[in] board Immutable activated wiring, resolved before profile-bound GPIO initialization.
 * @return First GPIO error, or ESP_OK; every safe pin is attempted even after an earlier error.
 * @details The shared expander reset is asserted first, then output latches are preloaded before
 * directions change. Only validated settings/authentication permit hardware_io_init to release it.
 */
esp_err_t safe_gpio_first(const BoardProfile& board)
{
    boot_state.safeGpiosAttempted = true;
    esp_err_t first = ESP_OK;
    if (board.expanderResetGpio >= 0) {
        first = gpio_set_level(static_cast<gpio_num_t>(board.expanderResetGpio), 0);
        const auto direction =
            gpio_set_direction(static_cast<gpio_num_t>(board.expanderResetGpio), GPIO_MODE_OUTPUT);
        if (first == ESP_OK)
            first = direction;
        boot_state.expanderResetRequested = first == ESP_OK;
    }
    for (std::size_t i = 0; i < board.safeBootGpioCount; ++i) {
        const auto& pin = board.safeBootGpios[i];
        if (pin.gpio == board.expanderResetGpio)
            continue;  // Keep reset asserted until validated hardware initialization releases it.
        const auto gpio = static_cast<gpio_num_t>(pin.gpio);
        const auto level = gpio_set_level(gpio, pin.levelHigh);
        if (first == ESP_OK)
            first = level;
        const auto mode = gpio_set_direction(gpio, GPIO_MODE_OUTPUT);
        if (first == ESP_OK)
            first = mode;
    }
    boot_state.safeGpiosConfigured = first == ESP_OK;
    return first;
}

/**
 * @brief Stop critical early startup in the isolated, non-destructive recovery mode on failure.
 * @param[in] stage Static stage identifier retained in diagnostics.
 * @param[in] result SDK operation result; ESP_OK continues startup.
 * @pre I/O and controller tasks have not started, so their drivers cannot release safe reset.
 */
void require_boot(const char* stage, esp_err_t result)
{
    if (result != ESP_OK) {
        rollback_failed_trial();
        recovery_mode_run(stage, result, boot_state);
    }
}

/**
 * @brief Retain a noncritical service failure while local control loops continue running.
 * @param[in] stage Static stage identifier retained in diagnostics.
 * @param[in] result SDK operation result; ESP_OK is ignored.
 */
void service_result(const char* stage, esp_err_t result)
{
    if (result == ESP_OK)
        return;
    runtime_supervisor_record_error(stage, result);
    ESP_LOGW(FCPLCN_PRODUCT_NAME,
             "%s: %s; autonomous services continue",
             stage,
             esp_err_to_name(result));
}
}  // namespace

/**
 * @brief Initialize safe autonomous operation and supervise the physical network-recovery gesture.
 * @details Storage resolves the persisted board before any profile-bound GPIO is driven.
 * After activation, safe levels precede authentication and peripheral/task initialization.
 * Critical early errors retain settings and enter isolated recovery without guessing a pin map;
 * later service failures are diagnostic and do not abort autonomous control loops.
 * No automatic NVS erase is performed, including NO_FREE_PAGES or NEW_VERSION_FOUND errors.
 */
extern "C" void app_main()
{
    ESP_LOGI(FCPLCN_PRODUCT_NAME, "%s | %s", FCPLCN_PRODUCT_NAME, FCPLCN_PRODUCT_FULL_NAME);
    require_boot("runtime_supervisor", runtime_supervisor_init());
    require_boot("nvs_flash_init", nvs_flash_init());
    require_boot("settings_store", settings_store_init());
    require_boot("device_config", config_init());
    require_boot("board_profile",
                 board_profile_activate(config_get().hardware.boardId) ? ESP_OK
                                                                       : ESP_ERR_INVALID_ARG);
    const auto& board = board_profile_active();
    boot_state.boardId = board.id;
    require_boot("safe_gpio", safe_gpio_first(board));
    ESP_LOGI(FCPLCN_PRODUCT_NAME, "Board: %s (%s)", board.name, board.id);
    require_boot("authentication", auth_init());
    hardware_io_init();
    service_result("meteo", meteo_sensors_init());
    const auto controls = controllers_init();
    service_result("controllers", controls);
    rtc_clock_init();
    hardware_io_request_scan();
    system_metrics_init();
    const auto netif = esp_netif_init();
    service_result("network_core", netif);
    const auto events = netif == ESP_OK ? esp_event_loop_create_default() : netif;
    service_result("event_loop", events);
    if (netif == ESP_OK && events == ESP_OK) {
        service_result("network", network_init());
        service_result("time", time_service_init());
        service_result("http", web_server_start());
    }
    esp_ota_img_states_t state;
    const auto* running = esp_ota_get_running_partition();
    bool pending_ota = esp_ota_get_state_partition(running, &state) == ESP_OK
                       && state == ESP_OTA_IMG_PENDING_VERIFY;
    const auto& recovery = board.recoveryButton;
    const auto recovery_gpio = static_cast<gpio_num_t>(recovery.gpio);
    const auto button_direction = gpio_set_direction(recovery_gpio, GPIO_MODE_INPUT);
    service_result("recovery_button", button_direction);
    const auto button_pull =
        gpio_set_pull_mode(recovery_gpio, recovery.pullUp ? GPIO_PULLUP_ONLY : GPIO_FLOATING);
    service_result("recovery_button_pull", button_pull);
    unsigned held_ms = 0;
    bool recovered = false;
    const auto trial_started_us = esp_timer_get_time();
    std::int64_t next_accept_us = 0;
    std::int64_t next_rollback_us = trial_started_us + 30'000'000;
    bool trial_failure_reported = false;
    while (true) {
        firmware_update_poll();
        const auto now_us = esp_timer_get_time();
        if (pending_ota && controls == ESP_OK && runtime_supervisor_control_ready()
            && now_us >= next_accept_us) {
            // Do not accept a boot merely because tasks were created. Both critical workers
            // must have completed useful work; this check is retried after scheduler yields.
            const auto accepted = esp_ota_mark_app_valid_cancel_rollback();
            pending_ota = accepted != ESP_OK;
            next_accept_us = now_us + 1'000'000;
            service_result("ota_accept", accepted);
        }
        if (pending_ota && now_us >= next_rollback_us) {
            rollback_failed_trial();
            next_rollback_us = now_us + 1'000'000;
            if (!trial_failure_reported) {
                trial_failure_reported = true;
                service_result("ota_trial_timeout", ESP_ERR_TIMEOUT);
            }
            // A failed SDK rollback must not start early-boot recovery on top of active tasks.
            // Continue supervising the existing outputs and retry while this trial is unconfirmed.
        }
        vTaskDelay(pdMS_TO_TICKS(100));
        if (button_direction != ESP_OK || button_pull != ESP_OK)
            continue;
        const bool pressed = gpio_get_level(recovery_gpio) == (recovery.activeLow ? 0 : 1);
        if (!pressed) {
            held_ms = 0;
            recovered = false;
        } else if (!recovered)
            held_ms += 100;
        if (pressed && !recovered && held_ms >= recovery.holdMs) {
            recovered = true;
            ESP_LOGW(FCPLCN_PRODUCT_NAME,
                     "BOOT held: restore AP and Ethernet DHCP; keep user credentials");
            const auto reset = config_reset_networks();
            service_result("network_recovery", reset);
            if (reset == ESP_OK)
                network_schedule_apply();
        }
    }
}
