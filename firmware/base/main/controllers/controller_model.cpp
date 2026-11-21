/**
 * @file controller_model.cpp
 * @brief Controller model validation, typed resources and coherent shared state.
 */
#include "controllers/controller_internal.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <vector>

#include "hardware/board_profile.h"
#include "cJSON.h"
#include "hardware/hardware_io.h"
#include "sensors/meteo_sensors.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "config/settings_json.h"
#include "config/model.h"
#include "system/runtime_supervisor.h"
#include "util/checksum.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {

std::mutex controller_mutex;
Configurations configurations;
std::array<std::vector<Runtime>, kControllerCount> runtimes;
bool initialized = false;
esp_err_t worker_error = ESP_OK;
std::string service_error;

/**
 * @brief Select the stable JSON spelling of a thermostat direction.
 * @param[in] mode Valid internal thermostat direction.
 * @return Borrowed lowercase protocol spelling.
 */
const char* mode_id(ThermostatMode mode)
{
    return mode == ThermostatMode::Heating ? "heating" : "cooling";
}

/**
 * @brief Select the stable JSON spelling of a physical sensor protocol.
 * @param[in] type Valid internal sensor protocol.
 * @return Borrowed lowercase protocol spelling.
 */
const char* sensor_id(SensorProtocol type)
{
    return type == SensorProtocol::Dht22 ? "dht22" : "onewire";
}

/**
 * @brief Select the protocol spelling of a logical resource category.
 * @param[in] kind Internal resource category.
 * @return Borrowed lowercase catalog spelling.
 */
const char* resource_id(ResourceKind kind)
{
    return kind == ResourceKind::Relay ? "relay" : kind == ResourceKind::Input ? "input" : "sensor";
}

/**
 * @brief Convert a controller kind to its shared configuration/runtime slot.
 * @param[in] kind Controller enum value; range checking is performed separately.
 * @return Zero-based slot, including an out-of-range value for an invalid enum.
 */
std::size_t index(ControllerKind kind)
{
    return static_cast<std::size_t>(kind);
}

/**
 * @brief Check whether an enum value names a supported controller module.
 * @param[in] kind Candidate controller enum value.
 * @return True when the corresponding shared-array slot exists.
 */
bool valid_kind(ControllerKind kind)
{
    return index(kind) < kControllerCount;
}

/**
 * @brief Select the stable JSON/MQTT identifier for a supported module.
 * @param[in] kind Valid module enum; the final branch represents thermostats.
 * @return Borrowed static lowercase identifier.
 * @pre The caller has rejected unsupported enum values.
 */
const char* controller_id(ControllerKind kind)
{
    return kind == ControllerKind::Sockets       ? "sockets"
           : kind == ControllerKind::Lights      ? "lights"
           : kind == ControllerKind::Meteo       ? "meteo"
           : kind == ControllerKind::Thermostats ? "thermostats"
                                                 : "security";
}

/**
 * @brief Create empty, disabled module settings bound to the active board.
 * @return Independent configurations with initial revision values and no output claims.
 * @pre The board profile has been activated.
 */
Configurations defaults()
{
    Configurations result;
    for (auto& config : result)
        config.boardId = board_profile_active().id;
    return result;
}

/**
 * @brief Validate an item identifier used by storage, JSON and MQTT commands.
 * @param[in] value Candidate byte string.
 * @return True for a nonempty bounded ASCII identifier containing letters, digits, dash or
 * underscore.
 */
bool valid_id(std::string_view value)
{
    if (value.empty() || value.size() > kSocketMaxIdBytes)
        return false;
    for (unsigned char c : value) {
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-'
              || c == '_'))
            return false;
    }
    return true;
}

/**
 * @brief Validate a bounded UTF-8 controller name with at least one visible character.
 * @param[in] text Candidate name as encoded UTF-8 bytes.
 * @return False for blank text, controls, malformed/overlong UTF-8, surrogates or oversized names.
 */
bool valid_name(std::string_view text)
{
    return valid_utf8_name(text, kSocketMaxNameBytes);
}

/**
 * @brief Resolve a relay or digital-input name against the active board profile.
 * @param[in] id Exact logical port identifier.
 * @param[in] relay True selects relay ports; false selects digital inputs.
 * @return True when the requested port belongs to that profile catalog.
 */
bool known_port(std::string_view id, bool relay)
{
    const auto& board = board_profile_active();
    const auto* ports = relay ? board.relays : board.inputs;
    const auto count = relay ? board.relayCount : board.inputCount;
    for (std::size_t i = 0; i < count; ++i)
        if (id == ports[i].name)
            return true;
    return false;
}

