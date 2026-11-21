/**
 * @file socket_controller.h
 * @brief Shared autonomous Sockets, Lights, Meteo and Thermostats engine for FCPLCn.
 * @details One mutex serializes configuration, ownership and control. Mutations
 * acquire SettingsWriteGuard before the controller mutex, then hardware/storage
 * locks; no callback reverses that order. Config revisions change only for config
 * edits. Switch states and thermostat enabled flags persist separately; automatic
 * thermostat demand is RAM-only and starts OFF. Read-only calls do not need the
 * MQTT command mutex. JSON results belong to the caller unless stated otherwise.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

#include "esp_err.h"
#include "config/settings_store.h"

struct cJSON;
struct SecurityCommandFence;

/**
 * @brief Stage replacement states in FRAM while preserving the current flash identity.
 * @param[in] replacement Validated new current-format controller record.
 * @param[in] current Current flash controller section, possibly empty or legacy.
 * @return ESP_OK after verified FRAM staging, or a record/transport error.
 * @note Exclude controller writers and call before committing replacement flash settings.
 */
esp_err_t controllers_prepare_restore_states(const SettingsBytes& replacement,
                                             const SettingsBytes& current);

/**
 * @brief Export coherent flash settings together with their latest FRAM operative states.
 * @param[out] snapshot Complete flash snapshot used for the returned controller data.
 * @param[out] error Failure diagnostic, cleared on success.
 * @return Owned controller JSON, or nullptr if flash/FRAM cannot be read coherently.
 * @note Thread-safe; excludes state changes and restore staging during the snapshot.
 */
cJSON* controllers_backup_snapshot(SettingsSnapshot& snapshot, std::string& error);

/**
 * @brief Copy FRAM state-storage health for service diagnostics without touching I2C.
 * @return Owned JSON object, or nullptr on allocation failure.
 * @note Thread-safe; does not expose saved operative payload bytes.
 */
cJSON* controllers_state_storage_json();

/**
 * @brief Read and validate FRAM for an explicit hardware-page snapshot.
 * @return Owned health/allocation JSON, or nullptr on allocation failure.
 * @note Thread-safe. Performs bounded I2C reads; no writes or output restoration occur.
 */
cJSON* controllers_probe_state_storage_json();

/** @brief Legacy socket namespace, retained for first-boot migration and host fixtures. */
inline constexpr const char* kSocketNvsNamespace = "fcplcn_sockets";

/** @brief Legacy socket blob key. New firmware stores the shared Controllers section. */
inline constexpr const char* kSocketNvsKey = "runtime";

/** @brief Historical FCSOCK01 binary version accepted by the decoder. */
inline constexpr std::uint16_t kSocketStorageVersion = 1;

/** @brief Current FCCTRL09 binary version with Security and a unique FRAM state identity. */
inline constexpr std::uint16_t kControllerStorageVersion = 9;

/** @brief Fixed minimum regular ON and OFF durations for all thermostats, in seconds. */
inline constexpr std::uint32_t kThermostatMinimumCycleSeconds = 60;

/** @brief Maximum total relay-owning rows across Sockets, Lights and Thermostats. */
inline constexpr std::size_t kSocketMaxItems = 16;

/** @brief Maximum Meteo rows; distinct DS18B20 ROMs may share one OneWire port. */
inline constexpr std::size_t kMeteoMaxItems = 16;

/** @brief Maximum ASCII bytes in an item ID. */
inline constexpr std::size_t kSocketMaxIdBytes = 32;

/** @brief Maximum UTF-8 bytes in a visible item name. */
inline constexpr std::size_t kSocketMaxNameBytes = 64;

/** @brief Controller operation result, independent of its HTTP/MQTT transport. */
enum class SocketResult {
    Ok,  ///< Operation confirmed, or an already-confirmed idempotent state.
    InvalidInput,  ///< Malformed data, unsupported operation or invalid profile port.
    Conflict,  ///< Stale revision/deadline, conflicting claim or pending restore.
    NotFound,  ///< Item, port or controller was not found.
    Disabled,  ///< A switch module is disabled; thermostat flags have a separate API.
    Unavailable,  ///< Required I/O, worker or safe-state confirmation is unavailable.
    StorageError  ///< Durable state could not be confirmed; success must not be acknowledged.
};

