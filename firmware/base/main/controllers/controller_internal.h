/**
 * @file controller_internal.h
 * @brief Private controller model, state and cross-module declarations.
 * @details Lock order remains SettingsWriteGuard -> controller_mutex -> hardware/store.
 * Public users include socket_controller.h; this header is implementation-only.
 */
#pragma once
#include "controllers/socket_controller.h"

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
#include "config/state_journal.h"
#include "system/runtime_supervisor.h"
#include "util/checksum.h"
#include "util/operation_context.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {

inline constexpr char kTag[] = "fcplcn_controllers";
inline constexpr std::array<std::uint8_t, 8> kMagic{{'F', 'C', 'S', 'O', 'C', 'K', '0', '1'}};
inline constexpr std::array<std::uint8_t, 8> kControllerMagic{
    {'F', 'C', 'C', 'T', 'R', 'L', '0', '9'}};
inline constexpr std::array<std::uint8_t, 8> kV8Magic{{'F', 'C', 'C', 'T', 'R', 'L', '0', '8'}};
inline constexpr std::array<std::uint8_t, 8> kV7Magic{{'F', 'C', 'C', 'T', 'R', 'L', '0', '7'}};
inline constexpr std::array<std::uint8_t, 8> kV6Magic{{'F', 'C', 'C', 'T', 'R', 'L', '0', '6'}};
inline constexpr std::array<std::uint8_t, 8> kV5Magic{{'F', 'C', 'C', 'T', 'R', 'L', '0', '5'}};
inline constexpr std::array<std::uint8_t, 8> kV4Magic{{'F', 'C', 'C', 'T', 'R', 'L', '0', '4'}};
inline constexpr std::array<std::uint8_t, 8> kV3Magic{{'F', 'C', 'C', 'T', 'R', 'L', '0', '3'}};
inline constexpr std::array<std::uint8_t, 8> kV2Magic{{'F', 'C', 'C', 'T', 'R', 'L', '0', '2'}};
inline constexpr std::size_t kMaxBlobBytes = 5120;
inline constexpr std::int64_t kDebounceUs = 50'000;
inline constexpr std::int64_t kPressLockoutUs = 300'000;
inline constexpr unsigned kPressConfirmSamples = 3;
inline constexpr std::uint32_t kLegacyMaxDwellSeconds = 86'400;
inline constexpr std::int64_t kRetryUs = 1'000'000;
inline constexpr std::size_t kControllerCount = 5;
inline constexpr std::size_t kRelayControllerCount = 2;
inline constexpr std::int64_t kMeteoStaleMs = 15'000;

/** @brief Internal exclusive/shared resource categories; protocol spellings remain at JSON
 * boundaries. */
enum class ResourceKind { Relay, Input, Sensor };

/** @brief Autonomous thermostat direction, represented as text only at JSON boundaries. */
enum class ThermostatMode { Heating, Cooling };

/** @brief Physical Meteo protocol represented internally as an enum. */
enum class SensorProtocol { Dht22, OneWire };

/** @brief Fixed contact polarity of a security zone on active-low digital inputs. */
enum class SecuritySensorType { Reed, Motion };

/** @brief One named, CRC-checked DS1990A-family credential in the local allowlist. */
struct SecurityKey {
    std::string id, name, address;
};

/** @brief Persistent common wiring, access credentials and monotonic delay policy. */
struct SecuritySettings {
    std::string sirenRelayId, readerPortId;
    std::uint16_t entryDelaySeconds = 15;
    std::uint16_t exitDelaySeconds = 30;
    std::vector<SecurityKey> keys;
};

/**
 * @brief Persisted row shared by the versioned module codecs.
 * @details Fields are interpreted by ControllerKind. state is the durable static
 * switch value; enabled is a thermostat permission, not its runtime relay demand.
 * Meteo port/ROM bindings are sensor claims; meteoId is only a reusable reference.
 */
struct Item {
    std::string id, name, relayId, inputId;
    std::string portId, address;
    SensorProtocol sensorType = SensorProtocol::Dht22;
    std::string meteoId;
    ThermostatMode mode = ThermostatMode::Heating;
    double setpointC = 22, hysteresisC = 1;
    bool state = false;
    bool enabled = false;
    SecuritySensorType securityType = SecuritySensorType::Reed;
    bool entryDelay = false;
};

