/** @file management_test.cpp @brief Real service storage/controller tests behind private MQTT
 * envelopes. */
#include "network/management_mqtt.h"
#include "network/management_routes.h"
#include "config/config.h"
#include "config/backup.h"
#include "config/settings_store.h"
#include "controllers/socket_controller.h"
#include "hardware/board_profile.h"
#include "security/auth.h"
#include "util/operation_context.h"
#include "test_platform.h"
#include "meteo_fake.h"
#include "ibutton_fake.h"
#include "esp_timer.h"
#include <atomic>
#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace management_test {
extern unsigned scans;
extern std::int64_t unix_time;
}  // namespace management_test

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
#define REQUIRE(c)                                                                                 \
    do {                                                                                           \
        if (!(c))                                                                                  \
            throw std::runtime_error(std::string(__func__) + ":" + std::to_string(__LINE__)        \
                                     + ": " #c);                                                   \
    } while (false)
unsigned reservations = 0;
bool reserve_allowed = true;

/** @brief Reserve the fake reboot worker without issuing a reset. */
bool reserve_reboot()
{
    ++reservations;
    return reserve_allowed;
}

/** @brief Obtain a borrowed field in an owned JSON test tree. */
const cJSON* field(const cJSON* root, const char* key)
{
    return cJSON_GetObjectItemCaseSensitive(root, key);
}

/** @brief Parse complete owned test JSON. */
Json parse(const std::string& value)
{
    Json json(cJSON_Parse(value.c_str()), cJSON_Delete);
    REQUIRE(json);
    return json;
}

/** @brief Serialize one borrowed JSON value for private protocol tests. */
std::string print(const cJSON* value)
{
    char* raw = cJSON_PrintUnformatted(value);
    REQUIRE(raw);
    std::string result(raw);
    cJSON_free(raw);
    return result;
}

/** @brief Read the numeric status of a private response. */
int status(const ManagementOutcome& outcome)
{
    auto value = parse(outcome.payload);
    return static_cast<int>(field(value.get(), "status")->valuedouble);
}

/** @brief Run one deterministic controller sampling step. */
void step()
{
    backup_test::advance(100'000);
    socket_controller_test_step();
}

/** @brief Initialize real config/auth/controllers on isolated fake NVS and FRAM. */
void boot()
{
    socket_controller_test_reset();
    auth_test_reset();
    settings_store_test_reset();
    meteo_fake::reset();
    ibutton_fake::reset();
    backup_test::clear_pending();
    backup_test::reset();
    REQUIRE(settings_store_init() == ESP_OK);
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(board_profile_activate(config_get().hardware.boardId));
    REQUIRE(auth_init() == ESP_OK);
    REQUIRE(socket_controller_init() == ESP_OK);
    step();
}

/** @brief A private-session fixture whose calls use production envelope and business dispatch. */
struct Fixture {
    ManagementProtocol protocol;
    unsigned next = 1;

    /** @brief Build a bounded request for the current fake boot and monotonic time. */
    std::string
    request(const std::string& method, const std::string& path, const std::string& body = "")
    {
        auto root = parse("{}");
        cJSON_AddNumberToObject(root.get(), "schemaVersion", 1);
        cJSON_AddStringToObject(
            root.get(), "requestId", ("request-" + std::to_string(next)).c_str());
        cJSON_AddStringToObject(root.get(), "bootId", "native-boot");
        cJSON_AddNumberToObject(root.get(), "sequence", next++);
        cJSON_AddNumberToObject(
            root.get(), "expiresAtUptimeMs", esp_timer_get_time() / 1000 + 20'000);
        cJSON_AddStringToObject(root.get(), "method", method.c_str());
        cJSON_AddStringToObject(root.get(), "path", path.c_str());
        if (!body.empty()) {
            auto json = parse(body);
            cJSON_AddItemToObject(root.get(), "body", json.release());
        }
        return print(root.get());
    }

    /** @brief Process a complete request through the real service dispatcher. */
    ManagementOutcome process(const std::string& payload, bool retained = false)
    {
        return protocol.process(payload,
                                retained,
                                "native-boot",
                                esp_timer_get_time() / 1000,
                                [](const ManagementRequest& request) {
                                    return management_dispatch(request, {reserve_reboot});
                                });
    }

    /** @brief Build and execute one explicit service request. */
    ManagementOutcome
    call(const std::string& method, const std::string& path, const std::string& body = "")
    {
        return process(request(method, path, body));
    }

    /** @brief Read the module's current configuration revision. */
    unsigned revision(const std::string& module)
    {
        const auto result = call("GET", "/controllers/" + module);
        REQUIRE(status(result) == 200);
        auto value = parse(result.payload);
        return static_cast<unsigned>(field(field(value.get(), "data"), "revision")->valuedouble);
    }

    /** @brief Configure a static or Meteo module using its real current revision. */
    ManagementOutcome configure(const std::string& module, const std::string& items)
    {
        return call("POST",
                    "/controllers/" + module,
                    "{\"baseRevision\":" + std::to_string(revision(module))
                        + ",\"enabled\":true,\"items\":" + items + "}");
    }
};

/** @brief Read the whole service inventory, including raw profile arrays and redacted settings. */
void reads()
{
    Fixture f;
    for (const auto* path : {"/config",
                             "/status",
                             "/board-profiles",
                             "/hardware",
                             "/controllers",
                             "/controllers/sockets",
                             "/controllers/lights",
                             "/controllers/meteo",
                             "/controllers/thermostats",
                             "/controllers/security"}) {
        const auto result = f.call("GET", path);
        REQUIRE(status(result) == 200);
        auto response = parse(result.payload);
        REQUIRE(std::string(path) == "/board-profiles"
                    ? cJSON_IsArray(field(response.get(), "data"))
                    : cJSON_IsObject(field(response.get(), "data")));
    }
    auto config = parse(f.call("GET", "/config").payload);
    REQUIRE(std::string(
                cJSON_GetStringValue(field(field(field(config.get(), "data"), "user"), "username")))
            == "admin");
    REQUIRE(status(f.call("GET", "/login")) == 404);
    REQUIRE(status(f.call("POST", "/logout", "{}")) == 404);
}

/** @brief Reject retained, stale-boot, expired, ambiguous and unrecognized envelope forms. */
void validation()
{
    Fixture f;
    const auto original = f.request("GET", "/config");
    REQUIRE(status(f.process(original, true)) == 409);
    REQUIRE(f.protocol.sequence() == 0);
    for (const auto* key : {"bootId", "expiresAtUptimeMs", "schemaVersion"}) {
        auto json = parse(original);
        if (std::string(key) == "bootId")
            cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(json.get(), key), "old-boot");
        else
            cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(json.get(), key), 0);
        REQUIRE(status(f.process(print(json.get()))) >= 400);
    }
    REQUIRE(status(f.call("GET", "/config?secret=1")) == 400);
    REQUIRE(status(f.call("GET", "/config", "{}")) == 400);
    REQUIRE(status(f.call("DELETE", "/config")) == 400);
    REQUIRE(status(f.process("{\"schemaVersion\":1,\"schemaVersion\":1}")) == 400);
    REQUIRE(status(f.process("[]")) == 400);
    REQUIRE(status(f.process(std::string(kManagementMaxRequestBytes + 1, 'x'))) == 400);
}

/** @brief Duplicate requests replay the exact private result without another configuration commit.
 */
void replay()
{
    Fixture f;
    const auto request = f.request("POST",
                                   "/config",
                                   "{\"baseRevision\":" + std::to_string(config_get().revision)
                                       + ",\"device\":{\"name\":\"Saved\"}}");
    const auto first = f.process(request);
    REQUIRE(status(first) == 200);
    REQUIRE(first.deferred.timeApply);
    const auto commits = backup_test::nvs_commits();
    const auto duplicate = f.process(request);
    REQUIRE(first.payload == duplicate.payload);
    REQUIRE(!duplicate.deferred.timeApply);
    REQUIRE(backup_test::nvs_commits() == commits);
    auto changed = parse(request);
    cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(changed.get(), "path"), "/reboot");
    REQUIRE(status(f.process(print(changed.get()))) == 409);
    REQUIRE(status(f.call("GET", "/status")) == 200);
    REQUIRE(status(f.process(request)) == 409);
}

