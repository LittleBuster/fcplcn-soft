/**
 * @file state_journal.h
 * @brief Power-loss-safe FRAM journal for frequently changing controller states.
 * @details Two slots preserve the previous committed record while a replacement is written.
 * The caller supplies an opaque configuration identity so states cannot cross configurations.
 */
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "esp_err.h"

/// Opaque identity of the durable controller configuration owning a state snapshot.
using StateJournalKey = std::array<std::uint8_t, 16>;
/// Owned, versioned state payload; its schema belongs to the controller service.
using StateJournalPayload = std::vector<std::uint8_t>;
/// Maximum opaque state bytes in each independently committed journal slot.
inline constexpr std::size_t kStateJournalMaxPayloadBytes = 128;
/// Fixed allocation of two journal slots; remaining FRAM capacity is unassigned.
inline constexpr std::size_t kStateJournalReservedBytes = 512;

/** @brief Diagnostics from the latest journal operation, without exposing its payload. */
struct StateJournalStatus {
    esp_err_t lastError = ESP_ERR_INVALID_STATE;  ///< Last load/save result.
    std::uint64_t generation = 0;  ///< Last successfully loaded or saved generation.
    bool valid = false;  ///< Whether the latest operation confirmed a matching record.
};

/**
 * @brief Load the newest complete FRAM snapshot belonging to one configuration.
 * @param[in] key Identity of the durable configuration whose states are requested.
 * @param[out] payload Replaced on success; unchanged for missing, corrupt or unreadable records.
 * @return ESP_OK, NOT_FOUND for blank/unrelated valid slots, INVALID_RESPONSE for corruption,
 * or a FRAM transport error.
 * @note Thread-safe. An intact matching slot survives corruption of the alternate slot.
 */
esp_err_t state_journal_load(const StateJournalKey& key, StateJournalPayload& payload);

/**
 * @brief Commit a verified state snapshot while preserving the prior authoritative slot.
 * @param[in] key Identity of the configuration owning the replacement payload.
 * @param[in] payload Nonempty opaque state bytes, bounded by kStateJournalMaxPayloadBytes.
 * @param[in] protectedKey Optional current durable configuration identity to preserve while
 * staging a different configuration before its flash commit; borrowed only during the call.
 * @return ESP_OK after payload and commit verification, or an argument, generation or I/O error.
 * @note Thread-safe. Failed commit verification is ambiguous: the caller must restore its prior
 * payload or retain a safe fault policy before acknowledging a failed state transaction.
 */
esp_err_t state_journal_save(const StateJournalKey& key,
                             const StateJournalPayload& payload,
                             const StateJournalKey* protectedKey = nullptr);

/**
 * @brief Copy the last journal operation's diagnostic snapshot.
 * @return Owned last-error, generation and validity values. Thread-safe and free of I2C traffic.
 */
StateJournalStatus state_journal_status();