/**
 * @brief Translate a physical digital-input level into contact closure using the board wiring.
 * @param[in] id Known input identifier in the active board profile.
 * @param[in] level Physical HIGH/LOW from a valid input observation.
 * @return True for a closed contact; false for an open or unknown input.
 * @pre Callers reject unavailable observations and validate the input binding first.
 * @note Pure profile lookup; diagnostic hardware levels remain unchanged.
 */
bool input_contact_closed(std::string_view id, bool level)
{
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.inputCount; ++i)
        if (id == board.inputs[i].name)
            return level == board.inputs[i].activeHigh;
    return false;
}

/**
 * @brief Check whether a logical sensor connector exists on the active board.
 * @param[in] id Exact sensor-port identifier.
 * @return True for a sensor port declared by the active profile.
 */
bool known_sensor_port(std::string_view id)
{
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.sensorPortCount; ++i)
        if (id == board.sensorPorts[i].name)
            return true;
    return false;
}

/**
 * @brief Normalize a DS18B20 ROM and verify its family code and Dallas CRC.
 * @param[in,out] address Sixteen hexadecimal ROM characters; uppercase digits are lowered in place.
 * @return True for a complete family-0x28 ROM with a valid CRC; failure may leave normalized
 * digits.
 */
bool normalize_address(std::string& address)
{
    if (address.size() != 16)
        return false;
    std::array<std::uint8_t, 8> bytes{};
    for (std::size_t i = 0; i < address.size(); ++i) {
        auto& c = address[i];
        if (c >= 'A' && c <= 'F')
            c = static_cast<char>(c + ('a' - 'A'));
        const int digit = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
        if (digit < 0)
            return false;
        bytes[i / 2] = static_cast<std::uint8_t>((bytes[i / 2] << 4) | digit);
    }
    return bytes[0] == 0x28 && fcplcn::util::crc8_dallas(bytes.data(), bytes.size()) == 0;
}

/**
 * @brief Validate one module's persisted fields, item limits and port bindings.
 * @param[in] config Borrowed complete module candidate.
 * @param[in] check_ports Require referenced connectors to exist on the active board when true.
 * @param[in] kind Module schema selecting switch, Meteo or thermostat validation.
 * @return True for supported values and unique item IDs; cross-module resource claims are checked
 * separately.
 */
bool valid_configuration(const Configuration& config, bool check_ports, ControllerKind kind)
{
    const bool meteo = kind == ControllerKind::Meteo;
    if (config.revision == 0 || config.boardId.empty() || config.boardId.size() > 64
        || config.items.size() > (meteo ? kMeteoMaxItems : kSocketMaxItems))
        return false;
    if (kind == ControllerKind::Security) {
        const auto& security = config.security;
        if (security.sirenRelayId.size() > 32 || security.readerPortId.size() > 32
            || security.entryDelaySeconds > 300 || security.exitDelaySeconds > 300
            || security.keys.size() > 16 || (config.triggered && !config.armed)
            || (!config.enabled && (config.armed || config.triggered))
            || (config.armed && config.items.empty())
            || (check_ports
                && ((!security.sirenRelayId.empty() && !known_port(security.sirenRelayId, true))
                    || (!security.readerPortId.empty()
                        && !known_sensor_port(security.readerPortId)))))
            return false;
        for (std::size_t i = 0; i < security.keys.size(); ++i) {
            const auto& key = security.keys[i];
            auto address = key.address;
            if (!valid_id(key.id) || !valid_name(key.name) || !normalize_security_address(address)
                || key.address != address)
                return false;
            for (std::size_t j = 0; j < i; ++j)
                if (security.keys[j].id == key.id || security.keys[j].address == key.address)
                    return false;
        }
    } else if (config.armed || config.triggered)
        return false;
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& item = config.items[i];
        if (!valid_id(item.id) || !valid_name(item.name))
            return false;
        if (meteo) {
            auto address = item.address;
            if (!item.relayId.empty() || !item.inputId.empty() || item.state || item.portId.empty()
                || item.portId.size() > 32
                || (item.sensorType != SensorProtocol::Dht22
                    && item.sensorType != SensorProtocol::OneWire)
                || (item.sensorType == SensorProtocol::Dht22
                        ? !item.address.empty()
                        : !normalize_address(address) || address != item.address)
                || (check_ports && !known_sensor_port(item.portId)))
                return false;
        } else if (kind == ControllerKind::Thermostats) {
            const auto tenth = std::round(item.setpointC * 10);
            if (!valid_id(item.meteoId) || item.relayId.empty() || item.relayId.size() > 32
                || item.inputId.size() > 32 || item.state
                || (item.mode != ThermostatMode::Heating && item.mode != ThermostatMode::Cooling)
                || !std::isfinite(item.setpointC) || item.setpointC < -55 || item.setpointC > 125
                || std::abs(item.setpointC * 10 - tenth) > 1e-7 || !std::isfinite(item.hysteresisC)
                || item.hysteresisC < 1 || item.hysteresisC > 20
                || std::floor(item.hysteresisC) != item.hysteresisC
                || (check_ports
                    && (!known_port(item.relayId, true)
                        || (!item.inputId.empty() && !known_port(item.inputId, false)))))
                return false;
        } else if (kind == ControllerKind::Security) {
            if (!item.relayId.empty() || !item.portId.empty() || !item.meteoId.empty()
                || item.inputId.empty() || item.inputId.size() > 32 || item.state || item.enabled
                || (item.securityType != SecuritySensorType::Reed
                    && item.securityType != SecuritySensorType::Motion)
                || (check_ports && !known_port(item.inputId, false)))
                return false;
        } else {
            if (item.relayId.empty() || item.relayId.size() > 32 || item.inputId.size() > 32
                || (!config.enabled && item.state))
                return false;
            if (check_ports
                && (!known_port(item.relayId, true)
                    || (!item.inputId.empty() && !known_port(item.inputId, false))))
                return false;
        }
        for (std::size_t j = 0; j < i; ++j) {
            if (item.id == config.items[j].id)
                return false;
        }
    }
    return true;
}

