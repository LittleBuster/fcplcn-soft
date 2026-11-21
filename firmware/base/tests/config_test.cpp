#include "config/config.h"
#include "test_platform.h"

#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
#define REQUIRE(condition)                                                                         \
    do {                                                                                           \
        if (!(condition))                                                                          \
            throw std::runtime_error(std::string(__func__) + ": " #condition);                     \
    } while (false)

Json parse(const std::string& body)
{
    Json result(cJSON_Parse(body.c_str()), cJSON_Delete);
    REQUIRE(result != nullptr);
    return result;
}

std::string print(const cJSON* json)
{
    char* data = cJSON_PrintUnformatted(json);
    REQUIRE(data != nullptr);
    const std::string result(data);
    cJSON_free(data);
    return result;
}

std::string public_snapshot()
{
    Json json(config_public_json(), cJSON_Delete);
    REQUIRE(json != nullptr);
    return print(json.get());
}

std::string string_field(const cJSON* object, const char* key)
{
    const char* value = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(object, key));
    REQUIRE(value != nullptr);
    return value;
}

void fresh()
{
    test_platform::reset();
    REQUIRE(config_init() == ESP_OK);
}

esp_err_t update(const std::string& body, std::string& error, bool& network_changed)
{
    auto json = parse(body);
    if (!cJSON_HasObjectItem(json.get(), "baseRevision")) {
        cJSON_AddNumberToObject(json.get(), "baseRevision", config_get().revision);
    }
    return config_update(json.get(), error, network_changed);
}

void apply(const std::string& body, bool expected_network_change = true)
{
    std::string error;
    bool changed = false;
    const auto result = update(body, error, changed);
    if (result != ESP_OK)
        throw std::runtime_error(std::string("Unexpected config rejection: ") + error);
    REQUIRE(changed == expected_network_change);
}

void reject(const std::string& body, esp_err_t expected = ESP_ERR_INVALID_ARG)
{
    const auto before = public_snapshot();
    const auto storage = test_platform::stored_config();
    const auto commits = test_platform::commit_count();
    std::string error;
    bool changed = true;
    REQUIRE(update(body, error, changed) == expected);
    REQUIRE(!error.empty());
    REQUIRE(!changed);
    REQUIRE(public_snapshot() == before);
    REQUIRE(test_platform::stored_config() == storage);
    REQUIRE(test_platform::commit_count() == commits);
}

bool contains_key(const cJSON* value, const std::string& key)
{
    for (const cJSON* child = value ? value->child : nullptr; child; child = child->next) {
        if (child->string && key == child->string)
            return true;
        if (contains_key(child, key))
            return true;
    }
    return false;
}

void defaults_and_identity()
{
    fresh();
    const auto c = config_get();
    std::string error;
    REQUIRE(validate_config(c, error));
    REQUIRE(c.revision == 1);
    REQUIRE(c.hardware.boardId == "fcplcn-161608-1v0");
    REQUIRE(c.hardware.boardId == kDefaultBoardProfileId);
    REQUIRE(c.wifi.enabled);
    REQUIRE(c.wifi.ap.enabled);
    REQUIRE(!c.wifi.sta.enabled);
    REQUIRE(c.wifi.ap.password.empty());
    REQUIRE(c.ethernet.enabled);
    REQUIRE(c.ethernet.dhcp);
    REQUIRE(c.wifi.ap.ssid == "FCPLCn-112233");
    REQUIRE(device_id() == "fcplcn-aabbcc112233");
    REQUIRE(!test_platform::stored_config().empty());
    REQUIRE(test_platform::commit_count() == 1);
    const auto saved = parse(test_platform::stored_config());
    const auto* hardware = cJSON_GetObjectItemCaseSensitive(saved.get(), "hardware");
    REQUIRE(cJSON_IsObject(hardware));
    REQUIRE(string_field(hardware, "boardId") == c.hardware.boardId);
    const auto visible = parse(public_snapshot());
    hardware = cJSON_GetObjectItemCaseSensitive(visible.get(), "hardware");
    REQUIRE(string_field(hardware, "boardId") == c.hardware.boardId);
}