/** @brief Stable module indexes used by the shared engine and binary record. */
enum class ControllerKind : std::size_t {
    Sockets = 0,  ///< Persistent switched relay outputs.
    Lights = 1,  ///< Persistent lighting outputs with the same button semantics.
    Meteo = 2,  ///< Sensor selection and read-only cached measurements.
    Thermostats = 3,  ///< Autonomous heat/cool demand with durable per-item enable flags.
    Security = 4  ///< Autonomous intrusion alarm with iButton access and durable armed/alarm flags.
};

/** @brief Generic name for the legacy-compatible operation result type. */
using ControllerResult = SocketResult;

/**
 * @brief Explicitly arm or disarm the local security controller.
 * @param armed Requested durable armed state; disarming also clears its latched alarm.
 * @param[out] error Failure diagnostic.
 * @return Confirmed result, invalid configuration, unavailable I/O or persistence failure.
 */
ControllerResult controller_security_set_armed(bool armed, std::string& error);

/**
 * @brief Arm or disarm within a boot-relative delivery deadline.
 * @param armed Requested durable armed state.
 * @param expiresAtUptimeMs Absolute uptime deadline in milliseconds.
 * @param[out] error Failure diagnostic.
 * @return Confirmed result or command/configuration/I/O/storage error.
 */
ControllerResult
controller_security_set_armed_until(bool armed, std::int64_t expiresAtUptimeMs, std::string& error);

/**
 * @brief Apply an explicit hub permission using the exact current coordination lease.
 * @param armed Requested durable permission.
 * @param expiresAtUptimeMs Local monotonic delivery deadline in milliseconds.
 * @param fence Expected hub epoch, house revision and lease sequence.
 * @param[out] error Failure diagnostic.
 * @return Confirmation or stale-authority/configuration/I/O/storage refusal.
 */
ControllerResult controller_security_set_hub_armed_until(bool armed,
                                                         std::int64_t expiresAtUptimeMs,
                                                         const SecurityCommandFence& fence,
                                                         std::string& error);

/**
 * @brief Queue or inspect iButton discovery on an unclaimed profile sensor port.
 * @param portId Selected physical reader port, including a not-yet-saved binding.
 * @param refresh Request a new bounded discovery job.
 * @param[out] result Owned discovery JSON on success, or nullptr.
 * @param[out] error Failure diagnostic.
 * @return Confirmation or an armed/ownership/driver conflict.
 */
ControllerResult
controller_security_scan(std::string_view portId, bool refresh, cJSON*& result, std::string& error);

/**
 * @brief Load shared controller storage, register relay recovery policies and start one worker.
 * @return ESP_OK, a recovery-policy error or a worker-allocation error.
 * @details Requires initialized NVS, hardware services and an active board profile.
 * Missing/corrupt controller storage remains diagnostic and starts disabled; cold
 * boot never restores a thermostat ON demand. Call once before serving commands.
 */
esp_err_t controllers_init();

/**
 * @brief Copy one module's config, confirmed state and cached diagnostics under one lock.
 * @param kind Module to inspect.
 * @return Owned JSON snapshot, or nullptr for an invalid kind/allocation failure.
 */
cJSON* controller_status_json(ControllerKind kind);

/**
 * @brief Capture all module snapshots and the resource-owner catalog atomically.
 * @return Owned JSON object, or nullptr on allocation failure.
 * @details Disabled rows keep their claims. Sensors are shared only by distinct
 * OneWire ROMs on the same Meteo bus; legacy input conflicts remain visible.
 */
cJSON* controllers_status_json();

/**
 * @brief Validate and persist a revision-checked module configuration.
 * @param kind Module to edit.
 * @param request Borrowed JSON with baseRevision, enabled and items; never mutated.
 * @param[out] error Human-readable failure diagnostic.
 * @return Operation result; claims conflict before any GPIO or NVS mutation.
 * @details New thermostat rows start disabled. Existing IDs preserve the latest
 * confirmed enabled flag and RAM inhibit, so stale web drafts cannot overwrite a
 * button command. Thermostat relay/mode/source changes and removal require OFF;
 * failed storage saves retain settings and never roll output back to ON.
 */
