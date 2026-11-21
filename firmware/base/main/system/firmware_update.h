/**
 * @file firmware_update.h
 * @brief Authenticated, bounded application OTA shared by local HTTP and the private hub channel.
 */
#pragma once
#include <cstddef>
#include <string_view>
#include "cJSON.h"

inline constexpr std::size_t kFirmwareChunkBytes = 12 * 1024;  ///< Maximum decoded upload chunk.
inline constexpr std::size_t kFirmwareRequestBytes = 18 * 1024;  ///< JSON request allocation bound.

/** @brief Owned OTA response; its caller releases data with cJSON_Delete(). */
struct FirmwareUpdateResult {
    int status = 200;  ///< HTTP-compatible status code.
    cJSON* data = nullptr;  ///< Transferred JSON result or error object.
    bool reboot = false;  ///< A reserved reboot worker must be notified after sending the reply.
};

/** @brief Handle an exact /firmware service route, sharing one inactive-slot upload session.
 * @param[in] method Exact GET or POST.
 * @param[in] path Relative route without /api/v1.
 * @param[in] body Borrowed JSON body for mutations.
 * @param[in] reserveReboot Optional nonactuating reboot-worker reservation, required by finish.
 * @return Owned bounded response; successful finish requests a deferred reboot.
 * @note Requires caller authentication. Never writes configuration, FRAM, the active app or
 * bootloader.
 */
FirmwareUpdateResult firmware_update_request(std::string_view method,
                                             std::string_view path,
                                             const cJSON* body,
                                             bool (*reserveReboot)() = nullptr);

/** @brief Check whether a received or verified update prevents settings/restart changes.
 * @return True during receive and after boot selection until restart.
 */
bool firmware_update_busy();

/** @brief Reserve reboot/restore before its commit, excluding simultaneous OTA begin.
 * @return False during receive or another pending restart; otherwise closes the upload gate.
 */
bool firmware_update_prepare_restart();

/** @brief Release a failed reboot/restore reservation; a verified image remains reserved. */
void firmware_update_cancel_restart();

/** @brief Abort a 60-second abandoned upload without blocking the autonomous main supervisor.
 * @note Call from the independent main loop; try-lock returns immediately during an active chunk.
 */
void firmware_update_poll();

#ifdef FCPLCN_FIRMWARE_UPDATE_TESTING
/** @brief Reset volatile OTA state between isolated host tests; never available in production. */
void firmware_update_test_reset();
#endif