void legacy_hardware_default_and_persistence()
{
    fresh();
    const std::string legacy =
        R"({"schemaVersion":1,"revision":7,"wifi":{"ap":{"ssid":"FCPLCn Legacy"}},"linux":{"host":"legacy.local"}})";
    test_platform::replace_stored_config(legacy);
    const auto commits = test_platform::commit_count();
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().revision == 7);
    REQUIRE(config_get().wifi.ap.ssid == "FCPLCn Legacy");
    REQUIRE(config_get().linux.host == "legacy.local");
    REQUIRE(config_get().hardware.boardId == kDefaultBoardProfileId);
    REQUIRE(test_platform::stored_config() == legacy);
    REQUIRE(test_platform::commit_count() == commits);

    apply(R"({"hardware":{"boardId":"wifi-relay-16-r2-stack"},"time":{"timezone":"UTC-3"}})",
          false);
    REQUIRE(config_get().revision == 8);
    const auto saved = parse(test_platform::stored_config());
    const auto* hardware = cJSON_GetObjectItemCaseSensitive(saved.get(), "hardware");
    REQUIRE(cJSON_IsObject(hardware));
    REQUIRE(string_field(hardware, "boardId") == kDefaultBoardProfileId);
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().revision == 8);
    REQUIRE(config_get().hardware.boardId == kDefaultBoardProfileId);
    REQUIRE(config_get().time.timezone == "UTC-3");
    REQUIRE(config_get().linux.host == "legacy.local");
}

void hardware_profile_validation_and_cas()
{
    fresh();
    reject(R"({"hardware":{"boardId":"unknown-board"}})");
    reject(R"({"hardware":{"boardId":""}})");
    reject(R"({"hardware":{"boardId":123}})");
    reject(R"({"hardware":null})");
    reject(R"({"hardware":{"boardId":"unknown-board"},"wifi":{"ap":{"ssid":"Must not persist"}}})");
    reject(R"({"baseRevision":0,"hardware":{"boardId":"wifi-relay-16-r2-stack"}})",
           ESP_ERR_INVALID_STATE);
    const auto commits = test_platform::commit_count();
    apply(R"({"hardware":{"boardId":"wifi-relay-16-r2-stack"}})", false);
    REQUIRE(config_get().revision == 1);
    REQUIRE(test_platform::commit_count() == commits);

    test_platform::replace_stored_config(
        R"({"schemaVersion":1,"revision":9,"hardware":{"boardId":"unknown-board"}})");
    const auto stored = test_platform::stored_config();
    REQUIRE(config_init() == ESP_ERR_INVALID_ARG);
    REQUIRE(test_platform::stored_config() == stored);
    REQUIRE(test_platform::commit_count() == commits);
}

void known_hardware_survives_network_recovery()
{
    fresh();
    const auto commits = test_platform::commit_count();
    const std::vector<std::string> records = {
        R"({"schemaVersion":1,"revision":9,"hardware":{"boardId":"wifi-relay-16-r2-stack"},"wifi":{"ap":{"channel":12}}})",
        R"({"schemaVersion":99,"revision":9,"hardware":{"boardId":"wifi-relay-16-r2-stack"},"wifi":{"enabled":false}})",
        R"({"schemaVersion":1.5,"revision":9,"hardware":{"boardId":"wifi-relay-16-r2-stack"},"wifi":{"enabled":false}})",
    };
    for (const auto& stored : records) {
        test_platform::replace_stored_config(stored);
        REQUIRE(config_init() == ESP_OK);
        REQUIRE(config_get().hardware.boardId == "fcplcn-161608-1v0");
        REQUIRE(config_get().revision == 1);
        REQUIRE(config_get().wifi.ap.enabled);
        REQUIRE(config_get().wifi.ap.channel == 1);
        REQUIRE(test_platform::stored_config() == stored);
        REQUIRE(test_platform::commit_count() == commits);
    }
}

