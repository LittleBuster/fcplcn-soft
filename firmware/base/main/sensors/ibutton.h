/**
 * @file ibutton.h
 * @brief Asynchronous DS1990A iButton identification on an isolated sensor port.
 * @details ROMs use wire order: family 01, six serial bytes, then Dallas CRC-8.
 * The shared acquisition worker owns all OneWire I/O and never calls controllers.
 */
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "esp_err.h"

/** @brief Current reader observation and the most recent complete physical-touch event. */
struct IbuttonReading {
    bool available = false;  ///< The latest poll succeeded and is at most 1500 ms old.
    bool present = false;  ///< At least one OneWire device answered, even an unsupported family.
    std::vector<std::string> addresses;  ///< Sorted family-01, CRC-valid wire-order ROMs.
    std::int64_t updatedAtMs = -1;  ///< Monotonic time of the last completed poll.
    std::uint64_t generation = 0;  ///< Reader-binding epoch; changes cancel in-flight jobs.
    std::uint64_t eventSequence = 0;  ///< Monotonic physical-touch sequence; zero before any event.
    std::string eventAddress;  ///< Exactly one CRC-valid key producing the latest touch event.
    std::int64_t eventAtMs = -1;  ///< Monotonic acquisition time of that event.
    std::string error;  ///< Reader/port/freshness diagnostic.
};

/** @brief One asynchronous discovery job, separate from arm/disarm touch events. */
struct IbuttonScanSnapshot {
    bool busy = false;  ///< Discovery is queued or executing.
    bool complete = false;  ///< The last attempt finished, possibly with an error.
    std::vector<std::string> addresses;  ///< Last discovered CRC-valid family-01 ROMs.
    std::int64_t updatedAtMs = -1;  ///< Monotonic completion time; -1 before discovery.
    std::string error;  ///< Search, transport or device-limit diagnostic.
};

/**
 * @brief Start the shared sensor acquisition worker, idempotently.
 * @return ESP_OK or the shared acquisition worker initialization error.
 * @pre Activate the board profile before initializing physical sensor services.
 */
esp_err_t ibutton_init();

/**
 * @brief Replace the autonomous reader binding without performing bus I/O.
 * @param[in] portId Profile sensor port; an empty value disables autonomous reading.
 * @return ESP_OK, unknown-port error or acquisition initialization error.
 * @note The controller enforces exclusive ownership against Meteo and other users.
 * A changed binding requires two healthy empty polls before recognizing a touch.
 */
esp_err_t ibutton_configure(std::string_view portId);

/**
 * @brief Copy reader health and the last event without performing bus I/O.
 * @return Owned snapshot; stale/disabled data is unavailable and cannot authorize a key.
 */
IbuttonReading ibutton_read();

/**
 * @brief Queue or poll an asynchronous ROM search without generating a touch event.
 * @param[in] portId Profile sensor port whose access has been authorized by the controller.
 * @param[in] refresh Request another attempt, limited to once per two seconds per port.
 * @param[out] snapshot Last queued/running/completed attempt and retained addresses.
 * @return ESP_OK, unknown-port error or acquisition initialization error.
 */
esp_err_t
ibutton_request_scan(std::string_view portId, bool refresh, IbuttonScanSnapshot& snapshot);

/**
 * @brief Validate a DS1990A-compatible serial-number iButton ROM.
 * @param[in] text Sixteen hexadecimal wire-order characters; uppercase is accepted.
 * @param[out] bytes Wire-order bytes, assigned only for family 01 and a correct CRC.
 * @return True for a supported complete ROM, false for malformed/family/CRC errors.
 */
bool ibutton_parse_address(std::string_view text, std::array<std::uint8_t, 8>& bytes);

/**
 * @brief Execute one due reader poll or queued discovery from the shared worker.
 * @return True when a bounded job ran, false when no iButton work is due.
 * @pre Only the shared acquisition worker, including its DS conversion wait, calls this function.
 * @note Never call while another transient OneWire bus remains allocated.
 */
bool ibutton_worker_step();

/**
 * @brief Cancel queued searches and invalidate results from in-flight discovery.
 * @note Call after physical sensor ownership changes, without holding the Meteo cache mutex.
 * Active reader polling and already published touch events are not changed.
 */
void ibutton_cancel_scans();

/**
 * @brief Suppress a held or partly read key until a new confirmed physical release.
 * @note Cache-only barrier for enrollment and explicit arm/disarm commands. Advances the
 * reader generation, discards in-flight observations, and retains physical health diagnostics.
 */
void ibutton_require_release();
