/**
 * @file telemetry_test.cpp
 * @brief Verify publication changes, measurement freshness and failed-enqueue recovery.
 */
#include "network/mqtt_telemetry.h"
#include "platform/checksum.h"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
constexpr auto kChannel = MqttTelemetryChannel::Meteo;

/** @brief Stop a native scenario when its observable requirement fails. */
void require(bool value, const char* message)
{
    if (!value) {
        std::fprintf(stderr, "%s\n", message);
        std::exit(1);
    }
}

/** @brief Parse one owned JSON fixture. */
Json json(const char* text)
{
    Json result(cJSON_Parse(text), cJSON_Delete);
    require(result != nullptr, "invalid test JSON");
    return result;
}

/** @brief Build a semantic key from a valid fixture without changing it. */
std::string key(const cJSON* value)
{
    std::string result;
    require(mqtt_telemetry_key(value, result), "cannot create comparison key");
    return result;
}

/** @brief Retrieve the first meteo item from a fixture. */
cJSON* item(cJSON* value)
{
    return cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(value, "items"), 0);
}

/** @brief Create a fresh sample whose original successful timestamp remains explicit. */
Json sample()
{
    return json(
        R"({"items":[{"temperatureC":21,"available":true,"ageMs":100,"sampledAtUptimeMs":1000,"devices":[{"ageMs":100,"sampledAtUptimeMs":1000}]}],"uptimeMs":1100,"bootId":"a"})");
}

/** @brief Produce a distinct CRC-valid DS18B20 ROM for a shared-bus fixture. */
std::string address(unsigned serial)
{
    std::array<std::uint8_t, 8> bytes{
        {0x28, static_cast<std::uint8_t>(serial + 1), 0, 0, 0, 0, 0, 0}};
    bytes[7] = fcplcn::util::crc8_dallas(bytes.data(), 7);
    char result[17]{};
    for (std::size_t i = 0; i < bytes.size(); ++i)
        std::snprintf(result + i * 2, 3, "%02x", bytes[i]);
    return result;
}
}  // namespace

