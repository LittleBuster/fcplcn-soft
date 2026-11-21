/**
 * @file network.h
 * @brief Local AP/STA, W5500 and Linux-broker MQTT lifecycle management.
 * @details Interface and MQTT stop/start operations run on a dedicated manager.
 * Event callbacks publish observations/notifications and never tear down clients.
 */
#pragma once
#include "cJSON.h"
#include "esp_err.h"
/**
 * @brief Initialize network objects once and start the configuration manager.
 * @return ESP_OK or an initialization/task allocation error.
 * @pre esp_netif_init(), the default event loop, NVS, configuration and board activation
 * have completed. Call from startup, before serving HTTP requests.
 * @note Peripheral Ethernet failure is reported asynchronously and leaves Wi-Fi available.
 */
esp_err_t network_init();

/** @brief Coalesce a request to apply the latest saved settings after the HTTP reply.
 * @note Thread-safe task-context notification; the manager delays apply by about one second.
 * A pending board-profile change is applied only at reboot.
 */
void network_schedule_apply();

/** @brief Copy current Wi-Fi, Ethernet and Linux MQTT observations without credentials.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr if the root cannot be allocated.
 * @note Thread-safe in task context after initialization; SDK observation calls may block briefly.
 */
cJSON* network_status_json();
