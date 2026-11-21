/**
 * @file mqtt_telemetry.cpp
 * @brief Semantic controller telemetry comparison independent of ESP-IDF transport calls.
 */
#include "network/mqtt_telemetry.h"

#include <cstring>
#include <memory>
#include <utility>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
constexpr std::int64_t kRefreshMs = 30'000;

/**
 * @brief Remove age and transport-only fields from an owned comparison tree.
 * @param[in,out] value Owned copied JSON node; descendants may be removed recursively.
 * @note Sample timestamps and every safety/measurement field remain part of the comparison.
 */
void remove_volatile(cJSON* value)
{
    for (auto* child = value->child; child != nullptr;) {
        auto* next = child->next;
        const char* key = child->string;
        if (cJSON_IsObject(value) && key != nullptr
            && (std::strcmp(key, "ageMs") == 0 || std::strcmp(key, "uptimeMs") == 0
                || std::strcmp(key, "bootId") == 0 || std::strcmp(key, "holdRemainingSeconds") == 0
                || std::strcmp(key, "remainingSeconds") == 0
                || std::strcmp(key, "enrollmentRemainingSeconds") == 0
                || std::strcmp(key, "updatedAtUptimeMs") == 0)) {
            cJSON_Delete(cJSON_DetachItemViaPointer(value, child));
        } else {
            remove_volatile(child);
        }
        child = next;
    }
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Remove repeated OneWire discovery catalogs from an owned MQTT Meteo snapshot.
 * @param[in] channel Topic kind; other controller snapshots remain unchanged.
 * @param[in,out] snapshot Owned mutable status tree whose devices arrays become empty.
 * @note Selected ROM, measurement, validity and original sample time are preserved. The full
 * discovery catalog stays in HTTP/scan responses instead of being repeated up to 16 times.
 * @endcond
 */
void mqtt_telemetry_compact(MqttTelemetryChannel channel, cJSON* snapshot)
{
    if (channel == MqttTelemetryChannel::Security) {
        const auto* keys = cJSON_GetObjectItemCaseSensitive(snapshot, "keys");
        if (cJSON_IsArray(keys))
            cJSON_AddNumberToObject(snapshot, "keyCount", cJSON_GetArraySize(keys));
        cJSON_DeleteItemFromObjectCaseSensitive(snapshot, "keys");
        return;
    }
    if (channel != MqttTelemetryChannel::Meteo)
        return;
    auto* items = cJSON_GetObjectItemCaseSensitive(snapshot, "items");
    for (auto* item = items != nullptr ? items->child : nullptr; item != nullptr;
         item = item->next) {
        auto* devices = cJSON_GetObjectItemCaseSensitive(item, "devices");
        while (cJSON_IsArray(devices) && devices->child != nullptr)
            cJSON_Delete(cJSON_DetachItemViaPointer(devices, devices->child));
    }
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Build a comparison key without continuously changing age/transport metadata.
 * @param[in] snapshot Borrowed complete controller status; never modified.
 * @param[out] key Owned compact comparison text on success; unchanged on failure.
 * @return True for a valid, bounded object; false on allocation/size/type failure.
 * @note Original sampledAtUptimeMs, values, availability and errors are retained, so a fresh
 * measurement or a safety transition is a change even when the numeric temperature is equal.
 * @endcond
 */
bool mqtt_telemetry_key(const cJSON* snapshot, std::string& key)
{
    if (!cJSON_IsObject(snapshot))
        return false;
    Json copy(cJSON_Duplicate(snapshot, true), cJSON_Delete);
    if (!copy)
        return false;
    remove_volatile(copy.get());
    char* encoded = cJSON_PrintUnformatted(copy.get());
    if (encoded == nullptr)
        return false;
    const auto size = std::strlen(encoded);
    if (size <= kMqttTelemetryMaxBytes)
        key.assign(encoded, size);
    cJSON_free(encoded);
    return size <= kMqttTelemetryMaxBytes;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decide whether a topic changed or needs its periodic retained-state refresh.
 * @param[in] channel Status topic slot.
 * @param[in] key Valid comparison key created by mqtt_telemetry_key().
 * @param[in] nowMs Current monotonic uptime in milliseconds.
 * @return True initially, on a semantic change, clock rollback or after 30 seconds.
 * @endcond
 */
bool MqttTelemetryCache::needs_publish(MqttTelemetryChannel channel,
                                       const std::string& key,
                                       std::int64_t nowMs) const
{
    const auto slot = static_cast<std::size_t>(channel);
    if (slot >= entries_.size() || key.size() > kMqttTelemetryMaxBytes || nowMs < 0)
        return false;
    const auto& entry = entries_[slot];
    return entry.acceptedAtMs < 0 || nowMs < entry.acceptedAtMs || key != entry.key
           || nowMs - entry.acceptedAtMs >= kRefreshMs;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Remember a status only after the bounded transport outbox accepted it.
 * @param[in] channel Status topic slot.
 * @param[in] key Bounded comparison text transferred into the cache.
 * @param[in] nowMs Monotonic time of successful enqueue, not an acknowledgement of delivery.
 * @note Failed enqueues must not call this: the next polling step retries the current status.
 * @endcond
 */
void MqttTelemetryCache::accepted(MqttTelemetryChannel channel, std::string key, std::int64_t nowMs)
{
    const auto slot = static_cast<std::size_t>(channel);
    if (slot >= entries_.size() || key.size() > kMqttTelemetryMaxBytes || nowMs < 0)
        return;
    entries_[slot].key = std::move(key);
    entries_[slot].acceptedAtMs = nowMs;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Forget all accepted statuses after reconnect so every topic is republished.
 * @endcond
 */
void MqttTelemetryCache::reset()
{
    for (auto& entry : entries_) {
        entry.key.clear();
        entry.acceptedAtMs = -1;
    }
}