ControllerResult controller_update(ControllerKind kind, const cJSON* request, std::string& error);

/**
 * @brief Set and persist a Sockets/Lights item; other kinds reject manual demand writes.
 * @param kind Sockets or Lights.
 * @param id Configured item ID.
 * @param on Logical target state.
 * @param[out] error Failure diagnostic.
 * @return Confirmation, disabled/not-found result, or I/O/storage error.
 */
ControllerResult
controller_set_state(ControllerKind kind, std::string_view id, bool on, std::string& error);

/**
 * @brief Execute a switch SET within an absolute delivery deadline.
 * @param kind Sockets or Lights.
 * @param id Configured item ID.
 * @param on Logical target state.
 * @param expiresAtUptimeMs Monotonic deadline in milliseconds, not a state lease.
 * @param[out] error Failure diagnostic.
 * @return Conflict on expiry; otherwise the normal switch SET result.
 * @details Checks expiry after lock waits, observations and immediately before
 * hardware actuation. An expired ON is never queued for a later recovery.
 */
ControllerResult controller_set_state_until(ControllerKind kind,
                                            std::string_view id,
                                            bool on,
                                            std::int64_t expiresAtUptimeMs,
                                            std::string& error);

/**
 * @brief Route a raw relay request through its owner while holding the ownership lock.
 * @param relayId Profile relay name.
 * @param on Logical target state.
 * @param[out] error Failure diagnostic.
 * @return Switch persistence result, Conflict for thermostat ownership, or driver result.
 * @details Thermostat-owned relays reject manual writes even when disabled.
 * Unowned manual outputs have RAM recovery intent but no durable controller state.
 */
ControllerResult controllers_set_relay(std::string_view relayId, bool on, std::string& error);

/**
 * @brief Confirm a thermostat's durable operative flag without writing its heat/cool demand.
 * @param id Configured thermostat ID.
 * @param enabled Permission for autonomous regulation; master OFF still prevents output ON.
 * @param[out] error Failure diagnostic.
 * @return Confirmation or I/O/storage failure; config revision is unchanged.
 * @details I/O/storage failure inhibits output OFF in RAM, retaining the last
 * confirmed flag. Only an explicit successful flag command clears that inhibit;
 * config editing and a held button cannot clear it. Input/sensor faults do not
 * constitute a manual relay override or an enabled-flag lease.
 */
ControllerResult
controller_thermostat_set_enabled(std::string_view id, bool enabled, std::string& error);

/**
 * @brief Change an operative flag only if accepted before a monotonic deadline.
 * @param id Configured thermostat ID.
 * @param enabled New durable operative flag.
 * @param expiresAtUptimeMs Delivery deadline in milliseconds; not a regulation lease.
 * @param[out] error Failure diagnostic.
 * @return Conflict on expiry, or the normal operative-flag command result.
 * @details A timely NVS operation may finish after the deadline. If expiry occurs
 * after a safety OFF but before storage acceptance, the flag stays unchanged and
 * RAM inhibit holds OFF. This API never directly energizes the relay.
 */
ControllerResult controller_thermostat_set_enabled_until(std::string_view id,
                                                         bool enabled,
                                                         std::int64_t expiresAtUptimeMs,
                                                         std::string& error);

/**
 * @brief Queue/poll a OneWire discovery without changing saved Meteo configuration.
 * @param portId Profile sensor-port name.
 * @param refresh Request a new scan instead of polling the cached job.
 * @param[out] snapshot Owned JSON result on success; nullptr on failure.
 * @param[out] error Failure diagnostic.
 * @param itemId Optional sole DHT22 owner allowed to probe OneWire before a type edit.
 * @param baseRevision Current Meteo config revision required for that DHT22-owner probe.
 * @return Confirmation, unknown port, ownership/revision conflict or driver failure.
 */
