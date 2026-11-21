/**
 * @file web_server.h
 * @brief Authenticated local HTTP API and embedded service interface.
 */
#pragma once
#include "esp_err.h"
/**
 * @brief Start the HTTP server and register the local API and embedded assets.
 * @return ESP_OK or an ESP-IDF server/route registration error.
 * @pre Auth, settings, controllers, clocks and network initialization have completed.
 * Call once from startup; the server binds port 80 on all active local interfaces.
 * @note API mutations require a session and matching browser Origin/Host. JSON body sizes,
 * nesting, receive budgets and socket timeouts are bounded. No credentials are logged.
 */
esp_err_t web_server_start();