/** @brief Persist network/device settings with real revision conflicts and redacted ordinary reads.
 */
void config()
{
    Fixture f;
    const auto revision = config_get().revision;
    const auto saved = f.call(
        "POST",
        "/config",
        "{\"baseRevision\":" + std::to_string(revision)
            + ",\"device\":{\"name\":\"Managed PLC\"},\"linux\":{\"host\":\"hub.local\",\"password\":\"private-broker-password\"}}");
    REQUIRE(status(saved) == 200);
    REQUIRE(saved.deferred.networkApply);
    REQUIRE(config_get().device.name == "Managed PLC");
    REQUIRE(status(f.call("POST", "/config", "{\"baseRevision\":" + std::to_string(revision) + "}"))
            == 409);
    REQUIRE(f.call("GET", "/config").payload.find("private-broker-password") == std::string::npos);
    REQUIRE(status(f.call("POST",
                          "/config",
                          "{\"baseRevision\":" + std::to_string(config_get().revision)
                              + ",\"hardware\":{\"boardId\":\"unknown-board\"}}"))
            == 400);
}

/** @brief Perform real CRUD and explicit state/permission operations for all controller families.
 */
void controllers()
{
    Fixture f;
    REQUIRE(status(f.configure("sockets",
                               R"([{"id":"plug","name":"Plug","relayId":"rly-0/1","inputId":""}])"))
            == 200);
    REQUIRE(status(f.call("POST", "/controllers/sockets/state", R"({"id":"plug","value":true})"))
            == 200);
    REQUIRE(backup_test::relay(0));
    REQUIRE(status(f.configure("lights",
                               R"([{"id":"lamp","name":"Lamp","relayId":"rly-0/2","inputId":""}])"))
            == 200);
    REQUIRE(status(f.call("POST", "/controllers/lights/state", R"({"id":"lamp","value":true})"))
            == 200);
    REQUIRE(backup_test::relay(1));
    REQUIRE(
        status(f.configure(
            "meteo",
            R"([{"id":"room","name":"Room","portId":"sens-0/1","sensorType":"dht22","address":""}])"))
        == 200);
    REQUIRE(
        status(f.configure(
            "thermostats",
            R"([{"id":"heat","name":"Heat","relayId":"rly-0/3","meteoId":"room","inputId":"","mode":"heating","setpointC":22,"hysteresisC":1}])"))
        == 200);
    REQUIRE(
        status(f.call("POST", "/controllers/thermostats/enabled", R"({"id":"heat","value":false})"))
        == 200);
    REQUIRE(
        status(f.call(
            "POST",
            "/controllers/security",
            "{\"baseRevision\":" + std::to_string(f.revision("security"))
                + R"(,"enabled":true,"sirenRelayId":"rly-0/16","readerPortId":"","exitDelaySeconds":0,"entryDelaySeconds":0,"keys":[],"items":[{"id":"door","name":"Door","inputId":"in-0/16","sensorType":"reed","entryDelay":false}]})"))
        == 200);
    backup_test::input(15, false);
    step();
    step();
    step();
    REQUIRE(status(f.call("POST", "/controllers/security/armed", R"({"value":true})")) == 200);
    REQUIRE(status(f.call("POST", "/controllers/security/armed", R"({"value":false})")) == 200);
    REQUIRE(status(f.configure("sockets", "[]")) == 200);
    REQUIRE(!backup_test::relay(0));
    REQUIRE(status(f.call("POST", "/controllers/sockets/state", R"({"id":"plug","value":true})"))
            == 404);
}