void unicode_and_hostname_validation()
{
    fresh();
    apply(u8R"({"wifi":{"ap":{"ssid":"FCPLCn Дом"}},"linux":{"host":"gateway.local"}})");
    REQUIRE(config_get().wifi.ap.ssid == u8"FCPLCn Дом");
    REQUIRE(config_get().linux.host == "gateway.local");
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().wifi.ap.ssid == u8"FCPLCn Дом");
    REQUIRE(device_id() == "fcplcn-aabbcc112233");

    std::string thirty_two_bytes;
    for (int i = 0; i < 16; ++i)
        thirty_two_bytes += u8"Я";
    apply(std::string("{\"wifi\":{\"ap\":{\"ssid\":\"") + thirty_two_bytes + "\"}}}");
    reject(std::string("{\"wifi\":{\"ap\":{\"ssid\":\"") + thirty_two_bytes + u8"Я" + "\"}}}");
    reject(R"({"linux":{"host":"http://gateway.local"}})");
    reject(R"({"linux":{"host":"gateway.local:1883"}})");
    reject(u8R"({"linux":{"host":"контроллер.local"}})");
}

void at_least_one_interface()
{
    fresh();
    reject(R"({"wifi":{"enabled":false},"ethernet":{"enabled":false}})");
    reject(
        R"({"wifi":{"enabled":true,"ap":{"enabled":false},"sta":{"enabled":false}},"ethernet":{"enabled":false}})");
    apply(R"({"wifi":{"enabled":false}})");
    REQUIRE(!config_get().wifi.enabled);
    REQUIRE(config_get().ethernet.enabled);
    reject(R"({"ethernet":{"enabled":false}})");
    apply(R"({"wifi":{"enabled":true,"ap":{"enabled":true}},"ethernet":{"enabled":false}})");
    REQUIRE(config_get().wifi.ap.enabled);
    REQUIRE(!config_get().ethernet.enabled);
}

void static_network_validation()
{
    fresh();
    reject(R"({"ethernet":{"dhcp":false,"ip":"192.168.1.300"}})");
    reject(R"({"ethernet":{"dhcp":false,"netmask":"255.0.255.0"}})");
    reject(R"({"ethernet":{"dhcp":false,"netmask":"0.0.0.0"}})");
    reject(R"({"ethernet":{"dhcp":false,"ip":"192.168.1.0"}})");
    reject(R"({"ethernet":{"dhcp":false,"ip":"192.168.1.255"}})");
    reject(R"({"ethernet":{"dhcp":false,"ip":"224.1.1.20"}})");
    reject(R"({"ethernet":{"dhcp":false,"gateway":"192.168.2.1"}})");
    reject(R"({"ethernet":{"dhcp":false,"ip":"192.168.4.20","gateway":"192.168.4.1"}})");
    reject(R"({"ethernet":{"dhcp":false,"netmask":"255.255.0.0"}})");
    reject(R"({"wifi":{"ap":{"ip":"192.168.4.0"}}})");
    reject(R"({"wifi":{"ap":{"netmask":"255.255.255.255"}}})");
    apply(
        R"({"ethernet":{"dhcp":false,"ip":"10.10.20.30","netmask":"255.255.255.0","gateway":"10.10.20.1","dns":"10.10.20.1"}})");
    REQUIRE(!config_get().ethernet.dhcp);
    REQUIRE(config_get().ethernet.ip == "10.10.20.30");
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().ethernet.ip == "10.10.20.30");
}

