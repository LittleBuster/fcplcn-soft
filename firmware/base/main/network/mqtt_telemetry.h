/**
 * @file mqtt_telemetry.h
 * @brief Bounded semantic change detection for retained local controller telemetry.
 */
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include "cJSON.h"

/** @brief Stable independent cache slots for the five controller status topics. */
enum class MqttTelemetryChannel : std::size_t {
    Sockets = 0,  ///< Socket states and bindings.
    Lights = 1,  ///< Light states and bindings.
    Meteo = 2,  ///< Measurements, original sample timestamps and validity.
    Thermostats = 3,  ///< Autonomous demand, confirmed outputs and faults.
    Security = 4  ///< Autonomous guard phase, zones and siren; credentials are redacted.
};

/** @brief Maximum copied controller payload; oversized JSON is never queued or remembered. */
inline constexpr std::size_t kMqttTelemetryMaxBytes = 32 * 1024;

/**
 * @brief Remove repeated OneWire discovery catalogs from an owned MQTT Meteo snapshot.
 * @param[in] channel Topic kind; other controller snapshots remain unchanged.
 * @param[in,out] snapshot Owned mutable status tree whose devices arrays become empty.
 * @note Selected ROM, measurement, validity and original sample time are preserved. The full
 * discovery catalog stays in HTTP/scan responses instead of being repeated up to 16 times.
 */
void mqtt_telemetry_compact(MqttTelemetryChannel channel, cJSON* snapshot);

/**
 * @brief Build a comparison key without continuously changing age/transport metadata.
 * @param[in] snapshot Borrowed complete controller status; never modified.
 * @param[out] key Owned compact comparison text on success; unchanged on failure.
 * @return True for a valid, bounded object; false on allocation/size/type failure.
 * @note Original sampledAtUptimeMs, values, availability and errors are retained, so a fresh
 * measurement or a safety transition is a change even when the numeric temperature is equal.
 */
bool mqtt_telemetry_key(const cJSON* snapshot, std::string& key);

/**
 * @brief Manager-owned publication cache; transport acceptance is explicitly separate from a try.
 * @note Call only from the network manager. It stores at most five bounded comparison strings.
 */
class MqttTelemetryCache {
public:
    /**
     * @brief Decide whether a topic changed or needs its periodic retained-state refresh.
     * @param[in] channel Status topic slot.
     * @param[in] key Valid comparison key created by mqtt_telemetry_key().
     * @param[in] nowMs Current monotonic uptime in milliseconds.
     * @return True initially, on a semantic change, clock rollback or after 30 seconds.
     */
    bool
    needs_publish(MqttTelemetryChannel channel, const std::string& key, std::int64_t nowMs) const;

    /**
     * @brief Remember a status only after the bounded transport outbox accepted it.
     * @param[in] channel Status topic slot.
     * @param[in] key Bounded comparison text transferred into the cache.
     * @param[in] nowMs Monotonic time of successful enqueue, not an acknowledgement of delivery.
     * @note Failed enqueues must not call this: the next polling step retries the current status.
     */
    void accepted(MqttTelemetryChannel channel, std::string key, std::int64_t nowMs);

    /** @brief Forget all accepted statuses after reconnect so every topic is republished. */
    void reset();

private:
    /** @brief Last locally accepted status; a negative time means this slot has never been sent. */
    struct Entry {
        std::string key;
        std::int64_t acceptedAtMs = -1;
    };

    std::array<Entry, 5> entries_;
};