// All modules contribute claims here, even while disabled. Future modules can
// add sensor bindings without changing the catalog or ownership semantics.
/**
 * @brief Count logical resource claims across all modules, including disabled ones.
 * @param[in] configs Coherent borrowed configuration set.
 * @param[in] kind Resource category: relay, input or sensor.
 * @param[in] id Logical port name; an empty name has no owner.
 * @return Number of matching item bindings, without treating Meteo references as sensor claims.
 */
unsigned claim_count(const Configurations& configs, ResourceKind kind, std::string_view id)
{
    if (id.empty())
        return 0;
    unsigned count = 0;
    const auto& security = configs[index(ControllerKind::Security)].security;
    if ((kind == ResourceKind::Relay && security.sirenRelayId == id)
        || (kind == ResourceKind::Sensor && security.readerPortId == id))
        ++count;
    for (const auto& config : configs)
        for (const auto& item : config.items) {
            if ((kind == ResourceKind::Relay && item.relayId == id)
                || (kind == ResourceKind::Input && item.inputId == id)
                || (kind == ResourceKind::Sensor && item.portId == id))
                ++count;
        }
    return count;
}

/**
 * @brief Check whether Meteo bindings may safely share one physical sensor port.
 * @param[in] configs Coherent borrowed configuration set.
 * @param[in] port Sensor-port identifier; an empty identifier cannot conflict.
 * @return True for any DHT22 sharing or a repeated DS18B20 ROM on that port.
 */
bool sensor_conflict(const Configurations& configs, std::string_view port)
{
    if (port.empty())
        return false;
    const auto& items = configs[index(ControllerKind::Meteo)].items;
    if (configs[index(ControllerKind::Security)].security.readerPortId == port)
        for (const auto& item : items)
            if (item.portId == port)
                return true;
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (items[i].portId != port)
            continue;
        for (std::size_t j = i + 1; j < items.size(); ++j)
            if (items[j].portId == port
                && (items[i].sensorType != SensorProtocol::OneWire
                    || items[j].sensorType != SensorProtocol::OneWire
                    || items[i].address == items[j].address))
                return true;
    }
    return false;
}

/**
 * @brief Detect conflicting relay, optional input and sensor-port ownership.
 * @param[in] configs Complete candidate module set, including disabled rows.
 * @param[in] include_inputs Reject shared input claims when true; legacy loading may retain them
 * diagnostically.
 * @return True if any checked exclusive claim or incompatible sensor sharing is present.
 */
bool resource_conflict(const Configurations& configs, bool include_inputs)
{
    const auto& security = configs[index(ControllerKind::Security)].security;
    if (claim_count(configs, ResourceKind::Relay, security.sirenRelayId) > 1
        || sensor_conflict(configs, security.readerPortId))
        return true;
    for (const auto& config : configs)
        for (const auto& item : config.items) {
            if (claim_count(configs, ResourceKind::Relay, item.relayId) > 1
                || (include_inputs && claim_count(configs, ResourceKind::Input, item.inputId) > 1)
                || sensor_conflict(configs, item.portId))
                return true;
        }
    return false;
}

