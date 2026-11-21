/**
 * @file backup.h
 * @brief Complete, versioned configuration export and atomic restore staging.
 * @details Documents contain network secrets and an authentication verifier.
 * Callers enforce authentication and must not log or publish their contents.
 */
#pragma once
#include <cstddef>
#include <string>
struct cJSON;
/// Maximum supported serialized backup document size, in bytes.
inline constexpr std::size_t kBackupMaxDocumentBytes = 32768;
/// HTTP restore envelope allowance in addition to the document limit.
inline constexpr std::size_t kBackupMaxRequestBytes = kBackupMaxDocumentBytes + 128;

/** @brief Restore outcome used by the HTTP layer to select a response status. */
enum class BackupResult {
    Ok,  ///< All replacement sections committed; reboot is now required.
    InvalidInput,  ///< Schema, values, resource ownership or storage size is invalid.
    Conflict,  ///< Active board, configuration revision or store generation differs.
    StorageError  ///< The complete durable replacement could not be prepared or committed.
};

/**
 * @brief Export one coherent snapshot with secrets and a password verifier.
 * @param[out] error Diagnostic on failure; cleared on success.
 * @return Caller-owned JSON, to be freed with cJSON_Delete(), or nullptr.
 * @pre Configuration, authentication, controllers and the active board are initialized.
 * @note Thread-safe; reads the atomic store rather than unsaved UI or runtime drafts.
 */
cJSON* backup_export_json(std::string& error);

/**
 * @brief Validate and durably stage a complete replacement without activating it.
 * @param[in] request Borrowed JSON object containing baseRevision and document.
 * @param[out] error Diagnostic on failure; cleared on success.
 * @return Restore outcome. Success freezes subsequent settings mutations until reboot.
 * @pre The caller authenticates the request, enforces its size and reserves a reboot worker.
 * @note Thread-safe. Do not call while holding a SettingsWriteGuard or a module lock.
 * @details All codecs and board checks run before the single store commit. Existing
 * guards drain before staging; generation CAS rejects intervening configuration changes.
 * The caller schedules reboot only after success; this function does not restart hardware.
 */
BackupResult backup_stage_restore(const cJSON* request, std::string& error);