ControllerResult controller_meteo_scan(std::string_view portId,
                                       bool refresh,
                                       cJSON*& snapshot,
                                       std::string& error,
                                       std::string_view itemId = {},
                                       std::uint32_t baseRevision = 0);

/**
 * @brief Decode a durable controller record into full backup configuration.
 * @param record Borrowed opaque Controllers section, including supported legacy versions.
 * @param[out] error Failure diagnostic.
 * @return Owned module-config JSON, or nullptr on decoding/allocation failure.
 * @details Includes confirmed switch states and enabled flags, but no measurement,
 * automatic thermostat demand or RAM inhibit. Canonical board IDs are used.
 */
cJSON* controllers_backup_json(const SettingsBytes& record, std::string& error);

/**
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @return True on successful validation/encoding.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 */
bool controllers_backup_record(const cJSON* json,
                               std::uint32_t socketRevision,
                               std::uint32_t lightRevision,
                               SettingsBytes& record,
                               std::string& error);

/**
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param meteoRevision Target Meteo config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @return True on successful validation/encoding.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 */
bool controllers_backup_record(const cJSON* json,
                               std::uint32_t socketRevision,
                               std::uint32_t lightRevision,
                               std::uint32_t meteoRevision,
                               SettingsBytes& record,
                               std::string& error);

/**
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param meteoRevision Target Meteo config revision.
 * @param thermostatRevision Target Thermostats config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @param securityRevision Target Security configuration revision.
 * @return True on successful validation/encoding.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 */
bool controllers_backup_record(const cJSON* json,
                               std::uint32_t socketRevision,
                               std::uint32_t lightRevision,
                               std::uint32_t meteoRevision,
                               std::uint32_t thermostatRevision,
                               SettingsBytes& record,
                               std::string& error,
                               std::uint32_t securityRevision = 1);

/**
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @return Typed result distinguishing malformed data from resource conflicts.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 */
ControllerResult controllers_backup_prepare(const cJSON* json,
                                            std::uint32_t socketRevision,
                                            std::uint32_t lightRevision,
                                            SettingsBytes& record,
                                            std::string& error);

/**
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param meteoRevision Target Meteo config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @return Typed result distinguishing malformed data from resource conflicts.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 */
ControllerResult controllers_backup_prepare(const cJSON* json,
                                            std::uint32_t socketRevision,
                                            std::uint32_t lightRevision,
                                            std::uint32_t meteoRevision,
                                            SettingsBytes& record,
                                            std::string& error);

/**
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param meteoRevision Target Meteo config revision.
 * @param thermostatRevision Target Thermostats config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @param securityRevision Target Security configuration revision.
 * @return Typed result distinguishing malformed data from resource conflicts.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 */
ControllerResult controllers_backup_prepare(const cJSON* json,
                                            std::uint32_t socketRevision,
                                            std::uint32_t lightRevision,
                                            std::uint32_t meteoRevision,
                                            std::uint32_t thermostatRevision,
                                            SettingsBytes& record,
                                            std::string& error,
                                            std::uint32_t securityRevision = 1);

/**
 * @brief Decode module revisions without taking module locks, doing I/O or changing storage.
 * @param record Borrowed durable Controllers section.
 * @param[out] socketRevision Decoded Sockets config revision.
 * @param[out] lightRevision Decoded Lights config revision.
 * @param[out] error Failure diagnostic.
 * @return True for a valid record.
 * @details Missing modules in historical records have initial revision 1.
 */
bool controllers_record_revisions(const SettingsBytes& record,
                                  std::uint32_t& socketRevision,
                                  std::uint32_t& lightRevision,
                                  std::string& error);

/**
 * @brief Decode module revisions without taking module locks, doing I/O or changing storage.
 * @param record Borrowed durable Controllers section.
 * @param[out] socketRevision Decoded Sockets config revision.
 * @param[out] lightRevision Decoded Lights config revision.
 * @param[out] meteoRevision Decoded Meteo config revision.
 * @param[out] error Failure diagnostic.
 * @return True for a valid record.
 * @details Missing modules in historical records have initial revision 1.
 */
bool controllers_record_revisions(const SettingsBytes& record,
                                  std::uint32_t& socketRevision,
                                  std::uint32_t& lightRevision,
                                  std::uint32_t& meteoRevision,
                                  std::string& error);

