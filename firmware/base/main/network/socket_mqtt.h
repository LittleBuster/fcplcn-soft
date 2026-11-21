/**
 * @file socket_mqtt.h
 * @brief Boot-scoped, idempotent MQTT SET handling for FCPLCn controllers.
 * @details Each controllable module has an independent sequence and cached ACK.
 * The command mutex is acquired before the controller mutex; no controller or
 * hardware callback takes it in reverse order. Commands do not contain cloud
 * credentials. Delivery expiry is not a lease for a switch or thermostat flag.
 */
#pragma once
#include <cstddef>
#include <cstdint>
#include <string_view>
#include "controllers/socket_controller.h"
struct cJSON;

/**
 * @brief Validate and execute one complete explicit SET command.
 * @param kind Sockets, Lights or Thermostats; Meteo is read-only.
 * @param payload Borrowed complete JSON message, at most 512 bytes.
 * @param retained Broker RETAIN flag; retained commands are rejected.
 * @param bootId Current local boot identifier against which the payload is checked.
 * @param uptimeMs Current monotonic uptime used to bound the delivery deadline to 60 seconds.
 * @return Owned ACK object, or nullptr on allocation failure; delete with cJSON_Delete.
 * @details Rejects wrong boot, malformed/expired or out-of-order commands. An
 * identical retry of the last sequence returns its cached result without another
 * actuation. The same sequence with different content is a conflict. Failures
 * also consume accepted sequences. Thermostats change their durable enabled flag,
 * never the heat/cool demand directly. Actual deadline checks are repeated by the
 * controller after lock waits and, for relay writes, by the hardware service.
 */
cJSON* controller_mqtt_command(ControllerKind kind,
                               std::string_view payload,
                               bool retained,
                               std::string_view bootId,
                               std::int64_t uptimeMs);

/**
 * @brief Read the last accepted command sequence for one module.
 * @param kind Controllable module.
 * @return Current sequence, initially zero; zero also denotes an unsupported kind.
 */
std::uint32_t controller_mqtt_sequence(ControllerKind kind);

/**
 * @brief Capture controller state and commandSequence in the command-to-controller lock order.
 * @param kind Sockets, Lights or Thermostats.
 * @return Owned JSON snapshot, or nullptr for an unsupported kind/allocation failure.
 */
cJSON* controller_mqtt_status_json(ControllerKind kind);

/**
 * @brief Compatibility wrapper for a Sockets SET command.
 * @param payload Complete borrowed JSON message.
 * @param retained Broker RETAIN flag.
 * @param bootId Current boot identifier.
 * @param uptimeMs Current monotonic uptime in milliseconds.
 * @return Owned ACK object, or nullptr on allocation failure.
 * @see controller_mqtt_command
 */
cJSON* socket_mqtt_command(std::string_view payload,
                           bool retained,
                           std::string_view bootId,
                           std::int64_t uptimeMs);

/** @brief Read the Sockets command sequence. @return Last accepted sequence, initially zero. */
std::uint32_t socket_mqtt_sequence();

/**
 * @brief Capture the Sockets state and its command sequence coherently.
 * @return Owned JSON snapshot, or nullptr on allocation failure.
 */
cJSON* socket_mqtt_status_json();
#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
/** @brief Reset all in-memory command sequences and cached ACKs for a simulated host boot. */
void socket_mqtt_test_reset();
#endif
