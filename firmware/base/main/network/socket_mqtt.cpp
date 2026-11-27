/**
 * @file socket_mqtt.cpp
 * @brief Per-module MQTT sequence validation, cached acknowledgements and dispatch.
 * @details Relative toggles are deliberately absent from the protocol. Accepted
 * sequences, including failed results, are cached for idempotent last-command
 * retries. The command lock precedes controller/hardware/storage locks; no owner
 * path calls back into this module. Expiry limits delivery, not enabled duration.
 */
#include "network/socket_mqtt.h"
#include "controllers/security_sync.h"
#include "config/model.h"
#include "cJSON.h"
#include <array>
#include <algorithm>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

/**
 * @brief Per-module last accepted sequence, payload identity and replay result.
 * @details Confirmed and failed results are both cached. A duplicate returns
 * that historical acknowledgement; it does not assert the current output state.
 */
struct CommandState {
    std::uint32_t sequence = 0;
    std::string id, error;
    std::string fence;
    bool value = false, ok = false;
    std::int64_t deadline = 0;
};

std::mutex command_mutex;
std::array<CommandState, static_cast<std::size_t>(ControllerKind::Irrigation) + 1> states;

/**
 * @brief Locate the cached command result for a controllable module.
 * @param[in] kind Sockets, Lights, Thermostats, Security, Tanks or Irrigation; Meteo has no SET
 * commands.
 * @return Borrowed state slot, or nullptr for an unsupported module.
 * @pre The caller holds command_mutex before reading or changing the returned slot.
 */
CommandState* command_state(ControllerKind kind)
{
    if (kind != ControllerKind::Sockets && kind != ControllerKind::Lights
        && kind != ControllerKind::Thermostats && kind != ControllerKind::Security
        && kind != ControllerKind::Tanks && kind != ControllerKind::Irrigation)
        return nullptr;
    const auto index = static_cast<std::size_t>(kind);
    return index < states.size() ? &states[index] : nullptr;
}

/**
 * @brief Read one finite, exactly integral numeric field from a command object.
 * @param[in] object Borrowed JSON command object.
 * @param[in] key Case-sensitive property name.
 * @param[out] value Numeric value on success; unchanged when validation fails.
 * @return True for a finite JSON number without a fractional part; range checks belong to the
 * caller.
 */
bool number(const cJSON* object, const char* key, double& value)
{
    const auto* item = cJSON_GetObjectItemCaseSensitive(object, key);
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble)
        || std::floor(item->valuedouble) != item->valuedouble)
        return false;
    value = item->valuedouble;
    return true;
}

/**
 * @brief Build an owned acknowledgement for a controller SET attempt.
 * @param[in] boot Current boot identifier copied into the response.
 * @param[in] sequence Command sequence reported by the acknowledgement.
 * @param[in] id Controller element ID; empty when no valid ID was accepted.
 * @param[in] value Explicit requested state, not a new readback of the physical output.
 * @param[in] ok Whether the command succeeded when originally executed.
 * @param[in] error Optional error text; omitted when empty.
 * @param[in] duplicate Whether this is the cached result of an identical last-command retry.
 * @return Owned JSON object, or nullptr on allocation/property failure; delete with cJSON_Delete.
 */
