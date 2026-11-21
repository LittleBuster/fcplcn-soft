/**
 * @file security_sync.h
 * @brief Fresh local-hub authority and bounded physical iButton events for FCPLCn.
 * @details No desired house mode is restored on the PLC from a stale network message.
 * Local alarm control remains autonomous when the short hub authority expires.
 */
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <string_view>

struct cJSON;

/** @brief Exact lease identity required by one coordinated explicit security SET. */
struct SecurityCommandFence {
    std::string hubEpoch;
    std::uint32_t modeRevision = 0;
    std::uint32_t leaseSequence = 0;
};

/** @brief Decision copied while the synchronization guard excludes a changing hub lease. */
struct SecurityTouchPlan {
    bool coordinated = false;
    bool busy = false;
    bool value = false;
    std::int64_t expiresAtUptimeMs = 0;
    SecurityCommandFence fence;
};

/**
 * @brief Serialize the short lease with a controller mutation, never the network lifecycle.
 * @note Lock order is SettingsWriteGuard, controller mutex, then this guard. Network lease
 * callbacks take only this guard and never call the controller engine.
 */
class SecuritySyncGuard {
public:
    /** @brief Acquire the in-memory hub authority mutex for this scope. */
    SecuritySyncGuard();

    /**
     * @brief Select the next physical touch target without performing I/O.
     * @param localArmed Current durable permission, used only without fresh hub authority.
     * @param nowMs Current monotonic uptime in milliseconds.
     * @param eventAtMs Physical contact time; contacts predating authority remain local-only.
     * @return Explicit target or a busy refusal; holding a key never creates another event.
     */
    SecurityTouchPlan plan(bool localArmed, std::int64_t nowMs, std::int64_t eventAtMs) const;

    /**
     * @brief Record exactly one already-authorized physical touch for bounded network dispatch.
     * @param plan The decision held unchanged by this guard during local persistence.
     * @param keyId Locally configured permission identity, never the physical ROM.
     * @param keyName Human-readable configured key name.
     * @param eventAtMs Monotonic time of the distinct physical contact.
     * @param nowMs Current monotonic time after the local attempt.
     * @param localApplied Whether the local durable permission was confirmed.
     * @return True if the coordinated event was queued; false for local-only/stale decisions.
     */
    bool record(const SecurityTouchPlan& plan,
                std::string_view keyId,
                std::string_view keyName,
                std::int64_t eventAtMs,
                std::int64_t nowMs,
                bool localApplied);

    /**
     * @brief Validate a coordinated SET under the controller mutation lock.
     * @param fence Exact epoch, house revision and issued lease sequence.
     * @param nowMs Current monotonic uptime.
     * @param[out] deadlineMs Authority expiry used to shorten the command deadline.
     * @return True only for current fresh authority; an old lease never authorizes a new write.
     */
    bool
    allows(const SecurityCommandFence& fence, std::int64_t nowMs, std::int64_t& deadlineMs) const;

    /**
     * @brief Recheck a queued touch across pulses, never across an authority gap or mode change.
     * @param fence Lease that authorized the physical contact.
     * @param eventAtMs Physical contact time in local monotonic milliseconds.
     * @param nowMs Current local monotonic uptime.
     * @return True while the contact belongs to the same continuous current authority.
     */
    bool allows_event(const SecurityCommandFence& fence,
                      std::int64_t eventAtMs,
                      std::int64_t nowMs) const;

private:
    std::unique_lock<std::mutex> lock_;
};

/**
 * @brief Replace transport availability and discard all volatile leases and unsent touches.
 * @param connected Whether this MQTT connection is live.
 * @param bootId Current PLC boot identity; empty only in a host test reset.
 */
void security_sync_connection(bool connected, std::string_view bootId);

/**
 * @brief Accept one complete, nonretained and boot-bound hub authority pulse.
 * @param payload JSON of at most 512 bytes.
 * @param retained Broker RETAIN flag; retained authority is always refused.
 * @param bootId Current local boot identity.
 * @param nowMs Current local monotonic uptime.
 * @return True only when the bounded authority was installed.
 */
bool security_sync_receive(std::string_view payload,
                           bool retained,
                           std::string_view bootId,
                           std::int64_t nowMs);

/**
 * @brief Remove one fresh physical touch for immediate asynchronous MQTT submission.
 * @param nowMs Current monotonic uptime.
 * @return Owned JSON, or nullptr; delete with cJSON_Delete. Popped events are never retried.
 */
cJSON* security_sync_take_event(std::int64_t nowMs);

/**
 * @brief Copy non-secret local/global authority diagnostics for the security status page.
 * @param nowMs Current monotonic uptime.
 * @return Owned JSON for cJSON_Delete, or nullptr on allocation failure.
 */
cJSON* security_sync_status(std::int64_t nowMs);

#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
/** @brief Erase synchronization RAM for a simulated host reboot, including event counters. */
void security_sync_test_reset();
#endif
