/**
 * @file security_sync.cpp
 * @brief Lease-fenced iButton coordination; offline contacts never become delayed house scenes.
 */
#include "controllers/security_sync.h"
#include "config/model.h"

#include <algorithm>
#include <cmath>
#include <deque>
#include <limits>
#include <memory>
#include <vector>

#include "cJSON.h"

namespace {
constexpr std::int64_t kMaximumLeaseMs = 5'000;
constexpr std::int64_t kTouchLifetimeMs = 1'500;
constexpr std::size_t kMaximumEvents = 4;
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

/** @brief One RAM-only authorized physical contact; raw iButton ROMs are intentionally absent. */
struct Touch {
    SecurityTouchPlan plan;
    std::uint32_t sequence = 0;
    std::int64_t atMs = 0;
    std::string keyId;
    std::string keyName;
    bool applied = false;
};

/** @brief Connection-scoped authority and a bounded nonpersistent physical event queue. */
struct Runtime {
    bool connected = false;
    bool haveLease = false;
    bool busy = false;
    bool touchArmed = false;
    std::string bootId;
    SecurityCommandFence lease;
    std::int64_t expires = 0;
    std::int64_t authoritySince = 0;
    std::uint32_t events = 0;
    std::deque<Touch> queue;
    std::vector<std::string> retiredEpochs;
};

std::mutex sync_mutex;
Runtime state;

/**
 * @brief Validate an ASCII identity shared with the Linux protocol.
 * @param value Candidate text.
 * @return True for a bounded protocol token without separators or control characters.
 */
bool identity(std::string_view value)
{
    return !value.empty() && value.size() <= 96
           && std::all_of(value.begin(), value.end(), [](unsigned char c) {
                  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                         || c == '_' || c == '-';
              });
}

/**
 * @brief Read a finite integral protocol number without lossy casts.
 * @param root Borrowed JSON object.
 * @param key Field name.
 * @param maximum Inclusive upper bound.
 * @param[out] result Parsed integer on success.
 * @return True for a nonnegative integral value within the bound.
 */
bool integer(const cJSON* root, const char* key, std::int64_t maximum, std::int64_t& result)
{
    const auto* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsNumber(value) || !std::isfinite(value->valuedouble)
        || std::floor(value->valuedouble) != value->valuedouble || value->valuedouble < 0
        || value->valuedouble > static_cast<double>(maximum))
        return false;
    result = static_cast<std::int64_t>(value->valuedouble);
    return true;
}

/**
 * @brief Observe authority freshness while sync_mutex is held.
 * @param nowMs Current monotonic uptime.
 * @return True for connected, nonexpired authority bound to this boot.
 */
bool fresh(std::int64_t nowMs)
{
    return state.connected && state.haveLease && !state.bootId.empty() && nowMs >= 0
           && nowMs < state.expires;
}

/**
 * @brief Discard expired queued contacts without replaying them after congestion.
 * @param nowMs Current monotonic uptime.
 * @pre Hold sync_mutex.
 */
void prune(std::int64_t nowMs)
{
    while (!state.queue.empty()) {
        const auto& event = state.queue.front();
        if (fresh(nowMs) && event.atMs <= nowMs && nowMs - event.atMs <= kTouchLifetimeMs
            && event.plan.expiresAtUptimeMs > nowMs
            && event.plan.fence.hubEpoch == state.lease.hubEpoch)
            break;
        state.queue.pop_front();
    }
}
}  // namespace

/** @brief Acquire the final lock in the settings/controller/synchronization lock order. */
SecuritySyncGuard::SecuritySyncGuard() : lock_(sync_mutex)
{
}

/**
 * @brief Copy one explicit physical-touch decision while authority is stable.
 * @param localArmed Current local durable permission.
 * @param nowMs Current monotonic uptime in milliseconds.
 * @param eventAtMs Driver-confirmed physical contact time.
 * @return Coordinated target, bounded busy refusal, or autonomous local inversion.
 */
SecurityTouchPlan
SecuritySyncGuard::plan(bool localArmed, std::int64_t nowMs, std::int64_t eventAtMs) const
{
    prune(nowMs);
    SecurityTouchPlan result;
    result.value = !localArmed;
    if (!fresh(nowMs) || eventAtMs < state.authoritySince)
        return result;
    result.coordinated = true;
    result.busy = state.busy || state.queue.size() >= kMaximumEvents
                  || state.events == std::numeric_limits<std::uint32_t>::max();
    result.value = state.touchArmed;
    result.expiresAtUptimeMs = state.expires;
    result.fence = state.lease;
    return result;
}