/** @brief Run one independently initialized telemetry behavior scenario. */
int main(int argc, char** argv)
{
    require(argc == 2, "expected scenario name");
    const std::string name = argv[1];
    MqttTelemetryCache cache;
    auto value = sample();
    const auto original = key(value.get());
    if (name == "ages") {
        cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(item(value.get()), "ageMs"), 900);
        cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(value.get(), "uptimeMs"), 1900);
        cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(value.get(), "bootId"), "b");
        auto* device =
            cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(item(value.get()), "devices"), 0);
        cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(device, "ageMs"), 900);
        require(original == key(value.get()),
                "elapsed age or transport metadata caused a status flood");
        require(cJSON_GetObjectItemCaseSensitive(item(value.get()), "ageMs")->valueint == 900,
                "comparison modified the transmitted snapshot");
    } else if (name == "fresh_sample") {
        cache.accepted(kChannel, original, 1100);
        cJSON_SetNumberValue(
            cJSON_GetObjectItemCaseSensitive(item(value.get()), "sampledAtUptimeMs"), 6000);
        require(cache.needs_publish(kChannel, key(value.get()), 6100),
                "an equal-valued new measurement must renew the hub freshness timestamp");
    } else if (name == "faults") {
        cache.accepted(kChannel, original, 1100);
        cJSON_ReplaceItemInObjectCaseSensitive(item(value.get()), "available", cJSON_CreateFalse());
        cJSON_AddStringToObject(item(value.get()), "error", "stale");
        require(cache.needs_publish(kChannel, key(value.get()), 1200),
                "safety transition was suppressed");
        cache.accepted(kChannel, key(value.get()), 1200);
        cJSON_ReplaceItemInObjectCaseSensitive(item(value.get()), "available", cJSON_CreateTrue());
        cJSON_DeleteItemFromObjectCaseSensitive(item(value.get()), "error");
        require(cache.needs_publish(kChannel, key(value.get()), 1300),
                "sensor recovery was suppressed");
    } else if (name == "retry_reconnect") {
        for (std::size_t i = 0; i < kMqttTelemetryChannelCount; ++i) {
            const auto slot = static_cast<MqttTelemetryChannel>(i);
            require(cache.needs_publish(slot, original, 1100), "initial state missing");
            // A failed outbox enqueue must leave this state eligible for the next polling step.
            require(cache.needs_publish(slot, original, 1200), "failed enqueue was remembered");
            cache.accepted(slot, original, 1200);
            require(!cache.needs_publish(slot, original, 1300), "unchanged state was resent");
        }
        cache.reset();
        for (std::size_t i = 0; i < kMqttTelemetryChannelCount; ++i)
            require(cache.needs_publish(static_cast<MqttTelemetryChannel>(i), original, 1400),
                    "reconnect did not republish every status topic");
    } else if (name == "refresh") {
        cache.accepted(kChannel, original, 1000);
        require(!cache.needs_publish(kChannel, original, 30'999), "refresh was early");
        require(cache.needs_publish(kChannel, original, 31'000),
                "retained state was never refreshed");
        require(cache.needs_publish(kChannel, original, 999), "monotonic restart did not refresh");
    } else if (name == "bounds") {
        std::string unchanged = "sentinel";
        auto invalid = json("[]");
        require(!mqtt_telemetry_key(nullptr, unchanged)
                    && !mqtt_telemetry_key(invalid.get(), unchanged) && unchanged == "sentinel",
                "invalid snapshots changed the caller key");
        const std::string large(kMqttTelemetryMaxBytes + 1, 'x');
        cJSON_AddStringToObject(value.get(), "oversized", large.c_str());
        require(!mqtt_telemetry_key(value.get(), unchanged) && unchanged == "sentinel",
                "oversized key accepted");
        require(!cache.needs_publish(static_cast<MqttTelemetryChannel>(9), original, 0),
                "invalid channel accepted");
        cache.accepted(kChannel, large, 0);
        require(cache.needs_publish(kChannel, original, 1), "oversized state polluted the cache");
        cache.accepted(kChannel, original, -1);
        require(cache.needs_publish(kChannel, original, 1), "invalid time polluted the cache");
    } else if (name == "dwell") {
        auto held = json(
            R"({"items":[{"state":false,"holdReason":"minimum_off","holdRemainingSeconds":180}]})");
        const auto held_key = key(held.get());
        cache.accepted(MqttTelemetryChannel::Thermostats, held_key, 1000);
        cJSON_SetNumberValue(
            cJSON_GetObjectItemCaseSensitive(item(held.get()), "holdRemainingSeconds"), 179);
        require(!cache.needs_publish(MqttTelemetryChannel::Thermostats, key(held.get()), 2000),
                "countdown caused a status flood");
        cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(item(held.get()), "holdReason"), "");
        cJSON_ReplaceItemInObjectCaseSensitive(item(held.get()), "state", cJSON_CreateTrue());
        require(cache.needs_publish(MqttTelemetryChannel::Thermostats, key(held.get()), 3000),
                "minimum-off completion was suppressed");
    } else if (name == "security") {
        auto security = json(
            R"({"armed":true,"triggered":true,"phase":"entry_delay","remainingSeconds":15,"reader":{"available":true,"updatedAtUptimeMs":1000},"keys":[{"id":"private-key","address":"0102030405060708"}],"items":[{"id":"door","active":true}]})");
        mqtt_telemetry_compact(MqttTelemetryChannel::Security, security.get());
        require(cJSON_GetObjectItemCaseSensitive(security.get(), "keys") == nullptr,
                "iButton allowlist leaked into retained MQTT status");
        require(cJSON_GetObjectItemCaseSensitive(security.get(), "keyCount")->valueint == 1,
                "redacted key count missing");
        const auto before = key(security.get());
        cache.accepted(MqttTelemetryChannel::Security, before, 1000);
        cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(security.get(), "remainingSeconds"),
                             14);
        cJSON_SetNumberValue(
            cJSON_GetObjectItemCaseSensitive(
                cJSON_GetObjectItemCaseSensitive(security.get(), "reader"), "updatedAtUptimeMs"),
            2000);
        require(!cache.needs_publish(MqttTelemetryChannel::Security, key(security.get()), 2000),
                "security countdown or reader heartbeat flooded MQTT");
        cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(security.get(), "phase"), "alarm");
        require(cache.needs_publish(MqttTelemetryChannel::Security, key(security.get()), 2001),
                "entry delay completion did not publish alarm");
    } else if (name == "tanks") {
        auto tank = json(
            R"({"enabled":true,"items":[{"id":"tank","enabled":true,"available":true,"levelsWet":[true,false],"levelPct":50,"pumpActual":true,"valveActual":true,"error":null}]})");
        mqtt_telemetry_compact(MqttTelemetryChannel::Tanks, tank.get());
        const auto before = key(tank.get());
        cache.accepted(MqttTelemetryChannel::Tanks, before, 1000);
        require(!cache.needs_publish(MqttTelemetryChannel::Tanks, before, 1100),
                "unchanged tank observations caused a status flood");
        cJSON_ReplaceItemInArray(cJSON_GetObjectItemCaseSensitive(item(tank.get()), "levelsWet"),
                                 0,
                                 cJSON_CreateFalse());
        cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(item(tank.get()), "levelPct"), 0);
        cJSON_ReplaceItemInObjectCaseSensitive(item(tank.get()), "pumpActual", cJSON_CreateFalse());
        require(cache.needs_publish(MqttTelemetryChannel::Tanks, key(tank.get()), 1200),
                "empty tank and dry-run stop were suppressed");
        cache.accepted(MqttTelemetryChannel::Tanks, key(tank.get()), 1200);
        cJSON_ReplaceItemInObjectCaseSensitive(item(tank.get()), "available", cJSON_CreateFalse());
        cJSON_ReplaceItemInObjectCaseSensitive(item(tank.get()), "levelPct", cJSON_CreateNull());
        cJSON_ReplaceItemInObjectCaseSensitive(
            item(tank.get()), "valveActual", cJSON_CreateFalse());
        cJSON_ReplaceItemInObjectCaseSensitive(
            item(tank.get()), "error", cJSON_CreateString("input fault"));
        require(cache.needs_publish(MqttTelemetryChannel::Tanks, key(tank.get()), 1300),
                "tank input fault and closed fill valve were suppressed");
        cache.accepted(MqttTelemetryChannel::Tanks, key(tank.get()), 1300);
        cJSON_ReplaceItemInObjectCaseSensitive(item(tank.get()), "enabled", cJSON_CreateFalse());
        require(cache.needs_publish(MqttTelemetryChannel::Tanks, key(tank.get()), 1400),
                "tank monitoring disable was suppressed");
    } else if (name == "irrigation") {
        auto rules = json(
            R"({"items":[{"id":"garden","actual":true,"valveActual":true,"waterAvailable":true,"remainingSeconds":55}]})");
        const auto channel = MqttTelemetryChannel::Irrigation;
        cache.accepted(channel, key(rules.get()), 1000);
        auto* row = item(rules.get());
        cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(row, "remainingSeconds"), 54);
        require(!cache.needs_publish(channel, key(rules.get()), 2000),
                "Countdown flooded telemetry");
        cJSON_ReplaceItemInObject(row, "waterAvailable", cJSON_CreateFalse());
        require(cache.needs_publish(channel, key(rules.get()), 2001), "Empty tank was suppressed");
        cache.accepted(channel, key(rules.get()), 2001);
        cJSON_ReplaceItemInObject(row, "actual", cJSON_CreateFalse());
        cJSON_ReplaceItemInObject(row, "valveActual", cJSON_CreateFalse());
        require(cache.needs_publish(channel, key(rules.get()), 2002),
                "Closed irrigation valve was suppressed");
    } else if (name == "large_discovery") {
        auto full = json("{\"items\":[]}");
        auto* rows = cJSON_GetObjectItemCaseSensitive(full.get(), "items");
        const std::string display_name(64, 'n');
        for (unsigned row = 0; row < 16; ++row) {
            auto* entry = cJSON_CreateObject();
            cJSON_AddStringToObject(entry, "id", ("sensor-" + std::to_string(row)).c_str());
            cJSON_AddStringToObject(entry, "name", display_name.c_str());
            cJSON_AddStringToObject(entry, "portId", "sens-0/1");
            cJSON_AddStringToObject(entry, "sensorType", "onewire");
            cJSON_AddStringToObject(entry, "error", "");
            cJSON_AddNullToObject(entry, "humidityPct");
            cJSON_AddNumberToObject(entry, "temperatureC", 21.5);
            cJSON_AddBoolToObject(entry, "available", true);
            cJSON_AddNumberToObject(entry, "sampledAtUptimeMs", 1000);
            cJSON_AddStringToObject(entry, "address", address(row).c_str());
            auto* devices = cJSON_AddArrayToObject(entry, "devices");
            for (unsigned device = 0; device < 16; ++device) {
                auto* discovered = cJSON_CreateObject();
                cJSON_AddStringToObject(discovered, "address", address(device).c_str());
                cJSON_AddBoolToObject(discovered, "available", true);
                cJSON_AddNumberToObject(discovered, "temperatureC", 21.5);
                cJSON_AddNumberToObject(discovered, "ageMs", 100);
                cJSON_AddNumberToObject(discovered, "sampledAtUptimeMs", 1000);
                cJSON_AddStringToObject(discovered, "error", "");
                cJSON_AddItemToArray(devices, discovered);
            }
            cJSON_AddItemToArray(rows, entry);
        }
        char* full_text = cJSON_PrintUnformatted(full.get());
        require(full_text != nullptr && std::string(full_text).size() > kMqttTelemetryMaxBytes,
                "fixture no longer exercises the valid repeated-catalog transport overflow");
        cJSON_free(full_text);
        mqtt_telemetry_compact(kChannel, full.get());
        const auto compact = key(full.get());
        require(compact.size() < 8192 && cJSON_GetArraySize(rows) == 16,
                "selected sensor telemetry was dropped or remains unbounded");
        for (auto* entry = rows->child; entry != nullptr; entry = entry->next) {
            require(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(entry, "devices")) == 0,
                    "repeated discovery catalog remained in MQTT");
            require(cJSON_GetObjectItemCaseSensitive(entry, "temperatureC")->valuedouble == 21.5
                        && cJSON_GetObjectItemCaseSensitive(entry, "sampledAtUptimeMs")->valueint
                               == 1000,
                    "compaction lost the selected measurement or freshness timestamp");
        }
    } else {
        require(false, "unknown scenario");
    }
    return 0;
}