void password_patch_and_public_redaction()
{
    fresh();
    apply(
        R"({"wifi":{"ap":{"password":"ap-test-secret"},"sta":{"password":"sta-test-secret"}},"linux":{"host":"linux.local","password":"mqtt-test-secret"}})");
    apply(
        u8R"({"wifi":{"ap":{"ssid":"Сеть FCPLCn"},"sta":{"ssid":"Router"}},"linux":{"username":"plc"}})");
    auto config = config_get();
    REQUIRE(config.wifi.ap.password == "ap-test-secret");
    REQUIRE(config.wifi.sta.password == "sta-test-secret");
    REQUIRE(config.linux.password == "mqtt-test-secret");

    Json json(config_public_json(), cJSON_Delete);
    REQUIRE(!contains_key(json.get(), "password"));
    const auto public_text = print(json.get());
    REQUIRE(public_text.find("ap-test-secret") == std::string::npos);
    REQUIRE(public_text.find("sta-test-secret") == std::string::npos);
    REQUIRE(public_text.find("mqtt-test-secret") == std::string::npos);
    const auto* wifi = cJSON_GetObjectItemCaseSensitive(json.get(), "wifi");
    REQUIRE(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(
        cJSON_GetObjectItemCaseSensitive(wifi, "ap"), "passwordSet")));
    REQUIRE(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(
        cJSON_GetObjectItemCaseSensitive(wifi, "sta"), "passwordSet")));
    REQUIRE(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(
        cJSON_GetObjectItemCaseSensitive(json.get(), "linux"), "passwordSet")));

    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().wifi.ap.password == "ap-test-secret");
    REQUIRE(config_get().wifi.sta.password == "sta-test-secret");
    REQUIRE(config_get().linux.password == "mqtt-test-secret");
    apply(R"({"wifi":{"ap":{"password":""},"sta":{"password":""}},"linux":{"password":""}})");
    config = config_get();
    REQUIRE(config.wifi.ap.password.empty());
    REQUIRE(config.wifi.sta.password.empty());
    REQUIRE(config.linux.password.empty());
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().wifi.ap.password.empty());
    REQUIRE(config_get().linux.password.empty());
}

void types_ranges_and_revision_cas()
{
    fresh();
    reject(R"({"wifi":{"enabled":"false"}})");
    reject(R"({"wifi":{"ap":null}})");
    reject(R"({"linux":{"port":1883.5}})");
    reject(R"({"linux":{"port":0}})");
    reject(R"({"linux":{"port":65536}})");
    reject(R"({"wifi":{"ap":{"channel":12}}})");
    reject(R"({"wifi":{"ap":{"password":"short"}}})");
    reject(R"({"time":{"ntpEnabled":true,"ntpServer":""}})");
    apply(R"({"time":{"timezone":"UTC-3"}})", false);
    REQUIRE(config_get().revision == 2);
    reject(R"({"baseRevision":1,"linux":{"host":"outdated.local"}})", ESP_ERR_INVALID_STATE);
    const auto commits = test_platform::commit_count();
    apply(R"({"time":{"timezone":"UTC-3"}})", false);
    REQUIRE(config_get().revision == 2);
    REQUIRE(test_platform::commit_count() == commits);
}

void failed_commit_preserves_active_config()
{
    fresh();
    apply(R"({"linux":{"host":"working.local","password":"saved-secret"}})");
    const auto before = public_snapshot();
    const auto storage = test_platform::stored_config();
    test_platform::fail_next_commit();
    reject(R"({"linux":{"host":"must-not-apply.local","password":"other-secret"}})", ESP_FAIL);
    REQUIRE(public_snapshot() == before);
    REQUIRE(test_platform::stored_config() == storage);
    REQUIRE(config_get().linux.host == "working.local");
    REQUIRE(config_get().linux.password == "saved-secret");
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().linux.host == "working.local");
    REQUIRE(config_get().linux.password == "saved-secret");
}

void corrupt_storage_uses_recovery_defaults()
{
    fresh();
    test_platform::replace_stored_config("{broken json");
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().revision == 1);
    REQUIRE(config_get().wifi.ap.ssid == "FCPLCn-112233");
    REQUIRE(config_get().wifi.ap.enabled);
    REQUIRE(config_get().ethernet.enabled && config_get().ethernet.dhcp);
    test_platform::replace_stored_config(
        R"({"schemaVersion":99,"revision":30,"wifi":{"enabled":false}})");
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().wifi.enabled);
    REQUIRE(config_get().revision == 1);
}

