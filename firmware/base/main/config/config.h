/**
 * @file config.h
 * @brief Persisted device settings, optimistic updates and redacted snapshots.
 */
#pragma once
#include "config/model.h"
#include "cJSON.h"
#include "esp_err.h"
#include "config/settings_store.h"
/**
 * @brief Load settings and derive the immutable MAC-based device identifier.
 * @return ESP_OK, a MAC/storage error, or ESP_ERR_INVALID_ARG for an unknown saved board.
 * @pre NVS and settings_store_init() are initialized; call before hardware/network startup.
 * @note Serialized internally. Missing settings are saved; corrupt network settings use
 * recovery defaults while retaining a recognized board identity. No NVS erasure occurs.
 */
esp_err_t config_init();

/** @brief Copy the current settings, including secrets.
 * @return Independent value snapshot. Thread-safe; do not expose or log its secrets.
 */
DeviceConfig config_get();

/** @brief Build the redacted public configuration.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on allocation failure.
 * @note Thread-safe; passwordSet indicators replace password values.
 */
cJSON* config_public_json();

/**
 * @brief Persist a partial settings patch using its baseRevision.
 * @param[in] patch Borrowed JSON containing baseRevision and changed sections.
 * @param[out] error Failure diagnostic.
 * @param[out] network_changed True only when a successful change needs a deferred network apply.
 * @return ESP_OK, INVALID_ARG for validation, INVALID_STATE for CAS/freeze/exhaustion,
 * or a persistence/allocation error. Failure leaves RAM and durable settings unchanged.
 * @note Thread-safe; takes a SettingsWriteGuard before the configuration mutex.
 */
esp_err_t config_update(const cJSON* patch, std::string& error, bool& network_changed);

/** @brief Restore Wi-Fi/AP and Ethernet recovery defaults while preserving other settings.
 * @return ESP_OK or a freeze, exhausted-revision or storage error; no mutation on failure.
 * @note Thread-safe. The caller requests network apply after a successful save.
 */
esp_err_t config_reset_networks();

/** @brief Obtain the immutable hardware-derived identifier.
 * @return Borrowed reference with process lifetime after config_init().
 * @pre Initialization has completed and is not running concurrently.
 */
const std::string& device_id();

/** @brief Convert a stored device section to a complete backup, including secrets.
 * @param[in] record Borrowed serialized device section.
 * @param[out] error Failure diagnostic.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on invalid record/allocation failure.
 * @note Pure codec; no module locks or persistent mutation.
 */
cJSON* config_backup_json(const SettingsBytes& record, std::string& error);

/** @brief Validate and encode a complete device backup section.
 * @param[in] json Borrowed complete settings object; unknown/missing fields are rejected.
 * @param[in] revision Nonzero revision to assign to the encoded record.
 * @param[out] record Encoded bytes on success; caller retains ownership.
 * @param[out] error Failure diagnostic.
 * @return True on successful validation/encoding. Pure, thread-safe codec.
 */
bool config_backup_record(const cJSON* json,
                          std::uint32_t revision,
                          SettingsBytes& record,
                          std::string& error);

/** @brief Read the revision of a fully validated stored device section.
 * @param[in] record Borrowed serialized section.
 * @param[out] revision Decoded revision on success.
 * @param[out] error Failure diagnostic.
 * @return True on success; no locks or persistent mutation.
 */
bool config_record_revision(const SettingsBytes& record,
                            std::uint32_t& revision,
                            std::string& error);