/** @brief Enforce shared resource claims and prevent raw control of a thermostat-owned relay. */
void ownership()
{
    Fixture f;
    REQUIRE(
        status(f.configure(
            "meteo",
            R"([{"id":"room","name":"Room","portId":"sens-0/1","sensorType":"dht22","address":""}])"))
        == 200);
    REQUIRE(
        status(f.configure(
            "thermostats",
            R"([{"id":"heat","name":"Heat","relayId":"rly-0/3","meteoId":"room","inputId":"","mode":"heating","setpointC":22,"hysteresisC":1}])"))
        == 200);
    REQUIRE(status(f.call("POST", "/hardware/relay", R"({"id":"rly-0/3","value":true})")) == 409);
    REQUIRE(!backup_test::relay(2));
    REQUIRE(status(f.configure("lights",
                               R"([{"id":"bad","name":"Bad","relayId":"rly-0/3","inputId":""}])"))
            == 409);
    REQUIRE(status(f.call("POST", "/hardware/relay", R"({"id":"rly-0/4","value":true})")) == 200);
    REQUIRE(backup_test::relay(3));
}

/** @brief Queue bounded hardware and sensor searches without synchronous physical bus scans. */
void scans()
{
    Fixture f;
    REQUIRE(status(f.call("POST", "/hardware/scan", "{}")) == 200);
    REQUIRE(management_test::scans == 1);
    REQUIRE(
        status(f.call("POST", "/controllers/meteo/scan", R"({"portId":"sens-0/2","refresh":true})"))
        == 200);
    REQUIRE(meteo_fake::scan_calls() == 1);
    REQUIRE(status(f.call(
                "POST", "/controllers/security/scan", R"({"portId":"sens-0/8","refresh":true})"))
            == 200);
    REQUIRE(ibutton_fake::scan_calls() == 1);
}