/**
 * @brief Enqueue one locally authorized contact after the controller's durable attempt.
 * @param plan Previously selected decision protected by this guard.
 * @param keyId Configured key identity.
 * @param keyName Configured display label.
 * @param eventAtMs Driver-confirmed contact time.
 * @param nowMs Current monotonic time after local persistence.
 * @param localApplied Whether the durable local attempt succeeded.
 * @return True for a fresh queued coordinated event; local-only attempts are not published.
 */
bool SecuritySyncGuard::record(const SecurityTouchPlan& plan,
                               std::string_view keyId,
                               std::string_view keyName,
                               std::int64_t eventAtMs,
                               std::int64_t nowMs,
                               bool localApplied)
{
    prune(nowMs);
    if (!plan.coordinated || plan.busy || !fresh(nowMs) || eventAtMs < 0 || eventAtMs > nowMs
        || nowMs - eventAtMs > kTouchLifetimeMs || plan.expiresAtUptimeMs <= nowMs
        || state.queue.size() >= kMaximumEvents
        || state.events == std::numeric_limits<std::uint32_t>::max() || keyId.size() > 32
        || keyName.size() > 96)
        return false;
    state.queue.push_back(Touch{
        plan, ++state.events, eventAtMs, std::string(keyId), std::string(keyName), localApplied});
    return true;
}

/**
 * @brief Check the exact current lease before a coordinated security mutation.
 * @param fence Supplied hub epoch/revision/sequence.
 * @param nowMs Current monotonic uptime.
 * @param[out] deadlineMs Expiry of the current lease.
 * @return True only when the command matches current fresh authority.
 */
bool SecuritySyncGuard::allows(const SecurityCommandFence& fence,
                               std::int64_t nowMs,
                               std::int64_t& deadlineMs) const
{
    if (!fresh(nowMs) || fence.hubEpoch != state.lease.hubEpoch
        || fence.modeRevision != state.lease.modeRevision
        || fence.leaseSequence != state.lease.leaseSequence)
        return false;
    deadlineMs = state.expires;
    return true;
}

/**
 * @brief Retain fresh contacts over pulse renewal without reviving contacts before reconnect.
 * @param fence Original contact authority.
 * @param eventAtMs Driver-confirmed physical contact time.
 * @param nowMs Current local monotonic uptime.
 * @return True for continuous authority and the unchanged house mode.
 */
bool SecuritySyncGuard::allows_event(const SecurityCommandFence& fence,
                                     std::int64_t eventAtMs,
                                     std::int64_t nowMs) const
{
    return fresh(nowMs) && eventAtMs >= state.authoritySince && eventAtMs <= nowMs
           && nowMs - eventAtMs <= kTouchLifetimeMs && fence.hubEpoch == state.lease.hubEpoch
           && fence.modeRevision == state.lease.modeRevision
           && fence.leaseSequence <= state.lease.leaseSequence;
}

/**
 * @brief Cancel authority and unsent contacts at every MQTT connection boundary.
 * @param connected Whether a newly established MQTT connection is live.
 * @param bootId Current PLC boot identity.
 */
void security_sync_connection(bool connected, std::string_view bootId)
{
    std::lock_guard<std::mutex> lock(sync_mutex);
    state.connected = connected;
    state.haveLease = false;
    state.busy = false;
    state.expires = 0;
    state.authoritySince = 0;
    state.bootId = std::string(bootId);
    state.queue.clear();
    state.retiredEpochs.clear();
    state.lease = {};
}

/**
 * @brief Decode and install one bounded nonretained hub authority pulse.
 * @param payload Borrowed complete JSON, at most 512 bytes.
 * @param retained Whether the broker marked this as retained.
 * @param bootId Current PLC boot identity.
 * @param nowMs Current monotonic uptime.
 * @return True if the pulse extends or replaces current authority safely.
 */