/** @brief Persisted settings for one module, sharing the common board identity and commit bundle.
 */
struct Configuration {
    std::uint32_t revision = 1;
    bool enabled = false;
    std::string boardId;
    std::vector<Item> items;
    SecuritySettings security;
    bool armed = false;
    bool triggered = false;
};

/**
 * @brief Non-persistent per-row debounce, observation and autonomous-control state.
 * @details A storage/I/O-failed flag command sets inhibited until explicit success.
 * Physical source edits advance bindingChangedAtMs, requiring a newer measurement.
 * Neither thermostatDemand nor inhibit is restored as a saved ON at boot.
 */
struct Runtime {
    bool baseline = false;
    bool armed = false;
    std::int64_t highSinceUs = -1;
    unsigned lowSamples = 0;
    std::int64_t lockoutUntilUs = 0;
    std::int64_t lastInputUs = -1;
    std::uint32_t inputGeneration = 0;
    bool seenRelay = false;
    std::uint32_t relayGeneration = 0;
    std::int64_t lastAttemptUs = -1;
    std::string error;
    bool thermostatDemand = false;
    bool sensorHealthy = false;
    bool inhibited = false;
    std::string inhibitError;
    std::string sensorSignature;
    // Confirmed relay transition epoch; a negative marker forces a conservative startup OFF delay.
    std::int64_t transitionAtUs = -1;
    bool transitionValue = false;
    std::int64_t holdUntilUs = 0;
    std::string holdReason;
    // Only successful physical samples populate this per-Meteo-binding cache.
    bool cachedTemperature = false;
    double lastTemperatureC = 0;
    std::int64_t lastTemperatureMs = -1;
    std::int64_t lastTemperatureExpiryUs = 0;
    std::string cachedSensorSignature;
    // Meteo physical binding edits require a sample strictly after this epoch.
    std::int64_t bindingChangedAtMs = -1;
};

/** @brief Physical switch snapshots with separate validity flags for relay and optional input. */
struct Observation {
    HardwareIoChannelState relay, input;
    bool relayReady = false;
    bool inputReady = true;
};

/** @brief Static-switch transaction journal entry used for ordered actuation and best-effort
 * rollback. */
struct RelayChange {
    std::string id;
    bool target;
    bool previous;
    bool changed = false;
};

/** @brief Owned local temperature snapshot with source identity, absolute expiry and an unavailable
 * diagnostic. */
struct TemperatureSample {
    bool available = false;
    bool cached = false;
    double value = 0;
    std::int64_t expiresAtUs = 0;
    std::string name, signature, error;
};

using Configurations = std::array<Configuration, kControllerCount>;
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

extern std::mutex controller_mutex;
extern Configurations configurations;
extern std::array<std::vector<Runtime>, kControllerCount> runtimes;
extern bool initialized;
extern esp_err_t worker_error;
extern std::string service_error;

const char* mode_id(ThermostatMode mode);

const char* sensor_id(SensorProtocol type);

const char* security_type_id(SecuritySensorType type);

bool normalize_security_address(std::string& address);

bool parse_security_module(const cJSON* json,
                           Configuration& parsed,
                           std::string& error,
                           bool backup);

cJSON* security_status_locked();

ControllerResult update_security_locked(const cJSON* request, std::string& error);

void security_step_locked();

void apply_security_config();

ControllerResult
set_security_armed_locked(bool armed, std::string& error, std::int64_t deadlineUs = 0);

void reset_security_runtime();

const char* resource_id(ResourceKind kind);

std::size_t index(ControllerKind kind);

bool valid_kind(ControllerKind kind);

const char* controller_id(ControllerKind kind);

Configurations defaults();

bool valid_id(std::string_view value);

bool valid_name(std::string_view text);

bool known_port(std::string_view id, bool relay);

bool known_sensor_port(std::string_view id);

bool normalize_address(std::string& address);

bool valid_configuration(const Configuration& config,
                         bool check_ports,
                         ControllerKind kind = ControllerKind::Sockets);