/** @brief Require the current password when changing the account through trusted MQTT. */
void user()
{
    Fixture f;
    REQUIRE(
        status(f.call("POST", "/user", R"({"username":"operator","newPassword":"new-password"})"))
        == 400);
    REQUIRE(status(f.call(
                "POST",
                "/user",
                R"({"username":"operator","currentPassword":"","newPassword":"new-password"})"))
            == 200);
    REQUIRE(auth_get_username() == "operator");
    REQUIRE(status(f.call("POST", "/user", R"({"username":"attacker","currentPassword":"wrong"})"))
            == 403);
    REQUIRE(auth_get_username() == "operator");
}

/** @brief Keep timezone revision checks and range validation on remotely set ESP time. */
void clock_case()
{
    Fixture f;
    REQUIRE(status(f.call("POST", "/time", R"({"unixTime":1})")) == 400);
    REQUIRE(status(f.call("POST", "/time", R"({"unixTime":1800000000,"timezone":"Changed"})"))
            == 409);
    REQUIRE(status(f.call("POST", "/time", R"({"unixTime":1800000000})")) == 200);
    REQUIRE(management_test::unix_time == 1800000000);
}

/** @brief Return a complete private backup while ordinary configuration remains redacted. */
void backup()
{
    Fixture f;
    REQUIRE(status(f.call("POST",
                          "/config",
                          "{\"baseRevision\":" + std::to_string(config_get().revision)
                              + ",\"linux\":{\"password\":\"backup-secret\"}}"))
            == 200);
    REQUIRE(f.call("GET", "/config").payload.find("backup-secret") == std::string::npos);
    const auto exported = f.call("GET", "/config/backup");
    REQUIRE(status(exported) == 200);
    REQUIRE(exported.payload.find("backup-secret") != std::string::npos);
    auto reply = parse(exported.payload);
    REQUIRE(field(field(reply.get(), "data"), "version")->valuedouble == 8);
}

/** @brief Reserve reboot before an atomic same-board restore and never repeat its commit on retry.
 */
void restore()
{
    Fixture f;
    auto reply = parse(f.call("GET", "/config/backup").payload);
    auto body = parse("{}");
    cJSON_AddNumberToObject(body.get(), "baseRevision", config_get().revision);
    cJSON_AddItemToObject(
        body.get(), "document", cJSON_Duplicate(field(reply.get(), "data"), true));
    const auto request = f.request("POST", "/config/restore", print(body.get()));
    reserve_allowed = false;
    REQUIRE(status(f.process(request)) == 503);
    REQUIRE(!settings_restore_pending());
    reserve_allowed = true;
    const auto accepted = f.request("POST", "/config/restore", print(body.get()));
    const auto result = f.process(accepted);
    REQUIRE(status(result) == 200);
    REQUIRE(result.deferred.reboot);
    REQUIRE(settings_restore_pending());
    const auto commits = backup_test::nvs_commits();
    const auto cached = f.process(accepted);
    REQUIRE(cached.payload == result.payload);
    REQUIRE(!cached.deferred.reboot);
    REQUIRE(backup_test::nvs_commits() == commits);
    REQUIRE(status(f.call("POST",
                          "/config",
                          "{\"baseRevision\":" + std::to_string(config_get().revision) + "}"))
            == 409);
}

/** @brief Preserve retain/offset/size/timeout checks across arbitrarily fragmented MQTT payloads.
 */