cJSON* ack(std::string_view boot,
           std::uint32_t sequence,
           const std::string& id,
           bool value,
           bool ok,
           const std::string& error,
           bool duplicate = false)
{
    Json result(cJSON_CreateObject(), cJSON_Delete);
    if (!result || !cJSON_AddBoolToObject(result.get(), "ok", ok)
        || !cJSON_AddStringToObject(result.get(), "bootId", std::string(boot).c_str())
        || !cJSON_AddNumberToObject(result.get(), "sequence", sequence)
        || !cJSON_AddStringToObject(result.get(), "id", id.c_str())
        || !cJSON_AddBoolToObject(result.get(), "value", value)
        || !cJSON_AddBoolToObject(result.get(), "duplicate", duplicate)
        || (!error.empty() && !cJSON_AddStringToObject(result.get(), "error", error.c_str())))
        return nullptr;
    return result.release();
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and execute one complete explicit SET command.
 * @param kind Sockets, Lights, Thermostats, Security, Tanks or Irrigation; Meteo is read-only.
 * @param payload Borrowed complete JSON message, at most 512 bytes.
 * @param retained Broker RETAIN flag; retained commands are rejected.
 * @param bootId Current local boot identifier against which the payload is checked.
 * @param uptimeMs Current monotonic uptime used to bound the delivery deadline to 60 seconds.
 * @return Owned ACK object, or nullptr on allocation failure; delete with cJSON_Delete.
 * @details Rejects wrong boot, malformed/expired or out-of-order commands. An
 * identical retry of the last sequence returns its cached result without another
 * actuation. The same sequence with different content is a conflict. Failures
 * also consume accepted sequences. Thermostats, Tanks and Irrigation change their durable enabled
 * flag, never the heat/cool demand directly. Actual deadline checks are repeated by the controller
 * after lock waits and, for relay writes, by the hardware service.
 * @endcond
 */
cJSON* controller_mqtt_command(ControllerKind kind,
                               std::string_view payload,
                               bool retained,
                               std::string_view bootId,
                               std::int64_t uptimeMs)
{
    std::lock_guard<std::mutex> lock(command_mutex);
    auto reject = [&](const char* error) {
        return ack(bootId, 0, "", false, false, error);
    };
    auto* state = command_state(kind);
    if (!state)
        return reject("unknown_controller");
    if (retained)
        return reject("retained_command");
    if (payload.empty() || payload.size() > 512 || !supported_json_text(payload))
        return reject("invalid_payload");
    const std::string text(payload);
    Json json(cJSON_ParseWithLengthOpts(text.c_str(), text.size() + 1, nullptr, true),
              cJSON_Delete);
    if (!json || !cJSON_IsObject(json.get()))
        return reject("invalid_payload");
    const auto* boot = cJSON_GetObjectItemCaseSensitive(json.get(), "bootId");
    const auto* id = cJSON_GetObjectItemCaseSensitive(json.get(), "id");
    const auto* value = cJSON_GetObjectItemCaseSensitive(json.get(), "value");
    double next = 0, deadline = 0;
    if (!cJSON_IsString(boot) || bootId != boot->valuestring)
        return reject("wrong_boot");
    if (!cJSON_IsString(id) || !id->valuestring || !id->valuestring[0]
        || std::string_view(id->valuestring).size() > kSocketMaxIdBytes || !cJSON_IsBool(value)
        || !number(json.get(), "sequence", next) || next < 1 || next > UINT32_MAX
        || !number(json.get(), "expiresAtUptimeMs", deadline) || deadline < 0
        || deadline > 9007199254740991.0)
        return reject("invalid_command");
    if (deadline <= uptimeMs || deadline > uptimeMs + 60'000)
        return reject("expired_or_invalid_deadline");
    const auto sequence = static_cast<std::uint32_t>(next);
    if (kind == ControllerKind::Security && std::string_view(id->valuestring) != "alarm")
        return reject("invalid_security_id");
    const bool on = cJSON_IsTrue(value);
    SecurityCommandFence fence;
    std::string fenceIdentity;
    const auto* epoch = cJSON_GetObjectItemCaseSensitive(json.get(), "hubEpoch");
    const bool fenced = epoch != nullptr || cJSON_HasObjectItem(json.get(), "modeRevision")
                        || cJSON_HasObjectItem(json.get(), "leaseSequence");
    if (fenced) {
        double revision = 0, lease = 0;
        if (kind != ControllerKind::Security || !cJSON_IsString(epoch)
            || std::string_view(epoch->valuestring).empty()
            || std::string_view(epoch->valuestring).size() > 96
            || !std::all_of(epoch->valuestring,
                            epoch->valuestring + std::char_traits<char>::length(epoch->valuestring),
                            [](unsigned char c) {
                                return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                                       || (c >= '0' && c <= '9') || c == '_' || c == '-';
                            })
            || !number(json.get(), "modeRevision", revision) || revision < 0
            || revision > UINT32_MAX || !number(json.get(), "leaseSequence", lease) || lease < 1
            || lease > UINT32_MAX)
            return reject("invalid_security_fence");
        fence = {epoch->valuestring,
                 static_cast<std::uint32_t>(revision),
                 static_cast<std::uint32_t>(lease)};
        fenceIdentity = fence.hubEpoch + ":" + std::to_string(fence.modeRevision) + ":"
                        + std::to_string(fence.leaseSequence);
    }
    if (sequence < state->sequence)
        return ack(bootId, sequence, id->valuestring, on, false, "stale_sequence");
    if (sequence == state->sequence) {
        if (state->id != id->valuestring || state->value != on
            || state->deadline != static_cast<std::int64_t>(deadline)
            || state->fence != fenceIdentity)
            return ack(bootId, sequence, id->valuestring, on, false, "sequence_conflict");
        return ack(bootId, sequence, state->id, state->value, state->ok, state->error, true);
    }
    std::string error;
    const auto result =
        kind == ControllerKind::Security
            ? (fenced ? controller_security_set_hub_armed_until(
                            on, static_cast<std::int64_t>(deadline), fence, error)
                      : controller_security_set_armed_until(
                            on, static_cast<std::int64_t>(deadline), error))
        : kind == ControllerKind::Irrigation
            ? controller_irrigation_set_enabled_until(
                  id->valuestring, on, static_cast<std::int64_t>(deadline), error)
        : kind == ControllerKind::Tanks
            ? controller_tank_set_enabled_until(
                  id->valuestring, on, static_cast<std::int64_t>(deadline), error)
        : kind == ControllerKind::Thermostats
            ? controller_thermostat_set_enabled_until(
                  id->valuestring, on, static_cast<std::int64_t>(deadline), error)
            : controller_set_state_until(
                  kind, id->valuestring, on, static_cast<std::int64_t>(deadline), error);
    state->sequence = sequence;
    state->id = id->valuestring;
    state->value = on;
    state->deadline = static_cast<std::int64_t>(deadline);
    state->fence = fenceIdentity;
    state->ok = result == ControllerResult::Ok;
    state->error = std::move(error);
    return ack(bootId, sequence, state->id, state->value, state->ok, state->error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read the last accepted command sequence for one module.
 * @param kind Controllable module.
 * @return Current sequence, initially zero; zero also denotes an unsupported kind.
 * @endcond
 */
std::uint32_t controller_mqtt_sequence(ControllerKind kind)
{
    std::lock_guard<std::mutex> lock(command_mutex);
    const auto* state = command_state(kind);
    return state ? state->sequence : 0;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Capture controller state and commandSequence in the command-to-controller lock order.
 * @param kind Sockets, Lights or Thermostats.
 * @return Owned JSON snapshot, or nullptr for an unsupported kind/allocation failure.
 * @endcond
 */
cJSON* controller_mqtt_status_json(ControllerKind kind)
{
    std::lock_guard<std::mutex> lock(command_mutex);
    const auto* state = command_state(kind);
    if (!state)
        return nullptr;
    Json snapshot(controller_status_json(kind, false), cJSON_Delete);
    if (!snapshot || !cJSON_AddNumberToObject(snapshot.get(), "commandSequence", state->sequence))
        return nullptr;
    return snapshot.release();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Compatibility wrapper for a Sockets SET command.
 * @param payload Complete borrowed JSON message.
 * @param retained Broker RETAIN flag.
 * @param bootId Current boot identifier.
 * @param uptimeMs Current monotonic uptime in milliseconds.
 * @return Owned ACK object, or nullptr on allocation failure.
 * @see controller_mqtt_command
 * @endcond
 */
cJSON* socket_mqtt_command(std::string_view payload,
                           bool retained,
                           std::string_view bootId,
                           std::int64_t uptimeMs)
{
    return controller_mqtt_command(ControllerKind::Sockets, payload, retained, bootId, uptimeMs);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read the Sockets command sequence. @return Last accepted sequence, initially zero.
 * @endcond
 */
std::uint32_t socket_mqtt_sequence()
{
    return controller_mqtt_sequence(ControllerKind::Sockets);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Capture the Sockets state and its command sequence coherently.
 * @return Owned JSON snapshot, or nullptr on allocation failure.
 * @endcond
 */
cJSON* socket_mqtt_status_json()
{
    return controller_mqtt_status_json(ControllerKind::Sockets);
}
#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Reset all in-memory command sequences and cached ACKs for a simulated host boot.
 * @endcond
 */
void socket_mqtt_test_reset()
{
    std::lock_guard<std::mutex> lock(command_mutex);
    states = {};
}
#endif
