/**
 * @file settings_store.h
 * @brief Atomic NVS bundle and a write gate shared by configuration, auth and controllers.
 * @details Lock order is write gate, module mutex, then store mutex. Restore closes the
 * gate and drains existing writers before generation CAS and a single bundle commit.
 */
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>
#include "esp_err.h"
/** @brief Stable binary section slots; Sockets is the legacy controllers-slot alias. */
enum class SettingsSection : std::size_t {
    Config = 0,  ///< Device settings and their configuration revision.
    Auth = 1,  ///< Salted authentication verifier and account name.
    Controllers = 2,  ///< Shared durable controller configurations and manual modes.
    Sockets = Controllers  ///< Historical alias for the same physical section slot.
};
/// Owned opaque section bytes; section codecs define their own versions and validation.
using SettingsBytes = std::vector<std::uint8_t>;

/** @brief Coherent, owned copy of all durable sections. */
struct SettingsSnapshot {
    std::uint64_t generation = 0;  ///< Store-wide CAS token; zero is not a durable generation.
    std::array<SettingsBytes, 3> sections;  ///< Config, authentication and controller records.
};

/// Optional storage preparation performed after restore writers drain and generation CAS passes.
using SettingsRestorePrepare = esp_err_t (*)(const SettingsSnapshot& replacement,
                                             const SettingsSnapshot& current);

inline constexpr const char* kSettingsNvsNamespace =
    "fcplcn_state";  ///< Authoritative NVS namespace.
inline constexpr const char* kSettingsNvsKey = "state";  ///< Whole-bundle blob key.
/// Fits two NVS blob data chunks in the existing 24 KiB partition.
inline constexpr std::size_t kSettingsMaxBlobBytes = 7936;

/** @brief Load the CRC-checked bundle or durably migrate legacy section keys.
 * @return ESP_OK or a storage/record error. Corruption never resurrects stale legacy keys.
 * @pre NVS is initialized; invoke before any module loads its settings.
 * @note Thread-safe and idempotent. Legacy keys are removed only after the bundle is durable.
 */
esp_err_t settings_store_init();

/** @brief Copy one section from a coherent store snapshot.
 * @param[in] section Stable section slot.
 * @param[out] bytes Owned section copy on success.
 * @return ESP_OK, NVS_NOT_FOUND for an empty section, or a storage/argument error.
 * @note Thread-safe; the caller validates the opaque section with its codec.
 */
esp_err_t settings_store_get(SettingsSection section, SettingsBytes& bytes);

/** @brief Atomically replace one nonempty section without changing the others.
 * @param[in] section Stable section slot.
 * @param[in] bytes Borrowed replacement bytes; copied into the next bundle.
 * @return ESP_OK or a size/storage/freeze/generation-exhaustion error; RAM changes only on commit.
 * @pre The caller holds a SettingsWriteGuard before its module mutex and this call.
 * @note Thread-safe; persistence increments the bundle generation, not module revisions.
 */
esp_err_t settings_store_set(SettingsSection section, const SettingsBytes& bytes);

/** @brief Copy the entire authoritative bundle under the store mutex.
 * @param[out] snapshot Independent section copies and their common generation.
 * @return ESP_OK or an initialization/storage error. Thread-safe.
 */
esp_err_t settings_store_snapshot(SettingsSnapshot& snapshot);

/** @brief Commit a full validated replacement and freeze further writes until reboot.
 * @param[in] replacement Borrowed replacement sections; its generation is ignored.
 * @param[in] expectedGeneration CAS token from the snapshot used for validation.
 * @param[in] prepare Optional preparation of another durable medium before the flash commit.
 * @return ESP_OK, INVALID_STATE on conflict/freeze, or a size/storage error.
 * @pre The caller validated all sections and holds no write guard or module mutex.
 * @note Thread-safe. Existing guarded writers drain before the store lock is acquired.
 */
esp_err_t settings_store_stage(const SettingsSnapshot& replacement,
                               std::uint64_t expectedGeneration,
                               SettingsRestorePrepare prepare = nullptr);

/** @brief Check whether a successful full restore is waiting for reboot.
 * @return True after durable staging. Thread-safe, lock-free observation.
 */
bool settings_restore_pending();

/**
 * @brief RAII permission for one settings/state mutation before acquiring module locks.
 * @details Construction waits only while restore staging drains active writers. A guard
 * obtained after successful staging is false. Destruction releases an accepted writer.
 * Do not hold a guard while calling settings_store_stage(), and do not acquire guards
 * recursively: an intervening staging operation could wait on the outer guard.
 */
class SettingsWriteGuard {
public:
    /** @brief Enter the mutation gate; inspect operator bool() before mutation. */
    SettingsWriteGuard();
    /** @brief Release an entered writer and wake a waiting restore when it was the last one. */
    ~SettingsWriteGuard();

    /** @brief Test whether this guard permits mutation.
     * @return True until destruction for an accepted guard; false after restore freeze.
     */
    explicit operator bool() const
    {
        return entered_;
    }

    /** @brief Guards cannot be copied.
     * @param[in] other Existing guard; copying its writer count is prohibited.
     */
    SettingsWriteGuard(const SettingsWriteGuard& other) = delete;
    /** @brief Guards cannot be assigned.
     * @param[in] other Existing guard; transferring its writer count is prohibited.
     * @return Not callable: assignment is deleted.
     */
    SettingsWriteGuard& operator=(const SettingsWriteGuard& other) = delete;

private:
    bool entered_ = false;  ///< Whether this guard contributes to the active-writer count.
};
#ifdef FCPLCN_SETTINGS_TESTING
/** @brief Reset store RAM and gate state, preserving fake NVS.
 * @pre Fake tasks and all concurrent store/guard calls have stopped.
 */
void settings_store_test_reset();
#endif