void fragments()
{
    Fixture f;
    const auto request =
        f.request("POST", "/unknown", "{\"padding\":\"" + std::string(35'000, 'x') + "\"}");
    ManagementFragments assembler;
    std::string complete;
    for (std::size_t offset = 0; offset < request.size(); offset += 997) {
        const auto length = std::min<std::size_t>(997, request.size() - offset);
        const bool done = assembler.append(std::string_view(request).substr(offset, length),
                                           offset,
                                           request.size(),
                                           false,
                                           100,
                                           complete);
        REQUIRE(done == (offset + length == request.size()));
    }
    REQUIRE(complete == request);
    REQUIRE(status(f.process(complete)) == 404);
    REQUIRE(!assembler.active());
    REQUIRE(!assembler.append("a", 0, 2, true, 100, complete));
    REQUIRE(!assembler.active());
    REQUIRE(!assembler.append("a", 0, 2, false, 100, complete));
    REQUIRE(!assembler.append("b", 1, 2, true, 101, complete));
    REQUIRE(!assembler.active());
    REQUIRE(!assembler.append("a", 0, 3, false, 100, complete));
    REQUIRE(!assembler.append("c", 2, 3, false, 101, complete));
    REQUIRE(!assembler.active());
    REQUIRE(!assembler.append("a", 0, 2, false, 100, complete));
    REQUIRE(!assembler.append("b", 1, 2, false, 5101, complete));
    REQUIRE(!assembler.active());
    REQUIRE(!assembler.append("a", 0, kManagementMaxRequestBytes + 1, false, 100, complete));
    REQUIRE(!assembler.append("a", 0, 2, false, 100, complete));
    assembler.reset();
    REQUIRE(!assembler.append("b", 1, 2, false, 101, complete));
}

/** @brief Keep a valid 60 KiB private reply and reject larger responses without truncating JSON. */
void large()
{
    Fixture f;
    const auto dispatch = [](const ManagementRequest&) {
        auto* body = cJSON_CreateObject();
        cJSON_AddStringToObject(body, "private", std::string(60'000, 'x').c_str());
        return ManagementRouteResult{200, body, {}};
    };
    const auto result = f.protocol.process(
        f.request("GET", "/large"), false, "native-boot", esp_timer_get_time() / 1000, dispatch);
    REQUIRE(status(result) == 200);
    REQUIRE(result.payload.size() > 60'000);
    const auto huge = f.protocol.process(f.request("GET", "/huge"),
                                         false,
                                         "native-boot",
                                         esp_timer_get_time() / 1000,
                                         [](const ManagementRequest&) {
                                             auto* body = cJSON_CreateObject();
                                             cJSON_AddStringToObject(
                                                 body, "private", std::string(70'000, 'x').c_str());
                                             return ManagementRouteResult{200, body, {}};
                                         });
    REQUIRE(status(huge) == 503);
    REQUIRE(huge.payload.size() < 1024);
}

/** @brief Reject queued old-generation work and recheck context before committing business state.
 */
void generation()
{
    Fixture f;
    std::atomic<std::uint64_t> generation{2};
    const auto request = f.request("POST",
                                   "/config",
                                   "{\"baseRevision\":" + std::to_string(config_get().revision)
                                       + ",\"device\":{\"name\":\"Must not save\"}}");
    const auto commits = backup_test::nvs_commits();
    auto dispatch = [](const ManagementRequest& request) {
        return management_dispatch(request, {reserve_reboot});
    };
    REQUIRE(
        status(f.protocol.process(
            request, false, "native-boot", esp_timer_get_time() / 1000, dispatch, &generation, 1))
        == 409);
    REQUIRE(f.protocol.sequence() == 0);
    REQUIRE(backup_test::nvs_commits() == commits);
    const auto cancelled = f.protocol.process(
        request,
        false,
        "native-boot",
        esp_timer_get_time() / 1000,
        [&](const ManagementRequest& value) {
            generation.store(3);
            return management_dispatch(value, {reserve_reboot});
        },
        &generation,
        2);
    REQUIRE(status(cancelled) == 409);
    REQUIRE(config_get().device.name != "Must not save");
    REQUIRE(backup_test::nvs_commits() == commits);
    OperationContext constraints{esp_timer_get_time() + 1000, nullptr, 0};
    ScopedOperationContext context(constraints);
    backup_test::advance(2000, false);
    std::string error;
    bool network = false;
    auto body = parse("{\"baseRevision\":" + std::to_string(config_get().revision)
                      + ",\"device\":{\"name\":\"Late\"}}");
    REQUIRE(config_update(body.get(), error, network) == ESP_ERR_INVALID_STATE);
    REQUIRE(backup_test::nvs_commits() == commits);
}
}  // namespace

/** @brief Select one isolated native regression case for CTest. */
int main(int argc, char** argv)
{
    const std::vector<std::pair<std::string, std::function<void()>>> cases = {
        {"reads", reads},
        {"validation", validation},
        {"replay", replay},
        {"config", config},
        {"controllers", controllers},
        {"ownership", ownership},
        {"scans", scans},
        {"user", user},
        {"time", clock_case},
        {"backup", backup},
        {"restore", restore},
        {"fragments", fragments},
        {"large", large},
        {"generation", generation}};
    try {
        REQUIRE(argc == 2);
        boot();
        for (const auto& entry : cases)
            if (entry.first == argv[1]) {
                entry.second();
                std::cout << "PASS " << entry.first << '\n';
                return 0;
            }
        throw std::runtime_error("Unknown management test");
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