/**
 * @brief Count relay-consuming rows for the common controller capacity limit.
 * @param[in] configs Coherent configuration set.
 * @return Combined socket, light and thermostat row count; Meteo has its own independent limit.
 */
std::size_t item_count(const Configurations& configs)
{
    std::size_t result = 0;
    for (std::size_t module = 0; module < kRelayControllerCount; ++module)
        result += configs[module].items.size();
    result += configs[index(ControllerKind::Thermostats)].items.size();
    result += !configs[index(ControllerKind::Security)].security.sirenRelayId.empty();
    return result;
}

/**
 * @brief Determine whether a module contains an input claimed by multiple rows.
 * @param[in] config Module whose input bindings should be diagnosed.
 * @return True when any nonempty input is duplicated in the current shared configurations.
 * @pre The caller holds controller_mutex while reading the global claim set.
 */
bool module_input_conflict(const Configuration& config)
{
    for (const auto& item : config.items)
        if (claim_count(configurations, ResourceKind::Input, item.inputId) > 1)
            return true;
    return false;
}

/**
 * @brief Compare physical/resource bindings and the stable item identity.
 * @param[in] a First row.
 * @param[in] b Second row.
 * @return True when IDs, relay/input, sensor protocol/port/ROM and Meteo reference match.
 * @note Display name, setpoints, operative flags and saved switch state are compared separately.
 */
bool same_binding(const Item& a, const Item& b)
{
    return a.id == b.id && a.relayId == b.relayId && a.inputId == b.inputId && a.portId == b.portId
           && a.sensorType == b.sensorType && a.address == b.address && a.meteoId == b.meteoId
           && a.securityType == b.securityType && a.entryDelay == b.entryDelay;
}

/**
 * @brief Detect a no-op replacement without considering the optimistic revision token.
 * @param[in] a Existing module configuration.
 * @param[in] b Candidate module configuration.
 * @return True when module flags, profile and ordered item settings/states are equal.
 */
bool same_configuration(const Configuration& a, const Configuration& b)
{
    if (a.enabled != b.enabled || a.boardId != b.boardId || a.items.size() != b.items.size()
        || a.armed != b.armed || a.triggered != b.triggered
        || a.security.sirenRelayId != b.security.sirenRelayId
        || a.security.readerPortId != b.security.readerPortId
        || a.security.entryDelaySeconds != b.security.entryDelaySeconds
        || a.security.exitDelaySeconds != b.security.exitDelaySeconds
        || a.security.keys.size() != b.security.keys.size())
        return false;
    for (std::size_t i = 0; i < a.security.keys.size(); ++i)
        if (a.security.keys[i].id != b.security.keys[i].id
            || a.security.keys[i].name != b.security.keys[i].name
            || a.security.keys[i].address != b.security.keys[i].address)
            return false;
    for (std::size_t i = 0; i < a.items.size(); ++i) {
        if (!same_binding(a.items[i], b.items[i]) || a.items[i].name != b.items[i].name
            || a.items[i].mode != b.items[i].mode || a.items[i].setpointC != b.items[i].setpointC
            || a.items[i].hysteresisC != b.items[i].hysteresisC
            || a.items[i].state != b.items[i].state || a.items[i].enabled != b.items[i].enabled)
            return false;
    }
    return true;
}

/**
 * @brief Copy a bounded JSON string field, optionally accepting its absence.
 * @param[in] object Borrowed JSON object.
 * @param[in] key Exact case-sensitive field name.
 * @param[out] value Copied text when present and valid; unchanged for an absent optional field.
 * @param[in] maximum Maximum allowed encoded byte length.
 * @param[in] optional True allows a missing field, while a present field must still be a string.
 * @return True for a valid string or an allowed absence; no output change on type/size failure.
 */
bool text_field(
    const cJSON* object, const char* key, std::string& value, std::size_t maximum, bool optional)
{
    const auto* field = cJSON_GetObjectItemCaseSensitive(object, key);
    if (field == nullptr)
        return optional;
    if (!cJSON_IsString(field) || field->valuestring == nullptr
        || std::strlen(field->valuestring) > maximum)
        return false;
    value = field->valuestring;
    return true;
}

}  // namespace fcplcn::controllers::detail

/** @endcond */