bool security_sync_receive(std::string_view payload,
                           bool retained,
                           std::string_view bootId,
                           std::int64_t nowMs)
{
    if (retained || payload.empty() || payload.size() > 512 || !supported_json_text(payload)
        || !identity(bootId) || nowMs < 0)
        return false;
    const std::string text(payload);
    Json root(cJSON_ParseWithLengthOpts(text.c_str(), text.size() + 1, nullptr, true),
              cJSON_Delete);
    if (!root || !cJSON_IsObject(root.get()))
        return false;
    const auto* boot = cJSON_GetObjectItemCaseSensitive(root.get(), "bootId");
    const auto* epoch = cJSON_GetObjectItemCaseSensitive(root.get(), "hubEpoch");
    const auto* touch = cJSON_GetObjectItemCaseSensitive(root.get(), "touchArmed");
    const auto* busy = cJSON_GetObjectItemCaseSensitive(root.get(), "busy");
    std::int64_t schema = 0, revision = 0, sequence = 0, expires = 0;
    if (!integer(root.get(), "schemaVersion", 1, schema) || schema != 1 || !cJSON_IsString(boot)
        || bootId != boot->valuestring || !cJSON_IsString(epoch) || !identity(epoch->valuestring)
        || !cJSON_IsBool(touch) || !cJSON_IsBool(busy)
        || !integer(root.get(), "modeRevision", UINT32_MAX, revision)
        || !integer(root.get(), "leaseSequence", UINT32_MAX, sequence) || sequence == 0
        || !integer(root.get(), "expiresAtUptimeMs", 9007199254740991LL, expires)
        || expires <= nowMs || expires - nowMs > kMaximumLeaseMs)
        return false;
    std::lock_guard<std::mutex> lock(sync_mutex);
    if (!state.connected || state.bootId != bootId)
        return false;
    const std::string nextEpoch(epoch->valuestring);
    if (std::find(state.retiredEpochs.begin(), state.retiredEpochs.end(), nextEpoch)
        != state.retiredEpochs.end())
        return false;
    if (state.haveLease && nextEpoch == state.lease.hubEpoch) {
        if (sequence <= state.lease.leaseSequence || revision < state.lease.modeRevision)
            return false;
    } else if (state.haveLease) {
        if (state.retiredEpochs.size() >= 16)
            state.retiredEpochs.erase(state.retiredEpochs.begin());
        state.retiredEpochs.push_back(state.lease.hubEpoch);
        state.queue.clear();
    }
    if (!state.haveLease || state.lease.hubEpoch != nextEpoch || state.expires <= nowMs)
        state.authoritySince = nowMs;
    state.haveLease = true;
    state.busy = cJSON_IsTrue(busy);
    state.touchArmed = cJSON_IsTrue(touch);
    state.lease = {
        nextEpoch, static_cast<std::uint32_t>(revision), static_cast<std::uint32_t>(sequence)};
    state.expires = expires;
    return true;
}

/**
 * @brief Pop one fresh event for exactly one outgoing attempt; no backlog survives reconnect.
 * @param nowMs Current monotonic uptime.
 * @return Owned event JSON, or nullptr; caller deletes the object.
 */
cJSON* security_sync_take_event(std::int64_t nowMs)
{
    std::lock_guard<std::mutex> lock(sync_mutex);
    prune(nowMs);
    if (state.queue.empty())
        return nullptr;
    const auto event = std::move(state.queue.front());
    state.queue.pop_front();
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddNumberToObject(root.get(), "schemaVersion", 1)
        || !cJSON_AddStringToObject(root.get(), "bootId", state.bootId.c_str())
        || !cJSON_AddStringToObject(root.get(), "hubEpoch", event.plan.fence.hubEpoch.c_str())
        || !cJSON_AddNumberToObject(root.get(), "modeRevision", event.plan.fence.modeRevision)
        || !cJSON_AddNumberToObject(root.get(), "leaseSequence", event.plan.fence.leaseSequence)
        || !cJSON_AddNumberToObject(root.get(), "eventSequence", event.sequence)
        || !cJSON_AddNumberToObject(root.get(), "eventAtUptimeMs", static_cast<double>(event.atMs))
        || !cJSON_AddBoolToObject(root.get(), "value", event.plan.value)
        || !cJSON_AddStringToObject(root.get(), "keyId", event.keyId.c_str())
        || !cJSON_AddStringToObject(root.get(), "keyName", event.keyName.c_str())
        || !cJSON_AddBoolToObject(root.get(), "localApplied", event.applied))
        return nullptr;
    return root.release();
}

/**
 * @brief Report whether the next authorized touch is coordinated or autonomous.
 * @param nowMs Current monotonic uptime.
 * @return Owned diagnostic JSON, or nullptr.
 */
cJSON* security_sync_status(std::int64_t nowMs)
{
    std::lock_guard<std::mutex> lock(sync_mutex);
    Json root(cJSON_CreateObject(), cJSON_Delete);
    const bool active = fresh(nowMs);
    if (!root || !cJSON_AddNumberToObject(root.get(), "version", 1)
        || !cJSON_AddBoolToObject(root.get(), "connected", active)
        || !cJSON_AddBoolToObject(root.get(), "busy", active && state.busy)
        || !cJSON_AddNumberToObject(
            root.get(), "modeRevision", active ? state.lease.modeRevision : 0)
        || !cJSON_AddNumberToObject(root.get(), "queuedEvents", state.queue.size()))
        return nullptr;
    return root.release();
}

#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
/** @brief Erase volatile synchronization state at a host-test boot boundary. */
void security_sync_test_reset()
{
    std::lock_guard<std::mutex> lock(sync_mutex);
    state = Runtime{};
}
#endif
