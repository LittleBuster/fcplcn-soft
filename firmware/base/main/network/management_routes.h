/** @file management_routes.h @brief Trusted-hub allowlist sharing local service business APIs. */
#pragma once
#include "network/management_mqtt.h"

/** @brief Non-actuating reservation required before accepting a reboot or full restore. */
struct ManagementRouteHooks {
    bool (*reserveReboot)() = nullptr;  ///< Reserve an idle worker; never reboot synchronously.
};

/** @brief Route an authenticated private-broker request to existing device services.
 * @param[in] request Protocol-validated request with borrowed body and active deadline context.
 * @param[in] hooks Reboot-worker reservation; never performs reboot during dispatch.
 * @return Owned JSON result plus deferred service actions after the private response send attempt.
 * @note Trust comes from broker ACLs and the hub's administrator session, never a public topic.
 */
ManagementRouteResult management_dispatch(const ManagementRequest& request,
                                          const ManagementRouteHooks& hooks);