unsigned claim_count(const Configurations& configs, ResourceKind kind, std::string_view id);

bool sensor_conflict(const Configurations& configs, std::string_view port);

bool resource_conflict(const Configurations& configs, bool include_inputs);

std::size_t item_count(const Configurations& configs);

bool module_input_conflict(const Configuration& config);

std::uint32_t crc32(const std::uint8_t* data, std::size_t size);

void append_u32(std::vector<std::uint8_t>& bytes, std::uint32_t value);

void append_u16(std::vector<std::uint8_t>& bytes, std::uint16_t value);

void append_text(std::vector<std::uint8_t>& bytes, std::string_view text);

SettingsBytes encode_record(const Configurations& configs);

esp_err_t save(const Configurations& configs);

bool state_record_key(const SettingsBytes& record, StateJournalKey& key);

StateJournalPayload encode_states(const Configurations& configs);

esp_err_t
apply_states(const StateJournalPayload& payload, Configurations& configs, bool allowLegacy = false);

void clear_states(Configurations& configs);

esp_err_t save_states(const Configurations& configs);

esp_err_t load_states(Configurations& configs);

bool state_storage_healthy();

void activate_state_record(const SettingsBytes& record);

void reset_state_storage();

const std::string& state_storage_error();

cJSON* state_storage_json_locked();

esp_err_t decode_legacy_record(const SettingsBytes& bytes, Configuration& result);

esp_err_t decode_record(const SettingsBytes& bytes, Configurations& result);

esp_err_t load(Configurations& result);

bool same_binding(const Item& a, const Item& b);

bool same_configuration(const Configuration& a, const Configuration& b);

Observation observe(const Configuration& config, const Item& item);

SocketResult unavailable(std::string& error, const char* message);

SocketResult expired(std::string& error);

bool deadline_expired(std::int64_t deadlineUs);

SocketResult set_state_locked(ControllerKind kind,
                              std::size_t item_index,
                              bool on,
                              std::string& error,
                              std::int64_t deadlineUs = 0);

void baseline(Runtime& transient, const HardwareIoChannelState& input);

bool button_press(Runtime& transient, const HardwareIoChannelState& input);

void worker_step();

void worker(void*);

bool text_field(const cJSON* object,
                const char* key,
                std::string& value,
                std::size_t maximum,
                bool optional = false);

void rollback(std::vector<RelayChange>& changes);

esp_err_t apply_relay_recovery_policies();

void apply_meteo_config();

bool fresh_measurement(std::int64_t last, std::int64_t now);

TemperatureSample temperature_sample(std::string_view id);

bool thermostat_binding(const Item& a, const Item& b);

bool thermostat_input(const Item& item, HardwareIoChannelState& input, std::string& error);

void confirmed_transition(Runtime& runtime, bool value, std::int64_t now, bool restart = false);

void inhibit_thermostat(std::size_t item_index, const std::string& error);

ControllerResult set_thermostat_enabled_locked(std::size_t item_index,
                                               bool enabled,
                                               std::string& error,
                                               std::int64_t deadlineUs = 0);

void thermostats_step_locked();

cJSON* thermostats_status_locked();

bool add_age(cJSON* json, std::int64_t last, std::int64_t now);

cJSON* device_reading_json(const MeteoDeviceReading& device, bool enabled, std::int64_t now);

cJSON* meteo_status_locked();

bool parse_thermostat_item(const cJSON* json, Item& item, bool backup = false);

ControllerResult update_thermostats_locked(const cJSON* request, std::string& error);

bool parse_meteo_item(const cJSON* json, Item& item);

ControllerResult update_meteo_locked(const cJSON* request, std::string& error);

cJSON* status_locked(ControllerKind kind);

cJSON* resources_locked();

cJSON* backup_module_json(const Configuration& config, ControllerKind kind);

bool parse_backup_module(const cJSON* json,
                         std::uint32_t revision,
                         Configuration& parsed,
                         std::string& error,
                         ControllerKind kind = ControllerKind::Sockets);

ControllerResult thermostat_enabled_command(
    std::string_view id, bool enabled, std::string& error, bool limited, std::int64_t deadlineMs);

}  // namespace fcplcn::controllers::detail

/** @endcond */