/**
 * @brief Decode module revisions without taking module locks, doing I/O or changing storage.
 * @param record Borrowed durable Controllers section.
 * @param[out] socketRevision Decoded Sockets config revision.
 * @param[out] lightRevision Decoded Lights config revision.
 * @param[out] meteoRevision Decoded Meteo config revision.
 * @param[out] thermostatRevision Decoded Thermostats config revision.
 * @param[out] error Failure diagnostic.
 * @param[out] securityRevision Optional Security revision destination; nullptr skips it.
 * @return True for a valid record.
 * @details Missing modules in historical records have initial revision 1.
 */
bool controllers_record_revisions(const SettingsBytes& record,
                                  std::uint32_t& socketRevision,
                                  std::uint32_t& lightRevision,
                                  std::uint32_t& meteoRevision,
                                  std::uint32_t& thermostatRevision,
                                  std::string& error,
                                  std::uint32_t* securityRevision = nullptr);

/** @brief Compatibility initialization of the whole engine. @return controllers_init() result. */
esp_err_t socket_controller_init();

/** @brief Capture Sockets only. @return Owned JSON snapshot, or nullptr on allocation failure. */
cJSON* socket_controller_status_json();

/**
 * @brief Compatibility configuration update for Sockets.
 * @param request Borrowed revision-checked config JSON.
 * @param[out] error Failure diagnostic.
 * @return controller_update() result for Sockets.
 */
SocketResult socket_controller_update(const cJSON* request, std::string& error);

/**
 * @brief Compatibility durable Sockets SET.
 * @param id Configured socket ID.
 * @param on Logical target state.
 * @param[out] error Failure diagnostic.
 * @return controller_set_state() result for Sockets.
 */
SocketResult socket_controller_set_state(std::string_view id, bool on, std::string& error);

/**
 * @brief Compatibility Sockets SET with delivery expiry.
 * @param id Configured socket ID.
 * @param on Logical target state.
 * @param expiresAtUptimeMs Absolute monotonic delivery deadline in milliseconds.
 * @param[out] error Failure diagnostic.
 * @return controller_set_state_until() result for Sockets.
 */
SocketResult socket_controller_set_state_until(std::string_view id,
                                               bool on,
                                               std::int64_t expiresAtUptimeMs,
                                               std::string& error);

/**
 * @brief Compatibility raw-relay gateway; ownership is checked across all modules.
 * @param relayId Profile relay name.
 * @param on Logical target state.
 * @param[out] error Failure diagnostic.
 * @return controllers_set_relay() result.
 */
SocketResult socket_controller_set_relay(std::string_view relayId, bool on, std::string& error);

/**
 * @brief Extract only the Sockets backup section from any supported controller record.
 * @param record Borrowed durable record.
 * @param[out] error Failure diagnostic.
 * @return Owned Sockets config JSON, or nullptr on failure.
 */
cJSON* socket_backup_json(const SettingsBytes& record, std::string& error);

/**
 * @brief Encode legacy-style Sockets backup JSON with other modules disabled/empty.
 * @param json Borrowed Sockets config JSON.
 * @param revision Target Sockets config revision.
 * @param[out] record Encoded current-version Controllers section.
 * @param[out] error Failure diagnostic.
 * @return True on successful structural/resource validation and encoding.
 */
bool socket_backup_record(const cJSON* json,
                          std::uint32_t revision,
                          SettingsBytes& record,
                          std::string& error);

/**
 * @brief Decode only the Sockets revision without touching live state or storage.
 * @param record Borrowed controller record.
 * @param[out] revision Decoded revision.
 * @param[out] error Failure diagnostic.
 * @return True when the record is valid.
 */
bool socket_record_revision(const SettingsBytes& record,
                            std::uint32_t& revision,
                            std::string& error);

#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
/** @brief Run one ordinary worker iteration against host fakes. */
void socket_controller_test_step();

/** @brief Reset RAM for a simulated host reboot; fake tasks must be stopped and NVS is retained. */
void socket_controller_test_reset();
#endif