void supported_json_input_guard()
{
    const std::string raw_nul = std::string("{\"ssid\":\"before") + '\0' + "after\"}";
    REQUIRE(!supported_json_text(std::string_view(raw_nul.data(), raw_nul.size())));
    const std::string trailing_nul = std::string("{\"value\":1}") + '\0' + "{\"value\":2}";
    REQUIRE(!supported_json_text(std::string_view(trailing_nul.data(), trailing_nul.size())));
    REQUIRE(!supported_json_text(R"({"ssid":"before\u0000after"})"));
    REQUIRE(supported_json_text(R"({"ssid":"literal\\u0000text"})"));
    REQUIRE(supported_json_text(u8R"({"wifi":{"ap":{"ssid":"FCPLCn Дом"}}})"));

    const std::string depth_16 = std::string(16, '[') + '0' + std::string(16, ']');
    const std::string depth_17 = std::string(17, '[') + '0' + std::string(17, ']');
    REQUIRE(supported_json_text(depth_16));
    REQUIRE(!supported_json_text(depth_17));

    Json quoted(cJSON_CreateObject(), cJSON_Delete);
    const std::string value = std::string(30, '{') + std::string(30, '[')
                              + "quoted \"value\", a backslash \\ and more brackets "
                              + std::string(30, '}');
    REQUIRE(cJSON_AddStringToObject(quoted.get(), "text", value.c_str()) != nullptr);
    const auto encoded = print(quoted.get());
    REQUIRE(supported_json_text(encoded));

    fresh();
    test_platform::replace_stored_config(
        R"({"schemaVersion":1,"revision":9,"wifi":{"ap":{"ssid":"FCPLCn\u0000hidden"}}})");
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().revision == 1);
    REQUIRE(config_get().wifi.ap.ssid == "FCPLCn-112233");
    test_platform::replace_stored_config(
        R"({"schemaVersion":1,"revision":9,"wifi":{"ap":{"ssid":"literal\\u0000text"}}})");
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().revision == 9);
    REQUIRE(config_get().wifi.ap.ssid == R"(literal\u0000text)");
}

void recovery_revision_exhaustion()
{
    fresh();
    test_platform::replace_stored_config(
        R"({"schemaVersion":1,"revision":4294967295,"wifi":{"enabled":false}})");
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(config_get().revision == UINT32_MAX);
    const auto before = public_snapshot();
    const auto stored = test_platform::stored_config();
    const auto commits = test_platform::commit_count();
    REQUIRE(config_reset_networks() == ESP_ERR_INVALID_STATE);
    REQUIRE(public_snapshot() == before);
    REQUIRE(test_platform::stored_config() == stored);
    REQUIRE(test_platform::commit_count() == commits);
}
}  // namespace

void mac_failure_preserves_settings()
{
    fresh();
    const auto before = public_snapshot();
    const auto stored = test_platform::stored_config();
    const auto commits = test_platform::commit_count();
    test_platform::fail_next_mac_read();
    REQUIRE(config_init() == ESP_FAIL);
    REQUIRE(public_snapshot() == before);
    REQUIRE(test_platform::stored_config() == stored);
    REQUIRE(test_platform::commit_count() == commits);
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(public_snapshot() == before);
}

int main()
{
    const std::vector<std::pair<const char*, std::function<void()>>> tests = {
        {"defaults and device identity", defaults_and_identity},
        {"legacy hardware default and saved profile persistence",
         legacy_hardware_default_and_persistence},
        {"hardware profile validation, no mutation and revision CAS",
         hardware_profile_validation_and_cas},
        {"recognized hardware survives settings recovery",
         known_hardware_survives_network_recovery},
        {"Unicode SSID and hostname validation", unicode_and_hostname_validation},
        {"at least one network interface", at_least_one_interface},
        {"static IP, mask and overlapping subnets", static_network_validation},
        {"password patch, persistence and public redaction", password_patch_and_public_redaction},
        {"types, ranges, no-op and revision CAS", types_ranges_and_revision_cas},
        {"failed NVS commit preserves active config", failed_commit_preserves_active_config},
        {"MAC read failure returns an error without settings mutation",
         mac_failure_preserves_settings},
        {"corrupt storage recovery", corrupt_storage_uses_recovery_defaults},
        {"JSON NUL, Unicode, escaped text and nesting guard", supported_json_input_guard},
        {"recovery refuses revision wrap without RAM or NVS mutation",
         recovery_revision_exhaustion},
    };
    unsigned failed = 0;
    for (const auto& test : tests) {
        try {
            test.second();
            std::cout << "PASS " << test.first << '\n';
        } catch (const std::exception& error) {
            ++failed;
            std::cerr << "FAIL " << test.first << ": " << error.what() << '\n';
        }
    }
    std::cout << tests.size() - failed << '/' << tests.size()
              << " FCPLCn base config cases passed\n";
    return failed ? 1 : 0;
}
