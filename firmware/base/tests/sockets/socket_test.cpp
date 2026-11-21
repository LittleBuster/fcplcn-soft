#include "controllers/socket_controller.h"
#include "network/socket_mqtt.h"
#include "controllers/security_sync.h"
#include "hardware/hardware_io.h"
#include "hardware/board_profile.h"
#include "test_platform.h"
#include "cJSON.h"
#include "meteo_fake.h"
#include "ibutton_fake.h"
#include "util/checksum.h"
#include "esp_timer.h"
#include <functional>
#include <atomic>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
#define REQUIRE(c)                                                                                 \
    do {                                                                                           \
        if (!(c))                                                                                  \
            throw std::runtime_error(std::string(__func__) + ":" + std::to_string(__LINE__)        \
                                     + ": " #c);                                                   \
    } while (false)

Json parse(const std::string& text)
{
    Json j(cJSON_Parse(text.c_str()), cJSON_Delete);
    REQUIRE(j);
    return j;
}

Json status()
{
    Json j(socket_controller_status_json(), cJSON_Delete);
    REQUIRE(j);
    return j;
}

const cJSON* field(const cJSON* j, const char* key)
{
    return cJSON_GetObjectItemCaseSensitive(j, key);
}

const cJSON* item(const cJSON* j, unsigned i = 0)
{
    return cJSON_GetArrayItem(field(j, "items"), i);
}

bool boolean(const cJSON* j, const char* key)
{
    REQUIRE(cJSON_IsBool(field(j, key)));
    return cJSON_IsTrue(field(j, key));
}

unsigned revision()
{
    auto s = status();
    return static_cast<unsigned>(field(s.get(), "revision")->valuedouble);
}

bool state(unsigned i = 0)
{
    auto s = status();
    return boolean(item(s.get(), i), "state");
}

void step(std::int64_t us = 100'000, bool sample = true)
{
    socket_test::advance(us, sample);
    socket_controller_test_step();
}

void start(const char* boardId = kDefaultBoardProfileId)
{
    REQUIRE(board_profile_activate(boardId));
    meteo_fake::reset();
    socket_test::reset();
    ibutton_fake::reset();
    REQUIRE(socket_controller_init() == ESP_OK);
}

SocketResult update(const std::string& items, bool enabled = true, unsigned base = 0)
{
    auto j = parse("{\"baseRevision\":" + std::to_string(base ? base : revision())
                   + ",\"enabled\":" + (enabled ? "true" : "false") + ",\"items\":" + items + "}");
    std::string error;
    return socket_controller_update(j.get(), error);
}

const std::string one = R"([{"id":"socket-1","name":"Кухня","relayId":"rly-0/1","inputId":""}])";
const std::string with_input =
    R"([{"id":"socket-1","name":"Кухня","relayId":"rly-0/1","inputId":"in-0/1"}])";

void configure(const std::string& list = one)
{
    REQUIRE(update(list) == SocketResult::Ok);
    step();
}

SocketResult command(bool on, const std::string& id = "socket-1")
{
    std::string error;
    return socket_controller_set_state(id, on, error);
}

void reboot(bool heldLow = false)
{
    socket_controller_test_reset();
    socket_test::reboot_hardware();
    if (heldLow)
        socket_test::input(0, false);
    REQUIRE(socket_controller_init() == ESP_OK);
    step();
}

Json module(ControllerKind kind)
{
    Json result(controller_status_json(kind), cJSON_Delete);
    REQUIRE(result);
    return result;
}

unsigned module_revision(ControllerKind kind)
{
    auto result = module(kind);
    return static_cast<unsigned>(field(result.get(), "revision")->valuedouble);
}

bool module_state(ControllerKind kind, unsigned index = 0)
{
    auto result = module(kind);
    return boolean(item(result.get(), index), "state");
}

SocketResult module_update(ControllerKind kind, const std::string& items, bool enabled = true)
{
    auto body = parse("{\"baseRevision\":" + std::to_string(module_revision(kind)) + ",\"enabled\":"
                      + (enabled ? "true" : "false") + ",\"items\":" + items + "}");
    std::string error;
    return controller_update(kind, body.get(), error);
}

SocketResult module_command(ControllerKind kind, bool on, const std::string& id = "light-1")
{
    std::string error;
    return controller_set_state(kind, id, on, error);
}

void defaults()
{
    start();
    auto s = status();
    REQUIRE(!boolean(s.get(), "enabled"));
    REQUIRE(cJSON_GetArraySize(field(s.get(), "items")) == 0);
    const auto* ports = field(s.get(), "ports");
    REQUIRE(cJSON_GetArraySize(field(ports, "relays")) == 16);
    REQUIRE(cJSON_GetArraySize(field(ports, "inputs")) == 16);
}

void persistence()
{
    start();
    configure();
    const auto rev = revision();
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(state());
    REQUIRE(socket_test::relay(0));
    REQUIRE(revision() == rev);
    const auto commits = socket_test::commits();
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(socket_test::commits() == commits);
    reboot();
    REQUIRE(state());
    REQUIRE(socket_test::relay(0));
    auto s = status();
    REQUIRE(boolean(s.get(), "enabled"));
    REQUIRE(revision() == rev);
    std::string error;
    REQUIRE(socket_controller_set_relay("rly-0/1", false, error) == SocketResult::Ok);
    REQUIRE(!state());
    reboot();
    REQUIRE(!socket_test::relay(0));
    REQUIRE(socket_controller_set_relay("rly-0/16", true, error) == SocketResult::Ok);
    REQUIRE(socket_test::relay(15));
}

void edges()
{
    start();
    socket_test::input(0, true);
    configure(with_input);
    step();
    REQUIRE(!state());
    socket_test::input(0, false);
    step(10'000);
    step(20'000);
    step(20'000);
    REQUIRE(state());  // First press edge.
    socket_test::input(0, true);
    step(10'000);
    socket_test::input(0, false);
    step(10'000);
    step(20'000);
    step(20'000);
    REQUIRE(state());  // Bounce.
    for (int i = 0; i < 100; ++i)
        step();
    REQUIRE(state());  // Holding never repeats.
    socket_test::input(0, true);
    step();
    step();
    REQUIRE(state());  // Release never toggles.
    step(300'000);
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(!state());  // New press.
    socket_test::input(0, true);
    step(10'000);
    socket_test::input(0, false);
    step(10'000);
    step(20'000);
    step(20'000);
    REQUIRE(!state());
    socket_test::input(0, true);
    step(400'000);
    step();
    REQUIRE(!state());
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(state());
}

void exclusive_inputs()
{
    start();
    const auto before = revision();
    REQUIRE(
        update(
            R"([{"id":"a","name":"A","relayId":"rly-0/1","inputId":"in-0/1"},{"id":"b","name":"B","relayId":"rly-0/2","inputId":"in-0/1"}])")
        == SocketResult::Conflict);
    REQUIRE(revision() == before);
    auto current = status();
    REQUIRE(cJSON_GetArraySize(field(current.get(), "items")) == 0);
    REQUIRE(!socket_test::relay(0) && !socket_test::relay(1));
}

void validation()
{
    start();
    configure();
    const auto rev = revision();
    REQUIRE(update(one, true, rev + 1) == SocketResult::Conflict);
    const std::vector<std::string> invalid = {
        R"([{"id":"socket-1","name":"A","relayId":"rly-0/99","inputId":""}])",
        R"([{"id":"socket-1","name":"A","relayId":"rly-0/1","inputId":"in-0/99"}])",
        R"([{"id":"socket-1","name":"","relayId":"rly-0/1","inputId":""}])",
        R"([{"id":"bad/id","name":"A","relayId":"rly-0/1","inputId":""}])",
        R"([{"id":"a","name":"A","relayId":"rly-0/1","inputId":""},{"id":"a","name":"B","relayId":"rly-0/2","inputId":""}])",
        R"([{"id":"socket-1","name":"A","relayId":"rly-0/1","inputId":null}])"};
    for (const auto& bad : invalid) {
        REQUIRE(update(bad) == SocketResult::InvalidInput);
        REQUIRE(revision() == rev);
        REQUIRE(!state());
    }
    REQUIRE(
        update(
            R"([{"id":"a","name":"A","relayId":"rly-0/1","inputId":""},{"id":"b","name":"B","relayId":"rly-0/1","inputId":""}])")
        == SocketResult::Conflict);
    auto bad_type = parse("{\"baseRevision\":" + std::to_string(rev)
                          + ",\"enabled\":\"true\",\"items\":" + one + "}");
    std::string e;
    REQUIRE(socket_controller_update(bad_type.get(), e) == SocketResult::InvalidInput);
    REQUIRE(command(true, "missing") == SocketResult::NotFound);
}

void reconfigure()
{
    start();
    configure(with_input);
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(
        update(R"([{"id":"socket-1","name":"Новое имя","relayId":"rly-0/1","inputId":"in-0/1"}])")
        == SocketResult::Ok);
    REQUIRE(state());
    REQUIRE(socket_test::relay(0));
    REQUIRE(update(R"([{"id":"socket-1","name":"Кухня","relayId":"rly-0/2","inputId":""}])")
            == SocketResult::Ok);
    REQUIRE(!state());
    REQUIRE(!socket_test::relay(0));
    REQUIRE(!socket_test::relay(1));
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(socket_test::relay(1));
    REQUIRE(update("[]") == SocketResult::Ok);
    REQUIRE(!socket_test::relay(1));
    reboot();
    auto s = status();
    REQUIRE(cJSON_GetArraySize(field(s.get(), "items")) == 0);
}

void disable()
{
    start();
    configure();
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(update(one, false) == SocketResult::Ok);
    REQUIRE(!state() && !socket_test::relay(0));
    REQUIRE(command(true) == SocketResult::Disabled);
    reboot();
    REQUIRE(!state());
    REQUIRE(update(one, true) == SocketResult::Ok);
    step();
    REQUIRE(!state() && !socket_test::relay(0));
}

void storage_failure()
{
    start();
    configure();
    const auto rev = revision();
    socket_test::fail_fram_commit();
    REQUIRE(command(true) == SocketResult::StorageError);
    REQUIRE(!state());
    REQUIRE(!socket_test::relay(0));
    REQUIRE(revision() == rev);
    REQUIRE(command(true) == SocketResult::Ok);
    socket_test::fail_commit();
    REQUIRE(update(one, false) == SocketResult::StorageError);
    REQUIRE(state());
    REQUIRE(socket_test::relay(0));
    REQUIRE(revision() == rev);
    reboot();
    REQUIRE(state() && socket_test::relay(0));
}

void hardware_failure()
{
    start();
    configure();
    socket_test::fail_write();
    REQUIRE(command(true) == SocketResult::Unavailable);
    REQUIRE(!state());
    step();
    REQUIRE(!socket_test::relay(0));
    reboot();
    REQUIRE(!state());
    REQUIRE(command(true) == SocketResult::Ok);
    socket_test::fail_write();
    REQUIRE(command(false) == SocketResult::Unavailable);
    REQUIRE(state());
    reboot();
    REQUIRE(state() && socket_test::relay(0));
}

void recovery()
{
    start();
    configure(with_input);
    step();
    REQUIRE(command(true) == SocketResult::Ok);
    socket_test::input(0, false, false);
    step();
    socket_test::input(0, true, true);
    step();
    step();
    REQUIRE(state());
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    step();
    REQUIRE(!state());
    REQUIRE(command(true) == SocketResult::Ok);
    socket_test::reboot_hardware();
    step();
    REQUIRE(state() && socket_test::relay(0));
    step(500'000, false);
    socket_test::input(0, true);
    socket_controller_test_step();
    step();
    step();
    REQUIRE(state());
    socket_test::input(0, false, false);
    step();
    socket_test::input(0, false, true);
    step();
    step();
    REQUIRE(state());
    socket_test::input(0, true);
    step();
    step();
    step(300'000);
    REQUIRE(state());
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(!state());
}

void concurrent()
{
    start();
    configure();
    const auto rev = revision();
    std::vector<std::thread> threads;
    for (int i = 0; i < 4; ++i)
        threads.emplace_back([i] {
            for (int j = 0; j < 30; ++j) {
                std::string e;
                auto result = socket_controller_set_state("socket-1", (i + j) % 2, e);
                if (result != SocketResult::Ok)
                    std::terminate();
                auto s = status();
                if (!s)
                    std::terminate();
            }
        });
    for (auto& t : threads)
        t.join();
    const auto final = state();
    REQUIRE(socket_test::relay(0) == final);
    REQUIRE(revision() == rev);
    reboot();
    REQUIRE(state() == final && socket_test::relay(0) == final);
}

void corrupt_storage()
{
    start();
    configure();
    REQUIRE(command(true) == SocketResult::Ok);
    socket_test::corrupt_storage();
    reboot();
    auto s = status();
    REQUIRE(!boolean(s.get(), "enabled"));
    REQUIRE(cJSON_GetArraySize(field(s.get(), "items")) == 0);
    REQUIRE(!socket_test::relay(0));
}

void startup_low()
{
    start();
    socket_test::input(0, false);
    configure(with_input);
    for (int i = 0; i < 20; ++i)
        step();
    REQUIRE(!state());
    socket_test::input(0, true);
    step();
    step();
    REQUIRE(!state());
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(state());
    reboot(true);
    step();
    step();
    REQUIRE(state());
    socket_test::input(0, true);
    step();
    step();
    step(300'000);
    REQUIRE(state());
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(!state());
}

void input_failure()
{
    start();
    configure(with_input);
    step();
    socket_test::input(0, false, false);
    step();
    auto s = status();
    REQUIRE(cJSON_IsNull(field(item(s.get()), "inputLevel")));
    REQUIRE(boolean(item(s.get()), "available"));
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(state() && socket_test::relay(0));
    REQUIRE(command(false) == SocketResult::Ok);
    REQUIRE(!state());
    socket_test::input(0, true, true);
    step();
    step();
    socket_test::fail_fram_commit();
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(!state());
    for (int i = 0; i < 10; ++i)
        step();
    REQUIRE(!state());  // Failed press is consumed, never retried while held.
    socket_test::input(0, true);
    step();
    step();
    step(300'000);
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(state());
}

Json mqtt(const std::string& text, bool retained = false, std::int64_t uptime = 1000)
{
    Json j(socket_mqtt_command(text, retained, "test-boot", uptime), cJSON_Delete);
    REQUIRE(j);
    return j;
}

std::string mqtt_payload(unsigned seq,
                         bool on,
                         const std::string& boot = "test-boot",
                         unsigned deadline = 20'000)
{
    return "{\"id\":\"socket-1\",\"value\":" + std::string(on ? "true" : "false") + ",\"bootId\":\""
           + boot + "\",\"sequence\":" + std::to_string(seq)
           + ",\"expiresAtUptimeMs\":" + std::to_string(deadline) + "}";
}

void mqtt_set()
{
    start();
    configure();
    socket_mqtt_test_reset();
    auto ack = mqtt(mqtt_payload(1, true));
    REQUIRE(boolean(ack.get(), "ok"));
    REQUIRE(state() && socket_test::relay(0));
    ack = mqtt(mqtt_payload(2, false));
    REQUIRE(boolean(ack.get(), "ok"));
    REQUIRE(!state());
    REQUIRE(socket_mqtt_sequence() == 2);
    reboot();
    REQUIRE(!state());
    const auto seq = socket_mqtt_sequence();
    for (const auto& invalid :
         std::vector<std::string>{"{",
                                  R"({"value":"true"})",
                                  mqtt_payload(3, true, "other-boot"),
                                  mqtt_payload(3, true, "test-boot", 1000),
                                  mqtt_payload(3, true, "test-boot", 90'000)}) {
        ack = mqtt(invalid);
        REQUIRE(!boolean(ack.get(), "ok"));
        REQUIRE(!state());
        REQUIRE(socket_mqtt_sequence() == seq);
    }
    ack = mqtt(mqtt_payload(3, true), true);
    REQUIRE(!boolean(ack.get(), "ok"));
    REQUIRE(!state());
    ack = mqtt(
        R"({"id":"socket-1\u0000evil","value":true,"bootId":"test-boot","sequence":3,"expiresAtUptimeMs":20000})");
    REQUIRE(!boolean(ack.get(), "ok"));
}

void mqtt_replay()
{
    start();
    configure();
    socket_mqtt_test_reset();
    const auto request = mqtt_payload(1, true);
    auto ack = mqtt(request);
    REQUIRE(boolean(ack.get(), "ok"));
    REQUIRE(command(false) == SocketResult::Ok);
    ack = mqtt(request);
    REQUIRE(boolean(ack.get(), "ok"));
    REQUIRE(boolean(ack.get(), "duplicate"));
    REQUIRE(!state());
    ack = mqtt(mqtt_payload(1, false));
    REQUIRE(!boolean(ack.get(), "ok"));
    REQUIRE(!state());
    ack = mqtt(mqtt_payload(2, true));
    REQUIRE(boolean(ack.get(), "ok"));
    REQUIRE(state());
    ack = mqtt(request);
    REQUIRE(!boolean(ack.get(), "ok"));
    REQUIRE(state());
    REQUIRE(command(false) == SocketResult::Ok);
    ack = mqtt(mqtt_payload(3, true), false, 21'000);
    REQUIRE(!boolean(ack.get(), "ok"));
    REQUIRE(!state());
    socket_test::fail_fram_commit();
    ack = mqtt(mqtt_payload(3, true));
    REQUIRE(!boolean(ack.get(), "ok"));
    REQUIRE(!state());
    ack = mqtt(mqtt_payload(3, true));
    REQUIRE(!boolean(ack.get(), "ok"));
    REQUIRE(boolean(ack.get(), "duplicate"));
    REQUIRE(!state());
    socket_test::advance(30'000'000);
    ack = mqtt(mqtt_payload(
        4, true));  // Parser sees old time=1000ms, controller sees deadline already expired.
    REQUIRE(!boolean(ack.get(), "ok"));
    REQUIRE(!state() && !socket_test::relay(0));
}

void mqtt_snapshot()
{
    start();
    configure();
    socket_mqtt_test_reset();
    std::atomic<bool> okay{true};
    std::thread writer([&] {
        for (unsigned i = 1; i <= 100; ++i) {
            auto a = mqtt(mqtt_payload(i, i % 2));
            if (!boolean(a.get(), "ok"))
                okay = false;
        }
    });
    for (int i = 0; i < 300; ++i) {
        Json s(socket_mqtt_status_json(), cJSON_Delete);
        REQUIRE(s);
        const auto seq = static_cast<unsigned>(field(s.get(), "commandSequence")->valuedouble);
        if (boolean(item(s.get()), "state") != (seq % 2 == 1)
            || boolean(item(s.get()), "actual") != (seq % 2 == 1))
            okay = false;
    }
    writer.join();
    REQUIRE(okay);
    REQUIRE(socket_mqtt_sequence() == 100);
}

const std::string light =
    R"([{"id":"light-1","name":"Потолок","relayId":"rly-0/2","inputId":"in-0/2"}])";

void lights_basic()
{
    start();
    configure();
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(module_update(ControllerKind::Lights, light) == SocketResult::Ok);
    step();
    auto current = module(ControllerKind::Lights);
    REQUIRE(boolean(current.get(), "enabled"));
    REQUIRE(!module_state(ControllerKind::Lights));
    const auto rev = module_revision(ControllerKind::Lights);
    const auto socket_rev = revision();
    socket_test::fail_fram_commit();
    REQUIRE(module_command(ControllerKind::Lights, true) == SocketResult::StorageError);
    REQUIRE(!socket_test::relay(1) && socket_test::relay(0));
    REQUIRE(module_command(ControllerKind::Lights, true) == SocketResult::Ok);
    REQUIRE(socket_test::relay(1));
    REQUIRE(module_revision(ControllerKind::Lights) == rev && revision() == socket_rev);
    reboot();
    REQUIRE(state() && module_state(ControllerKind::Lights));
    REQUIRE(socket_test::relay(0) && socket_test::relay(1));
    step();
    socket_test::input(1, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(!module_state(ControllerKind::Lights));
    REQUIRE(state());
    for (int i = 0; i < 20; ++i)
        step();
    REQUIRE(!module_state(ControllerKind::Lights));
    socket_test::input(1, true);
    step();
    step();
    REQUIRE(!module_state(ControllerKind::Lights));
    socket_test::input(1, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(module_state(ControllerKind::Lights));
    std::string error;
    REQUIRE(socket_controller_set_relay("rly-0/2", false, error) == SocketResult::Ok);
    REQUIRE(!module_state(ControllerKind::Lights));
    reboot();
    REQUIRE(!module_state(ControllerKind::Lights) && state());
    REQUIRE(module_command(ControllerKind::Lights, true) == SocketResult::Ok);
    REQUIRE(module_update(ControllerKind::Lights, light, false) == SocketResult::Ok);
    REQUIRE(!module_state(ControllerKind::Lights) && !socket_test::relay(1));
    REQUIRE(state());
}

const cJSON* resource(const cJSON* aggregate, const char* id)
{
    for (const auto* r = field(aggregate, "resources")->child; r; r = r->next)
        if (std::string(cJSON_GetStringValue(field(r, "id"))) == id)
            return r;
    throw std::runtime_error("Resource missing");
}

void resource_exclusivity()
{
    start();
    configure(with_input);
    REQUIRE(module_update(ControllerKind::Lights,
                          R"([{"id":"socket-1","name":"Lamp","relayId":"rly-0/1","inputId":""}])")
            == SocketResult::Conflict);
    REQUIRE(
        module_update(ControllerKind::Lights,
                      R"([{"id":"socket-1","name":"Lamp","relayId":"rly-0/2","inputId":"in-0/1"}])")
        == SocketResult::Conflict);
    REQUIRE(module_update(ControllerKind::Lights, light) == SocketResult::Ok);
    Json aggregate(controllers_status_json(), cJSON_Delete);
    REQUIRE(aggregate);
    REQUIRE(cJSON_GetArraySize(field(aggregate.get(), "resources")) == 40);
    REQUIRE(std::string(cJSON_GetStringValue(
                field(resource(aggregate.get(), "rly-0/2"), "ownerController")))
            == "lights");
    REQUIRE(cJSON_IsNull(field(resource(aggregate.get(), "sens-0/1"), "ownerController")));
    REQUIRE(!boolean(resource(aggregate.get(), "sens-0/1"), "conflict"));
    REQUIRE(update(with_input, false) == SocketResult::Ok);
    REQUIRE(
        module_update(ControllerKind::Lights,
                      R"([{"id":"light-1","name":"Lamp","relayId":"rly-0/2","inputId":"in-0/1"}])")
        == SocketResult::Conflict);
    REQUIRE(update("[]", false) == SocketResult::Ok);
    REQUIRE(
        module_update(ControllerKind::Lights,
                      R"([{"id":"light-1","name":"Lamp","relayId":"rly-0/1","inputId":"in-0/1"}])")
        == SocketResult::Ok);
    REQUIRE(!socket_test::relay(0) && !socket_test::relay(1));
}

void concurrent_claims()
{
    start();
    const auto socket_rev = revision(), light_rev = module_revision(ControllerKind::Lights);
    std::atomic<bool> go{false};
    SocketResult a = SocketResult::Unavailable, b = a;
    const auto body = "{\"baseRevision\":" + std::to_string(socket_rev)
                      + ",\"enabled\":true,\"items\":" + one + "}";
    const auto other = "{\"baseRevision\":" + std::to_string(light_rev)
                       + ",\"enabled\":true,\"items\":" + one + "}";
    std::thread x([&] {
        auto j = parse(body);
        while (!go.load())
            std::this_thread::yield();
        std::string error;
        a = controller_update(ControllerKind::Sockets, j.get(), error);
    });
    std::thread y([&] {
        auto j = parse(other);
        while (!go.load())
            std::this_thread::yield();
        std::string error;
        b = controller_update(ControllerKind::Lights, j.get(), error);
    });
    go = true;
    x.join();
    y.join();
    REQUIRE((a == SocketResult::Ok && b == SocketResult::Conflict)
            || (b == SocketResult::Ok && a == SocketResult::Conflict));
    auto s = status(), l = module(ControllerKind::Lights);
    REQUIRE(cJSON_GetArraySize(field(s.get(), "items"))
                + cJSON_GetArraySize(field(l.get(), "items"))
            == 1);
}

void lights_mqtt()
{
    start();
    configure();
    REQUIRE(module_update(ControllerKind::Lights,
                          R"([{"id":"socket-1","name":"Lamp","relayId":"rly-0/2","inputId":""}])")
            == SocketResult::Ok);
    socket_mqtt_test_reset();
    const auto payload = mqtt_payload(1, true);
    auto a = mqtt(payload);
    REQUIRE(boolean(a.get(), "ok"));
    Json b(controller_mqtt_command(ControllerKind::Lights, payload, false, "test-boot", 1000),
           cJSON_Delete);
    REQUIRE(b && boolean(b.get(), "ok"));
    REQUIRE(state() && module_state(ControllerKind::Lights));
    REQUIRE(socket_mqtt_sequence() == 1 && controller_mqtt_sequence(ControllerKind::Lights) == 1);
    REQUIRE(module_command(ControllerKind::Lights, false, "socket-1") == SocketResult::Ok);
    b.reset(controller_mqtt_command(ControllerKind::Lights, payload, false, "test-boot", 1000));
    REQUIRE(boolean(b.get(), "duplicate"));
    REQUIRE(!module_state(ControllerKind::Lights) && state());
    a = mqtt(mqtt_payload(2, false));
    REQUIRE(boolean(a.get(), "ok"));
    REQUIRE(!state());
    REQUIRE(controller_mqtt_sequence(ControllerKind::Lights) == 1);
}

std::string sensor_rom(unsigned serial)
{
    unsigned char bytes[8] = {0x28,
                              static_cast<unsigned char>(serial),
                              static_cast<unsigned char>(serial >> 8),
                              0,
                              0,
                              0,
                              0,
                              0};
    unsigned char crc = 0;
    for (unsigned i = 0; i < 7; ++i) {
        auto byte = bytes[i];
        for (unsigned bit = 0; bit < 8; ++bit) {
            const bool mix = (crc ^ byte) & 1;
            crc >>= 1;
            if (mix)
                crc ^= 0x8c;
            byte >>= 1;
        }
    }
    bytes[7] = crc;
    const char* hex = "0123456789abcdef";
    std::string result;
    for (auto byte : bytes) {
        result += hex[byte >> 4];
        result += hex[byte & 15];
    }
    return result;
}

std::string meteo_row(const std::string& id,
                      const std::string& port = "sens-0/1",
                      const std::string& type = "dht22",
                      const std::string& address = "")
{
    return "{\"id\":\"" + id + "\",\"name\":\"" + id + "\",\"portId\":\"" + port
           + "\",\"sensorType\":\"" + type + "\",\"address\":\"" + address + "\"}";
}

void meteo_basic()
{
    start();
    configure();
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(module_update(ControllerKind::Lights, light) == SocketResult::Ok);
    REQUIRE(module_command(ControllerKind::Lights, true) == SocketResult::Ok);
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room") + "]")
            == SocketResult::Ok);
    REQUIRE(meteo_fake::enabled());
    REQUIRE(meteo_fake::configured().size() == 1);
    REQUIRE(meteo_fake::configured()[0].type == MeteoSensorType::Dht22);
    auto m = module(ControllerKind::Meteo);
    REQUIRE(cJSON_GetArraySize(field(field(m.get(), "ports"), "sensors")) == 8);
    REQUIRE(cJSON_IsNull(field(item(m.get()), "temperatureC")));
    REQUIRE(!boolean(item(m.get()), "available"));
    std::string error;
    REQUIRE(controller_set_state(ControllerKind::Meteo, "room", true, error)
            == SocketResult::InvalidInput);
    REQUIRE(controller_set_state_until(ControllerKind::Meteo, "room", true, 20000, error)
            == SocketResult::InvalidInput);
    const auto revision = module_revision(ControllerKind::Meteo);
    socket_test::fail_commit();
    const auto calls = meteo_fake::configure_calls();
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room", "sens-0/2") + "]")
            == SocketResult::StorageError);
    REQUIRE(module_revision(ControllerKind::Meteo) == revision);
    REQUIRE(meteo_fake::configure_calls() == calls);
    reboot();
    REQUIRE(state() && module_state(ControllerKind::Lights));
    m = module(ControllerKind::Meteo);
    REQUIRE(std::string(cJSON_GetStringValue(field(item(m.get()), "portId"))) == "sens-0/1");
    REQUIRE(module_revision(ControllerKind::Meteo) == revision);
    Json all(controllers_status_json(), cJSON_Delete);
    REQUIRE(all && field(all.get(), "meteo"));
    REQUIRE(
        std::string(cJSON_GetStringValue(field(resource(all.get(), "sens-0/1"), "ownerController")))
        == "meteo");
}

void meteo_resources()
{
    start();
    auto a = sensor_rom(1), b = sensor_rom(2);
    const auto rows = "[" + meteo_row("a", "sens-0/1", "onewire", a) + ","
                      + meteo_row("b", "sens-0/1", "onewire", b) + "]";
    REQUIRE(module_update(ControllerKind::Meteo, rows, false) == SocketResult::Ok);
    REQUIRE(!meteo_fake::enabled());
    REQUIRE(meteo_fake::configured().size() == 1);
    REQUIRE(meteo_fake::configured()[0].type == MeteoSensorType::OneWire);
    Json all(controllers_status_json(), cJSON_Delete);
    REQUIRE(!boolean(resource(all.get(), "sens-0/1"), "conflict"));
    REQUIRE(std::string(cJSON_GetStringValue(field(resource(all.get(), "sens-0/1"), "ownerId")))
            == "a");
    const auto rev = module_revision(ControllerKind::Meteo), commits = socket_test::commits();
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("a") + "," + meteo_row("b") + "]")
            == SocketResult::Conflict);
    REQUIRE(
        module_update(ControllerKind::Meteo,
                      "[" + meteo_row("a") + "," + meteo_row("b", "sens-0/1", "onewire", b) + "]")
        == SocketResult::Conflict);
    REQUIRE(module_update(ControllerKind::Meteo,
                          "[" + meteo_row("a", "sens-0/1", "onewire", a) + ","
                              + meteo_row("b", "sens-0/1", "onewire", a) + "]")
            == SocketResult::Conflict);
    REQUIRE(module_revision(ControllerKind::Meteo) == rev && socket_test::commits() == commits);
    for (const auto& bad :
         std::vector<std::string>{meteo_row("x", "sens-0/99"),
                                  meteo_row("x", "sens-0/1", "ds18b20", a),
                                  meteo_row("x", "sens-0/1", "onewire", ""),
                                  meteo_row("x", "sens-0/1", "onewire", "2800000000000000"),
                                  meteo_row("x", "sens-0/1", "dht22", a)})
        REQUIRE(module_update(ControllerKind::Meteo, "[" + bad + "]")
                == SocketResult::InvalidInput);
    auto upper = b;
    for (auto& c : upper)
        if (c >= 'a' && c <= 'f')
            c -= 32;
    REQUIRE(module_update(ControllerKind::Meteo,
                          "[" + meteo_row("b", "sens-0/1", "onewire", upper) + "]")
            == SocketResult::Ok);
    auto m = module(ControllerKind::Meteo);
    REQUIRE(std::string(cJSON_GetStringValue(field(item(m.get()), "address"))) == b);
}

void meteo_readings()
{
    start();
    const auto a = sensor_rom(1), b = sensor_rom(2);
    const auto rows = "[" + meteo_row("a", "sens-0/1", "onewire", a) + ","
                      + meteo_row("b", "sens-0/1", "onewire", b) + ","
                      + meteo_row("humidity", "sens-0/2") + "]";
    REQUIRE(module_update(ControllerKind::Meteo, rows) == SocketResult::Ok);
    const auto now = esp_timer_get_time() / 1000;
    MeteoPortReading bus;
    bus.available = true;
    bus.lastSuccessMs = now;
    bus.devices = {{a, true, 21.25, now, ""}, {b, true, -5.5, now, ""}};
    meteo_fake::reading("sens-0/1", bus);
    MeteoPortReading dht;
    dht.available = true;
    dht.temperatureC = 25.5;
    dht.humidityPct = 56.25;
    dht.lastSuccessMs = now;
    meteo_fake::reading("sens-0/2", dht);
    auto m = module(ControllerKind::Meteo);
    REQUIRE(boolean(item(m.get(), 0), "available") && boolean(item(m.get(), 1), "available"));
    REQUIRE(field(item(m.get(), 0), "temperatureC")->valuedouble == 21.25);
    REQUIRE(field(item(m.get(), 1), "temperatureC")->valuedouble == -5.5);
    REQUIRE(cJSON_IsNull(field(item(m.get(), 0), "humidityPct")));
    REQUIRE(cJSON_GetArraySize(field(item(m.get(), 0), "devices")) == 2);
    REQUIRE(field(item(m.get(), 2), "humidityPct")->valuedouble == 56.25);
    REQUIRE(cJSON_GetArraySize(field(item(m.get(), 2), "devices")) == 0);
    bus.devices[0].available = false;
    bus.devices[0].error = "CRC failure";
    meteo_fake::reading("sens-0/1", bus);
    m = module(ControllerKind::Meteo);
    REQUIRE(!boolean(item(m.get(), 0), "available")
            && cJSON_IsNull(field(item(m.get(), 0), "temperatureC")));
    REQUIRE(boolean(item(m.get(), 1), "available"));
    socket_test::advance(16'000'000);
    m = module(ControllerKind::Meteo);
    REQUIRE(!boolean(item(m.get(), 1), "available") && !boolean(item(m.get(), 2), "available"));
    REQUIRE(cJSON_IsNull(field(item(m.get(), 1), "temperatureC")));
    REQUIRE(field(item(m.get(), 1), "ageMs")->valuedouble == 16000);
    REQUIRE(module_update(ControllerKind::Meteo, rows, false) == SocketResult::Ok);
    m = module(ControllerKind::Meteo);
    REQUIRE(!boolean(item(m.get(), 0), "available"));
}

void meteo_scan()
{
    start();
    const auto rows = "[" + meteo_row("room") + "]";
    REQUIRE(module_update(ControllerKind::Meteo, rows, false) == SocketResult::Ok);
    const auto rev = module_revision(ControllerKind::Meteo), commits = socket_test::commits();
    const auto calls = meteo_fake::scan_calls();
    auto scan = [&](const std::string& port,
                    bool refresh = false,
                    const std::string& id = "",
                    unsigned base = 0) {
        cJSON* out = nullptr;
        std::string error;
        const auto result = controller_meteo_scan(port, refresh, out, error, id, base);
        Json json(out, cJSON_Delete);
        if (result == SocketResult::Ok) {
            REQUIRE(json && boolean(json.get(), "ok"));
        } else
            REQUIRE(!json);
        return result;
    };
    REQUIRE(scan("sens-0/1") == SocketResult::Conflict);
    REQUIRE(scan("sens-0/1", true, "other", rev) == SocketResult::Conflict);
    REQUIRE(scan("sens-0/1", true, "room", rev + 1) == SocketResult::Conflict);
    REQUIRE(meteo_fake::scan_calls() == calls);
    REQUIRE(scan("sens-0/1", true, "room", rev) == SocketResult::Ok);
    REQUIRE(scan("sens-0/2") == SocketResult::Ok);
    REQUIRE(scan("sens-0/99") == SocketResult::NotFound);
    REQUIRE(module_revision(ControllerKind::Meteo) == rev && socket_test::commits() == commits);
    REQUIRE(meteo_fake::configured()[0].type == MeteoSensorType::Dht22);
    MeteoScanSnapshot complete;
    complete.complete = true;
    complete.devices = {{sensor_rom(1), false, 0, -1, ""}};
    meteo_fake::scan("sens-0/2", complete);
    cJSON* output = nullptr;
    std::string error;
    REQUIRE(controller_meteo_scan("sens-0/2", false, output, error) == SocketResult::Ok);
    Json json(output, cJSON_Delete);
    REQUIRE(boolean(json.get(), "complete") && !boolean(json.get(), "busy"));
    REQUIRE(cJSON_GetArraySize(field(json.get(), "devices")) == 1);
    REQUIRE(module_update(ControllerKind::Meteo,
                          "[" + meteo_row("room", "sens-0/1", "onewire", sensor_rom(1)) + "]")
            == SocketResult::Ok);
    REQUIRE(scan("sens-0/1") == SocketResult::Ok);
}

std::string thermostat_row(const std::string& id = "heat",
                           const std::string& relay = "rly-0/1",
                           const std::string& source = "room",
                           const std::string& mode = "heating",
                           double setpoint = 22,
                           double hysteresis = 2,
                           const std::string& input = "")
{
    return "{\"id\":\"" + id + "\",\"name\":\"" + id + "\",\"relayId\":\"" + relay
           + "\",\"meteoId\":\"" + source + "\",\"inputId\":\"" + input + "\",\"mode\":\"" + mode
           + "\",\"setpointC\":" + std::to_string(setpoint)
           + ",\"hysteresisC\":" + std::to_string(hysteresis) + "}";
}

void thermostat_start()
{
    start();
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room") + "]")
            == SocketResult::Ok);
}

SocketResult thermostat_config(const std::string& rows = "[" + thermostat_row() + "]",
                               bool enabled = true)
{
    return module_update(ControllerKind::Thermostats, rows, enabled);
}

// Existing regulation scenarios explicitly enable each row. New flag scenarios
// use thermostat_config directly to verify the default OFF contract.
SocketResult thermostat_update(const std::string& rows = "[" + thermostat_row() + "]",
                               bool enabled = true)
{
    const auto result = thermostat_config(rows, enabled);
    if (result != SocketResult::Ok)
        return result;
    auto parsed = parse(rows);
    for (const auto* row = parsed->child; row; row = row->next) {
        std::string error;
        REQUIRE(
            controller_thermostat_set_enabled(cJSON_GetStringValue(field(row, "id")), true, error)
            == SocketResult::Ok);
    }
    return result;
}

bool demand(unsigned i = 0)
{
    return module_state(ControllerKind::Thermostats, i);
}

void raw_temperature(double value,
                     bool valid = true,
                     const std::string& port = "sens-0/1",
                     bool run = true)
{
    socket_test::advance(20'000);
    MeteoPortReading reading;
    reading.available = valid;
    reading.temperatureC = value;
    reading.humidityPct = 50;
    reading.lastSuccessMs = valid ? esp_timer_get_time() / 1000 : -1;
    if (!valid)
        reading.error = "CRC fault";
    meteo_fake::reading(port, reading);
    if (run)
        socket_controller_test_step();
}

// Legacy threshold/resource scenarios settle the real fixed protection time with
// regular successful measurements. Exact timing/fault scenarios use raw_temperature.
void temperature(double value,
                 bool valid = true,
                 const std::string& port = "sens-0/1",
                 bool run = true)
{
    raw_temperature(value, valid, port, run);
    if (!valid || !run)
        return;
    for (unsigned second = 0; second < 70; second += 5) {
        auto snapshot = module(ControllerKind::Thermostats);
        bool waiting = false;
        for (auto* row = field(snapshot.get(), "items")->child; row; row = row->next)
            waiting = waiting || field(row, "holdRemainingSeconds")->valuedouble > 0;
        if (!waiting)
            return;
        socket_test::advance(5'000'000);
        raw_temperature(value, true, port);
    }
    REQUIRE(false);  // A protection interval must expire without NVS or network involvement.
}

void hold_temperature(double value, std::int64_t us, const std::string& port = "sens-0/1")
{
    while (us > 0) {
        const auto interval = std::min<std::int64_t>(us, 1'000'000);
        REQUIRE(interval >= 20'000);
        socket_test::advance(interval - 20'000);
        raw_temperature(value, true, port);
        us -= interval;
    }
}

void thermostat_heating()
{
    thermostat_start();
    REQUIRE(thermostat_update() == SocketResult::Ok);
    const auto commits = socket_test::commits(), rev = module_revision(ControllerKind::Thermostats);
    temperature(21);
    REQUIRE(!demand() && !socket_test::relay(0));
    temperature(20);
    REQUIRE(demand() && socket_test::relay(0));
    temperature(21.9);
    REQUIRE(demand());
    temperature(22);
    REQUIRE(!demand());
    temperature(20.1);
    REQUIRE(!demand());
    temperature(20);
    REQUIRE(demand());
    REQUIRE(
        thermostat_update("[" + thermostat_row("heat", "rly-0/1", "room", "heating", 23, 3) + "]")
        == SocketResult::Ok);
    temperature(21.5);
    REQUIRE(demand());  // Healthy edit holds inside new band.
    const auto after_edit = socket_test::commits();
    for (int i = 0; i < 50; ++i) {
        temperature(i % 2 ? 23 : 20);
        REQUIRE(demand() == (i % 2 == 0));
    }
    REQUIRE(socket_test::commits() == after_edit);
    REQUIRE(after_edit == commits + 2);  // New config: one FRAM seed and one NVS commit.
    REQUIRE(module_revision(ControllerKind::Thermostats) == rev + 1);
    temperature(20);
    REQUIRE(demand());
    meteo_fake::reset();
    reboot();
    REQUIRE(!demand() && !socket_test::relay(0));
    temperature(21.5);
    REQUIRE(!demand());
    temperature(20);
    REQUIRE(demand());
}

void thermostat_cooling_shared()
{
    thermostat_start();
    const auto rows = "[" + thermostat_row("heat") + ","
                      + thermostat_row("cool", "rly-0/2", "room", "cooling") + "]";
    REQUIRE(thermostat_update(rows) == SocketResult::Ok);
    const auto commits = socket_test::commits();
    temperature(23);
    REQUIRE(!demand(0) && !demand(1));
    temperature(24);
    REQUIRE(!demand(0) && demand(1));
    temperature(22.1);
    REQUIRE(demand(1));
    temperature(22);
    REQUIRE(!demand(1));
    temperature(20);
    REQUIRE(demand(0) && !demand(1));
    temperature(21.9);
    REQUIRE(demand(0) && !demand(1));
    temperature(22);
    REQUIRE(!demand(0) && !demand(1));
    REQUIRE(socket_test::commits() == commits);
    Json all(controllers_status_json(), cJSON_Delete);
    REQUIRE(
        std::string(cJSON_GetStringValue(field(resource(all.get(), "rly-0/1"), "ownerController")))
        == "thermostats");
    REQUIRE(
        std::string(cJSON_GetStringValue(field(resource(all.get(), "sens-0/1"), "ownerController")))
        == "meteo");
    REQUIRE(!boolean(resource(all.get(), "sens-0/1"), "conflict"));
}

void thermostat_faults()
{
    thermostat_start();
    REQUIRE(thermostat_update() == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    temperature(20, false);
    REQUIRE(demand()
            && socket_test::relay(
                0));  // Last valid sample remains inside its original freshness budget.
    temperature(22);
    REQUIRE(!demand());
    temperature(20);
    REQUIRE(demand());
    socket_test::advance(15'001'000);
    socket_controller_test_step();
    REQUIRE(!demand() && !socket_test::relay(0));
    auto s = module(ControllerKind::Thermostats);
    REQUIRE(!boolean(item(s.get()), "sensorAvailable")
            && cJSON_IsNull(field(item(s.get()), "temperatureC")));
    temperature(21);
    REQUIRE(!demand());
    temperature(20);
    REQUIRE(demand());
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room") + "]", false)
            == SocketResult::Ok);
    step(20'000);
    REQUIRE(!demand() && !socket_test::relay(0));
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room") + "]")
            == SocketResult::Ok);
    temperature(21);
    REQUIRE(!demand());
    temperature(20);
    REQUIRE(demand());
    REQUIRE(module_update(ControllerKind::Meteo, "[]") == SocketResult::Ok);
    step(20'000);
    REQUIRE(!demand() && !socket_test::relay(0));
    s = module(ControllerKind::Thermostats);
    REQUIRE(std::string(cJSON_GetStringValue(field(item(s.get()), "meteoId"))) == "room");
    REQUIRE(!boolean(item(s.get()), "sensorAvailable"));
    REQUIRE(
        thermostat_update("[" + thermostat_row("heat", "rly-0/1", "room", "heating", 24, 3) + "]")
        == SocketResult::Ok);
    REQUIRE(thermostat_update("[" + thermostat_row("other", "rly-0/2", "room") + "]")
            == SocketResult::InvalidInput);
    REQUIRE(thermostat_update("[" + thermostat_row("heat", "rly-0/1", "missing") + "]")
            == SocketResult::InvalidInput);
    meteo_fake::reset();
    reboot();
    REQUIRE(!demand() && !socket_test::relay(0));
}

void thermostat_source_binding()
{
    thermostat_start();
    REQUIRE(thermostat_update() == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    auto renamed = parse(meteo_row("room"));
    cJSON_ReplaceItemInObject(renamed.get(), "name", cJSON_CreateString("Renamed"));
    char* encoded = cJSON_PrintUnformatted(renamed.get());
    REQUIRE(encoded);
    const auto row = std::string(encoded);
    cJSON_free(encoded);
    REQUIRE(module_update(ControllerKind::Meteo, "[" + row + "]") == SocketResult::Ok);
    step(20'000);
    REQUIRE(demand());
    temperature(20, true, "sens-0/2", false);  // Cache is fresh, but from before the port edit.
    socket_test::advance(2'000);
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room", "sens-0/2") + "]")
            == SocketResult::Ok);
    step(20'000);
    REQUIRE(!demand() && !socket_test::relay(0));
    auto s = module(ControllerKind::Thermostats);
    REQUIRE(!boolean(item(s.get()), "sensorAvailable"));
    temperature(21, true, "sens-0/2");
    REQUIRE(!demand());
    temperature(20, true, "sens-0/2");
    REQUIRE(demand());
    const auto rom = sensor_rom(1);
    REQUIRE(module_update(ControllerKind::Meteo,
                          "[" + meteo_row("room", "sens-0/2", "onewire", rom) + "]")
            == SocketResult::Ok);
    step(20'000);
    REQUIRE(!demand());
    socket_test::advance(20'000);
    const auto now = esp_timer_get_time() / 1000;
    MeteoPortReading bus;
    bus.available = true;
    bus.devices = {{rom, true, 20, now, ""}};
    meteo_fake::reading("sens-0/2", bus);
    socket_controller_test_step();
    REQUIRE(!demand());
    for (unsigned i = 0; i < 61; ++i) {
        socket_test::advance(1'000'000);
        bus.devices[0].lastSuccessMs = esp_timer_get_time() / 1000;
        meteo_fake::reading("sens-0/2", bus);
        socket_controller_test_step();
    }
    REQUIRE(demand());
}

void thermostat_validation()
{
    thermostat_start();
    const std::vector<std::string> invalid = {
        thermostat_row("heat", "rly-0/99"),
        thermostat_row("heat", "rly-0/1", "missing"),
        thermostat_row("heat", "rly-0/1", "room", "other"),
        thermostat_row("heat", "rly-0/1", "room", "heating", -55.1),
        thermostat_row("heat", "rly-0/1", "room", "heating", 125.1),
        thermostat_row("heat", "rly-0/1", "room", "heating", 22.11),
        thermostat_row("heat", "rly-0/1", "room", "heating", 22, .1),
        thermostat_row("heat", "rly-0/1", "room", "heating", 22, 1.5),
        thermostat_row("heat", "rly-0/1", "room", "heating", 22, 21)};
    for (const auto& row : invalid)
        REQUIRE(thermostat_update("[" + row + "]") == SocketResult::InvalidInput);
    REQUIRE(thermostat_update() == SocketResult::Ok);
    auto request =
        parse("{\"baseRevision\":999,\"enabled\":true,\"items\":[" + thermostat_row() + "]}");
    std::string error;
    REQUIRE(controller_update(ControllerKind::Thermostats, request.get(), error)
            == SocketResult::Conflict);
    REQUIRE(controller_set_state(ControllerKind::Thermostats, "heat", true, error)
            == SocketResult::InvalidInput);
    REQUIRE(socket_controller_set_relay("rly-0/1", true, error) == SocketResult::Conflict);
    REQUIRE(module_update(ControllerKind::Sockets, one) == SocketResult::Conflict);
    REQUIRE(thermostat_update("[" + thermostat_row("a") + "," + thermostat_row("b") + "]")
            == SocketResult::Conflict);
    REQUIRE(
        thermostat_update("[" + thermostat_row("a") + "," + thermostat_row("a", "rly-0/2") + "]")
        == SocketResult::InvalidInput);
    REQUIRE(thermostat_update("[" + thermostat_row() + "]", false) == SocketResult::Ok);
    REQUIRE(socket_controller_set_relay("rly-0/1", true, error) == SocketResult::Conflict);
    REQUIRE(
        thermostat_update("[" + thermostat_row("heat", "rly-0/1", "room", "heating", -55, 20) + "]")
        == SocketResult::Ok);
    REQUIRE(
        thermostat_update("[" + thermostat_row("heat", "rly-0/1", "room", "cooling", 125, 1) + "]")
        == SocketResult::Ok);
}

void thermostat_safe_config()
{
    thermostat_start();
    REQUIRE(thermostat_update() == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    const auto rev = module_revision(ControllerKind::Thermostats);
    socket_test::fail_commit();
    REQUIRE(thermostat_update("[" + thermostat_row() + "]", false) == SocketResult::StorageError);
    REQUIRE(!demand() && !socket_test::relay(0)
            && module_revision(ControllerKind::Thermostats) == rev);
    temperature(20);
    REQUIRE(demand() && socket_test::relay(0));
    socket_test::fail_commit();
    REQUIRE(thermostat_update("[" + thermostat_row("heat", "rly-0/2") + "]")
            == SocketResult::StorageError);
    REQUIRE(!demand() && !socket_test::relay(0) && !socket_test::relay(1));
    temperature(20);
    REQUIRE(demand() && socket_test::relay(0));
    REQUIRE(thermostat_update("[" + thermostat_row("heat", "rly-0/2") + "]") == SocketResult::Ok);
    REQUIRE(!demand() && !socket_test::relay(0) && !socket_test::relay(1));
    step(20'000);
    REQUIRE(!demand() && !socket_test::relay(1));
    temperature(20);
    REQUIRE(demand() && socket_test::relay(1));
    REQUIRE(thermostat_update("[]") == SocketResult::Ok);
    REQUIRE(!socket_test::relay(1));
}

void thermostat_hardware_recovery()
{
    thermostat_start();
    REQUIRE(thermostat_update() == SocketResult::Ok);
    socket_test::fail_write_after_apply();
    temperature(20);
    REQUIRE(!demand() && !socket_test::relay(0));
    auto s = module(ControllerKind::Thermostats);
    REQUIRE(std::string(cJSON_GetStringValue(field(item(s.get()), "error"))).size() > 0);
    socket_test::advance(1'100'000);
    temperature(20);
    REQUIRE(demand());
    socket_test::relay_valid(0, false);
    step(20'000);
    REQUIRE(!demand());
    s = module(ControllerKind::Thermostats);
    REQUIRE(cJSON_IsNull(field(item(s.get()), "actual")));
    socket_test::relay_valid(0, true);
    temperature(21);
    REQUIRE(!demand() && !socket_test::relay(0));
    temperature(20);
    REQUIRE(demand());
    socket_test::physical_relay(0, false);
    temperature(21);
    REQUIRE(!demand() && !socket_test::relay(0));
    socket_test::physical_relay(0, true);
    temperature(21);
    REQUIRE(!demand() && !socket_test::relay(0));
}

void thermostat_expiry()
{
    thermostat_start();
    REQUIRE(thermostat_update() == SocketResult::Ok);
    hold_temperature(23, 61'000'000);
    temperature(20, true, "sens-0/1", false);
    const auto commits = socket_test::commits();
    socket_test::advance(14'900'000);
    socket_test::advance_on_relay_read(200'000);
    socket_controller_test_step();
    REQUIRE(!demand() && !socket_test::relay(0));
    temperature(20, true, "sens-0/1", false);
    socket_test::advance(14'900'000);
    socket_test::advance_on_relay_write(200'000);
    socket_controller_test_step();
    REQUIRE(!demand() && !socket_test::relay(0));
    REQUIRE(socket_test::commits() == commits);
    for (const auto& event : socket_test::events())
        REQUIRE(event != "relay:rly-0/1:on");
}

void thermostat_failed_update_expiry()
{
    thermostat_start();
    REQUIRE(thermostat_update() == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    const auto revision = module_revision(ControllerKind::Thermostats);
    auto event_begin = socket_test::events().size();
    socket_test::advance_on_commit(16'000'000);
    socket_test::fail_commit();
    REQUIRE(thermostat_update("[" + thermostat_row() + "]", false) == SocketResult::StorageError);
    REQUIRE(!demand() && !socket_test::relay(0));
    REQUIRE(module_revision(ControllerKind::Thermostats) == revision);
    auto events = socket_test::events();
    for (std::size_t i = event_begin; i < events.size(); ++i)
        REQUIRE(events[i] != "relay:rly-0/1:on");
    step(20'000);
    REQUIRE(!demand() && !socket_test::relay(0));
    temperature(20);
    REQUIRE(demand());
    event_begin = socket_test::events().size();
    socket_test::advance_on_relay_write(16'000'000);
    socket_test::fail_write_after_apply();
    REQUIRE(thermostat_update("[" + thermostat_row() + "]", false) == SocketResult::Unavailable);
    REQUIRE(!demand() && !socket_test::relay(0));
    events = socket_test::events();
    for (std::size_t i = event_begin; i < events.size(); ++i)
        REQUIRE(events[i] != "relay:rly-0/1:on");
    step(20'000);
    REQUIRE(!demand() && !socket_test::relay(0));
}

bool thermostat_flag(const char* key = "enabled", unsigned i = 0)
{
    auto s = module(ControllerKind::Thermostats);
    return boolean(item(s.get(), i), key);
}

SocketResult thermostat_switch(bool enabled, const std::string& id = "heat")
{
    std::string error;
    return controller_thermostat_set_enabled(id, enabled, error);
}

std::string thermostat_button_row(const std::string& relay = "rly-0/1",
                                  const std::string& source = "room",
                                  const std::string& mode = "heating",
                                  const std::string& input = "in-0/1")
{
    return thermostat_row("heat", relay, source, mode, 22, 2, input);
}

void thermostat_item_switch()
{
    thermostat_start();
    REQUIRE(thermostat_config() == SocketResult::Ok);
    const auto rev = module_revision(ControllerKind::Thermostats);
    temperature(20);
    REQUIRE(!thermostat_flag() && !demand() && !socket_test::relay(0));
    const auto commits = socket_test::commits();
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    REQUIRE(thermostat_flag() && !demand() && !socket_test::relay(0));
    REQUIRE(module_revision(ControllerKind::Thermostats) == rev
            && socket_test::commits() == commits + 1);
    step(20'000);
    REQUIRE(!demand());
    temperature(20);
    REQUIRE(demand());
    REQUIRE(thermostat_switch(false) == SocketResult::Ok);
    REQUIRE(!thermostat_flag() && !demand() && !socket_test::relay(0));
    const auto off_commits = socket_test::commits();
    REQUIRE(thermostat_switch(false) == SocketResult::Ok);
    REQUIRE(socket_test::commits() == off_commits);
    meteo_fake::reset();
    reboot();
    REQUIRE(!thermostat_flag());
    temperature(20);
    REQUIRE(!demand());
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    meteo_fake::reset();
    reboot();
    REQUIRE(thermostat_flag() && !demand());
    temperature(21);
    REQUIRE(!demand());
    temperature(20);
    REQUIRE(demand());
    REQUIRE(module_revision(ControllerKind::Thermostats) == rev);
}

void thermostat_item_buttons()
{
    thermostat_start();
    socket_test::input(0, false);
    REQUIRE(thermostat_config("[" + thermostat_button_row() + "]") == SocketResult::Ok);
    temperature(20);
    for (int i = 0; i < 5; ++i)
        step();
    REQUIRE(!thermostat_flag());
    socket_test::input(0, true);
    step(20'000);
    step(60'000);
    const auto before = socket_test::commits();
    socket_test::input(0, false);
    step(20'000);
    step(20'000);
    step(20'000);
    REQUIRE(thermostat_flag() && !demand());
    temperature(20);
    REQUIRE(demand());
    socket_test::input(0, true);
    step(10'000);
    socket_test::input(0, false);
    step(10'000);
    step(20'000);
    step(20'000);
    for (int i = 0; i < 100; ++i)
        step();
    REQUIRE(thermostat_flag());
    REQUIRE(socket_test::commits() == before + 1);  // A held LOW saves once.
    socket_test::input(0, true);
    step(20'000);
    step(60'000);
    socket_test::input(0, false);
    step(20'000);
    step(20'000);
    step(20'000);
    REQUIRE(!thermostat_flag() && !demand());
    REQUIRE(thermostat_config("[" + thermostat_button_row() + "]", false) == SocketResult::Ok);
    socket_test::input(0, true);
    step();
    step();
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(!thermostat_flag());
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    step();
    REQUIRE(thermostat_flag() && !demand());
    REQUIRE(thermostat_config("[" + thermostat_button_row() + "]") == SocketResult::Ok);
    step(20'000);
    REQUIRE(thermostat_flag());  // Held LOW when master resumes is only a baseline.
    socket_test::input(0, true);
    step(20'000);
    step(60'000);
    socket_test::input(0, false);
    step(20'000);
    step(20'000);
    step(20'000);
    REQUIRE(!thermostat_flag());
}

void thermostat_item_input_fault()
{
    thermostat_start();
    REQUIRE(thermostat_config("[" + thermostat_button_row() + "]") == SocketResult::Ok);
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    socket_test::input(0, false, false);
    temperature(20);
    auto s = module(ControllerKind::Thermostats);
    REQUIRE(!boolean(item(s.get()), "inputAvailable")
            && cJSON_IsNull(field(item(s.get()), "inputLevel")));
    REQUIRE(std::string(cJSON_GetStringValue(field(item(s.get()), "inputError"))).size() > 0);
    REQUIRE(thermostat_flag() && demand());
    REQUIRE(thermostat_switch(false) == SocketResult::Ok);
    REQUIRE(!thermostat_flag() && !demand());
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    socket_test::input(0, false, true);
    step();
    step();
    REQUIRE(thermostat_flag());
    socket_test::input(0, true);
    step();
    step();
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(!thermostat_flag());
    temperature(20, false);
    socket_test::input(0, true);
    step();
    step();
    step(300'000);
    socket_test::input(0, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(thermostat_flag() && !demand());  // Permission cannot bypass the fixed minimum OFF.
    auto cached = module(ControllerKind::Thermostats);
    REQUIRE(boolean(item(cached.get()), "sensorAvailable"));
    step(15'100'000);
    REQUIRE(thermostat_flag() && !demand());  // Permission stays enabled after the sample expires.
}

void thermostat_item_claims_config()
{
    thermostat_start();
    REQUIRE(thermostat_config("[" + thermostat_button_row() + "]") == SocketResult::Ok);
    REQUIRE(!thermostat_flag());
    REQUIRE(module_update(ControllerKind::Sockets,
                          R"([{"id":"s","name":"S","relayId":"rly-0/2","inputId":"in-0/1"}])")
            == SocketResult::Conflict);
    REQUIRE(module_update(ControllerKind::Lights,
                          R"([{"id":"l","name":"L","relayId":"rly-0/2","inputId":"in-0/1"}])")
            == SocketResult::Conflict);
    REQUIRE(thermostat_config(
                "[" + thermostat_button_row() + ","
                + thermostat_row("other", "rly-0/2", "room", "cooling", 22, 2, "in-0/1") + "]")
            == SocketResult::Conflict);
    REQUIRE(thermostat_config("[" + thermostat_button_row("rly-0/1", "room", "heating", "in-0/99")
                              + "]")
            == SocketResult::InvalidInput);
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    const auto rev = module_revision(ControllerKind::Thermostats);
    REQUIRE(
        thermostat_config("[" + thermostat_button_row("rly-0/2", "room", "cooling", "in-0/2") + "]")
        == SocketResult::Ok);
    REQUIRE(thermostat_flag() && module_revision(ControllerKind::Thermostats) == rev + 1);
    auto row = parse(thermostat_button_row("rly-0/2", "room", "cooling", "in-0/2"));
    cJSON_AddBoolToObject(row.get(), "enabled", false);
    char* raw = cJSON_PrintUnformatted(row.get());
    REQUIRE(raw);
    const auto invalid = std::string(raw);
    cJSON_free(raw);
    REQUIRE(thermostat_config("[" + invalid + "]") == SocketResult::InvalidInput);
    REQUIRE(thermostat_flag());
    REQUIRE(thermostat_config("[" + thermostat_row("new", "rly-0/3") + "]") == SocketResult::Ok);
    REQUIRE(!thermostat_flag());
}

void thermostat_item_storage_inhibit()
{
    thermostat_start();
    REQUIRE(thermostat_config() == SocketResult::Ok);
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    const auto rev = module_revision(ControllerKind::Thermostats);
    const auto begin = socket_test::events().size();
    socket_test::advance_on_commit(16'000'000);
    socket_test::fail_fram_commit();
    REQUIRE(thermostat_switch(false) == SocketResult::StorageError);
    REQUIRE(thermostat_flag() && thermostat_flag("inhibited") && !demand()
            && !socket_test::relay(0));
    const auto events = socket_test::events();
    for (std::size_t i = begin; i < events.size(); ++i)
        REQUIRE(events[i] != "relay:rly-0/1:on");
    for (int i = 0; i < 10; ++i)
        temperature(20);
    REQUIRE(!demand());
    REQUIRE(module_revision(ControllerKind::Thermostats) == rev);
    REQUIRE(
        thermostat_config("[" + thermostat_button_row("rly-0/2", "room", "cooling", "in-0/2") + "]")
        == SocketResult::Ok);
    REQUIRE(thermostat_flag() && thermostat_flag("inhibited"));
    temperature(24);
    REQUIRE(!demand());
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    REQUIRE(!thermostat_flag("inhibited"));
    temperature(24);
    REQUIRE(demand());
    REQUIRE(thermostat_switch(false) == SocketResult::Ok);
    socket_test::fail_fram_commit();
    REQUIRE(thermostat_switch(true) == SocketResult::StorageError);
    REQUIRE(!thermostat_flag() && thermostat_flag("inhibited") && !demand());
    REQUIRE(thermostat_switch(false) == SocketResult::Ok);
    REQUIRE(!thermostat_flag("inhibited") && !thermostat_flag());
    // Failure consumes a physical press, without resetting its lockout.
    socket_test::input(1, true);
    step();
    socket_test::fail_fram_commit();
    socket_test::input(1, false);
    step();
    step(20'000);
    step(20'000);
    REQUIRE(thermostat_flag("inhibited") && !thermostat_flag());
    const auto count = socket_test::commits();
    for (int i = 0; i < 20; ++i)
        step();
    REQUIRE(socket_test::commits() == count && !thermostat_flag());
}

void thermostat_item_expiry()
{
    thermostat_start();
    REQUIRE(thermostat_config() == SocketResult::Ok);
    std::string error;
    const auto now = esp_timer_get_time() / 1000;
    const auto commits = socket_test::commits();
    REQUIRE(controller_thermostat_set_enabled_until("heat", true, now, error)
            == SocketResult::Conflict);
    REQUIRE(!thermostat_flag() && !thermostat_flag("inhibited"));
    socket_test::advance_on_relay_read(200'000);
    REQUIRE(controller_thermostat_set_enabled_until("heat", true, now + 100, error)
            == SocketResult::Conflict);
    REQUIRE(!thermostat_flag() && !thermostat_flag("inhibited")
            && socket_test::commits() == commits);
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    const auto before = socket_test::commits();
    const auto deadline = esp_timer_get_time() / 1000 + 100;
    socket_test::advance_on_relay_write(200'000);
    REQUIRE(controller_thermostat_set_enabled_until("heat", false, deadline, error)
            == SocketResult::Conflict);
    REQUIRE(thermostat_flag() && thermostat_flag("inhibited") && !demand() && !socket_test::relay(0)
            && socket_test::commits() == before);
    const auto accept = esp_timer_get_time() / 1000 + 100;
    socket_test::advance_on_commit(200'000);
    REQUIRE(controller_thermostat_set_enabled_until("heat", true, accept, error)
            == SocketResult::Ok);
    REQUIRE(thermostat_flag() && !thermostat_flag("inhibited"));
    temperature(20);
    REQUIRE(demand());
    socket_test::advance(1'000'000);
    temperature(20);
    REQUIRE(demand());  // Deadline is not a regulation lease.
}

void thermostat_item_mqtt()
{
    thermostat_start();
    REQUIRE(thermostat_config("[" + thermostat_row("socket-1", "rly-0/3") + "]")
            == SocketResult::Ok);
    configure();
    REQUIRE(module_update(ControllerKind::Lights,
                          R"([{"id":"socket-1","name":"L","relayId":"rly-0/2","inputId":""}])")
            == SocketResult::Ok);
    socket_mqtt_test_reset();
    const auto payload = mqtt_payload(1, true);
    auto a = mqtt(payload);
    Json b(controller_mqtt_command(ControllerKind::Lights, payload, false, "test-boot", 1000),
           cJSON_Delete);
    Json c(controller_mqtt_command(ControllerKind::Thermostats, payload, false, "test-boot", 1000),
           cJSON_Delete);
    REQUIRE(boolean(a.get(), "ok") && boolean(b.get(), "ok") && boolean(c.get(), "ok"));
    REQUIRE(thermostat_flag() && !demand() && !socket_test::relay(2));
    REQUIRE(socket_mqtt_sequence() == 1 && controller_mqtt_sequence(ControllerKind::Lights) == 1
            && controller_mqtt_sequence(ControllerKind::Thermostats) == 1);
    REQUIRE(thermostat_switch(false, "socket-1") == SocketResult::Ok);
    c.reset(
        controller_mqtt_command(ControllerKind::Thermostats, payload, false, "test-boot", 1000));
    REQUIRE(boolean(c.get(), "duplicate") && !thermostat_flag());
    for (const auto& invalid : std::vector<std::string>{mqtt_payload(2, true, "wrong-boot"),
                                                        mqtt_payload(2, true, "test-boot", 1000)}) {
        c.reset(controller_mqtt_command(
            ControllerKind::Thermostats, invalid, false, "test-boot", 1000));
        REQUIRE(!boolean(c.get(), "ok") && !thermostat_flag());
    }
    c.reset(controller_mqtt_command(
        ControllerKind::Thermostats, mqtt_payload(2, true), true, "test-boot", 1000));
    REQUIRE(!boolean(c.get(), "ok") && !thermostat_flag());
}

void thermostat_recovery_policy()
{
    thermostat_start();
    REQUIRE(socket_test::recovery_policy_calls() == 16);
    for (unsigned i = 0; i < 16; ++i)
        REQUIRE(socket_test::recovery_policy(i) == HardwareRelayRecovery::Buffered);
    std::string error;
    REQUIRE(socket_controller_set_relay("rly-0/16", true, error) == SocketResult::Ok);
    REQUIRE(socket_test::relay(15));
    const auto initial_calls = socket_test::recovery_policy_calls();
    REQUIRE(thermostat_config("[" + thermostat_row() + "]", false) == SocketResult::Ok);
    REQUIRE(socket_test::recovery_policy_calls() == initial_calls + 16);
    REQUIRE(socket_test::recovery_policy(0) == HardwareRelayRecovery::Controller);
    REQUIRE(socket_test::recovery_policy(15) == HardwareRelayRecovery::Buffered
            && socket_test::relay(15));
    // Metadata registration must not actuate an already-ON manual relay.
    REQUIRE(hardware_io_set_relay_recovery("rly-0/16", HardwareRelayRecovery::Controller)
            == ESP_OK);
    REQUIRE(socket_test::relay(15));
    REQUIRE(hardware_io_set_relay_recovery("rly-0/16", HardwareRelayRecovery::Buffered) == ESP_OK);
    REQUIRE(socket_test::relay(15));
    const auto flag_calls = socket_test::recovery_policy_calls();
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    REQUIRE(socket_test::recovery_policy_calls() == flag_calls);
    REQUIRE(thermostat_config() == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand() && socket_test::relay(0));
    const auto calls = socket_test::recovery_policy_calls();
    socket_test::fail_commit();
    REQUIRE(thermostat_config("[" + thermostat_row("heat", "rly-0/2") + "]")
            == SocketResult::StorageError);
    REQUIRE(socket_test::recovery_policy_calls() == calls);
    REQUIRE(socket_test::recovery_policy(0) == HardwareRelayRecovery::Controller
            && socket_test::recovery_policy(1) == HardwareRelayRecovery::Buffered);
    temperature(20);
    REQUIRE(demand());
    const auto begin = socket_test::events().size();
    REQUIRE(thermostat_config("[" + thermostat_row("heat", "rly-0/2") + "]") == SocketResult::Ok);
    REQUIRE(!socket_test::relay(0) && !socket_test::relay(1));
    REQUIRE(socket_test::recovery_policy(0) == HardwareRelayRecovery::Buffered
            && socket_test::recovery_policy(1) == HardwareRelayRecovery::Controller);
    REQUIRE(socket_test::relay(15));
    const auto events = socket_test::events();
    std::size_t off = events.size(), commit = events.size(), release = events.size();
    for (std::size_t i = begin; i < events.size(); ++i) {
        if (events[i] == "relay:rly-0/1:off" && off == events.size())
            off = i;
        if (events[i] == "commit" && commit == events.size())
            commit = i;
        if (events[i] == "policy:rly-0/1:buffered" && release == events.size())
            release = i;
    }
    REQUIRE(off < commit && commit < release && release < events.size());
    REQUIRE(thermostat_config("[" + thermostat_row("heat", "rly-0/2") + "]", false)
            == SocketResult::Ok);
    REQUIRE(thermostat_switch(false) == SocketResult::Ok);
    REQUIRE(socket_test::recovery_policy(1) == HardwareRelayRecovery::Controller);
    REQUIRE(thermostat_config("[]", false) == SocketResult::Ok);
    REQUIRE(socket_test::recovery_policy(1) == HardwareRelayRecovery::Buffered
            && !socket_test::relay(1));
    REQUIRE(thermostat_config("[" + thermostat_row("heat", "rly-0/3") + "]", false)
            == SocketResult::Ok);
    REQUIRE(hardware_io_set_relay_recovery("rly-0/3", HardwareRelayRecovery::Buffered) == ESP_OK);
    const auto before_boot = socket_test::recovery_policy_calls();
    reboot();
    REQUIRE(socket_test::recovery_policy_calls() == before_boot + 16);
    REQUIRE(socket_test::recovery_policy(2) == HardwareRelayRecovery::Controller);
    REQUIRE(!socket_test::relay(2) && !thermostat_flag());
}

std::string dwell_row(unsigned on, unsigned off, const std::string& mode = "heating")
{
    auto row = parse(thermostat_row("heat", "rly-0/1", "room", mode));
    cJSON_AddNumberToObject(row.get(), "minOnSeconds", on);
    cJSON_AddNumberToObject(row.get(), "minOffSeconds", off);
    char* text = cJSON_PrintUnformatted(row.get());
    REQUIRE(text);
    std::string result(text);
    cJSON_free(text);
    return result;
}

void thermostat_dwell()
{
    REQUIRE(kThermostatMinimumCycleSeconds == 60);
    thermostat_start();
    // Legacy zero values must not disable either fixed interval.
    REQUIRE(thermostat_update("[" + dwell_row(0, 0) + "]") == SocketResult::Ok);
    raw_temperature(20);
    REQUIRE(!demand());
    auto snapshot = module(ControllerKind::Thermostats);
    REQUIRE(std::string(cJSON_GetStringValue(field(item(snapshot.get()), "holdReason")))
            == "minimum_off");
    hold_temperature(20, 59'000'000);
    REQUIRE(!demand());
    hold_temperature(20, 1'100'000);
    REQUIRE(demand());
    raw_temperature(23);
    REQUIRE(demand());
    hold_temperature(23, 59'000'000);
    REQUIRE(demand());
    hold_temperature(23, 1'100'000);
    REQUIRE(!demand());
    hold_temperature(20, 59'000'000);
    REQUIRE(!demand());
    hold_temperature(20, 1'100'000);
    REQUIRE(demand());
    REQUIRE(thermostat_switch(false) == SocketResult::Ok);
    REQUIRE(!demand() && !socket_test::relay(0));  // Explicit OFF bypasses minimum ON.
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    raw_temperature(20);
    REQUIRE(!demand());
    hold_temperature(20, 60'100'000);
    REQUIRE(demand());
    reboot();
    raw_temperature(20);
    REQUIRE(!demand());
    hold_temperature(20, 59'000'000);
    REQUIRE(!demand());
    hold_temperature(20, 1'100'000);
    REQUIRE(demand());
    socket_test::relay_valid(0, false);
    step(20'000);
    REQUIRE(!demand());  // Hardware fault bypasses minimum ON.
}

void thermostat_dwell_defaults()
{
    for (const std::string mode : {"heating", "cooling"}) {
        thermostat_start();
        REQUIRE(thermostat_update("[" + dwell_row(86400, 0, mode) + "]") == SocketResult::Ok);
        auto snapshot = module(ControllerKind::Thermostats);
        REQUIRE(!field(item(snapshot.get()), "minOnSeconds"));
        REQUIRE(!field(item(snapshot.get()), "minOffSeconds"));
        const double active = mode == "heating" ? 20 : 24;
        raw_temperature(active);
        hold_temperature(active, 59'000'000);
        REQUIRE(!demand());
        hold_temperature(active, 1'100'000);
        REQUIRE(demand());
        reboot();
        raw_temperature(active);
        REQUIRE(!demand());
    }
    thermostat_start();
    auto bad = parse(dwell_row(2, 3));
    cJSON_ReplaceItemInObject(bad.get(), "minOffSeconds", cJSON_CreateNumber(0.5));
    char* text = cJSON_PrintUnformatted(bad.get());
    REQUIRE(text);
    REQUIRE(thermostat_config("[" + std::string(text) + "]") == SocketResult::InvalidInput);
    cJSON_free(text);
    REQUIRE(thermostat_config("[" + dwell_row(86401, 0) + "]") == SocketResult::InvalidInput);
}

void thermostat_cached_sample()
{
    thermostat_start();
    REQUIRE(thermostat_update("[" + dwell_row(3600, 0) + "]") == SocketResult::Ok);
    temperature(20);
    REQUIRE(demand());
    const auto success = esp_timer_get_time() / 1000;
    MeteoPortReading bad;
    bad.available = false;
    bad.temperatureC =
        0;  // Driver overwrites its unsuccessful read, retaining only the success time.
    bad.humidityPct = 0;
    bad.lastSuccessMs = success;
    bad.error = "CRC error";
    meteo_fake::reading("sens-0/1", bad);
    step(20'000);
    auto s = module(ControllerKind::Thermostats);
    REQUIRE(demand() && boolean(item(s.get()), "usingCachedTemperature"));
    REQUIRE(field(item(s.get()), "temperatureC")->valuedouble == 20);
    step(14'000'000);
    REQUIRE(demand());
    step(1'100'000);
    REQUIRE(!demand() && !socket_test::relay(0));
    s = module(ControllerKind::Thermostats);
    REQUIRE(!boolean(item(s.get()), "sensorAvailable"));
    temperature(20);
    REQUIRE(demand());
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room", "sens-0/2") + "]")
            == SocketResult::Ok);
    step(20'000);
    REQUIRE(!demand());  // Cache may not cross a physical binding change.
}

void button_confirmation()
{
    start();
    configure(with_input);
    socket_test::input(0, false);
    step(20'000);
    REQUIRE(!state());
    socket_controller_test_step();
    socket_controller_test_step();
    REQUIRE(!state());  // Re-reading one cached I/O sample cannot confirm a press.
    step(20'000);
    REQUIRE(!state());
    socket_test::input(0, true);
    step(20'000);
    socket_test::input(0, false);
    step(20'000);
    step(20'000);
    REQUIRE(!state());  // A HIGH interruption resets the consecutive LOW count.
    step(20'000);
    REQUIRE(state());
    for (unsigned i = 0; i < 30; ++i)
        step(20'000);
    REQUIRE(state());  // Held LOW triggers once.
}

void fram_states()
{
    start();
    configure();
    REQUIRE(module_update(ControllerKind::Lights, light) == SocketResult::Ok);
    step();
    const auto flash_writes = socket_test::nvs_commits();
    const auto fram_writes = socket_test::fram_commits();
    const auto sockets_revision = revision();
    const auto lights_revision = module_revision(ControllerKind::Lights);
    for (unsigned i = 0; i < 20; ++i) {
        REQUIRE(command(i % 2 == 0) == SocketResult::Ok);
        REQUIRE(module_command(ControllerKind::Lights, i % 2 == 0) == SocketResult::Ok);
    }
    REQUIRE(socket_test::nvs_commits() == flash_writes);
    REQUIRE(socket_test::fram_commits() == fram_writes + 40);
    REQUIRE(revision() == sockets_revision
            && module_revision(ControllerKind::Lights) == lights_revision);
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(module_command(ControllerKind::Lights, true) == SocketResult::Ok);
    reboot();
    REQUIRE(state() && module_state(ControllerKind::Lights));
    REQUIRE(socket_test::relay(0) && socket_test::relay(1));
    REQUIRE(socket_test::nvs_commits() == flash_writes);
}

void fram_safe_boot()
{
    for (unsigned fault = 0; fault < 3; ++fault) {
        socket_controller_test_reset();
        start();
        configure();
        REQUIRE(command(true) == SocketResult::Ok);
        const auto flash_writes = socket_test::nvs_commits();
        if (fault == 0)
            socket_test::set_fram_present(false);
        else if (fault == 1)
            socket_test::corrupt_fram();
        else
            socket_test::erase_fram();
        reboot();
        REQUIRE(!socket_test::relay(0));
        REQUIRE(socket_test::nvs_commits() == flash_writes);
        if (fault == 0) {
            REQUIRE(command(true) == SocketResult::StorageError);
            REQUIRE(!socket_test::relay(0));
            REQUIRE(command(false) == SocketResult::StorageError);
            REQUIRE(!socket_test::relay(0));
            socket_test::set_fram_present(true);
        }
        const auto fram_writes = socket_test::fram_commits();
        REQUIRE(command(false) == SocketResult::Ok);
        REQUIRE(socket_test::fram_commits() > fram_writes);
        auto recovered = status();
        REQUIRE(std::string(field(item(recovered.get()), "error")->valuestring).empty());
        reboot();
        REQUIRE(!state() && !socket_test::relay(0));
        REQUIRE(socket_test::nvs_commits() == flash_writes);
    }
}

void fram_config_transaction()
{
    start();
    configure();
    REQUIRE(command(true) == SocketResult::Ok);
    const auto base = revision();
    for (unsigned i = 0; i < 3; ++i) {
        socket_test::fail_commit();
        REQUIRE(update(one, false) == SocketResult::StorageError);
        REQUIRE(revision() == base && state() && socket_test::relay(0));
    }
    reboot();
    REQUIRE(state() && socket_test::relay(0) && revision() == base);
    socket_test::fail_fram_commit();
    const auto flash_writes = socket_test::nvs_commits();
    REQUIRE(update(one, false) == SocketResult::StorageError);
    REQUIRE(socket_test::nvs_commits() == flash_writes);
    reboot();
    REQUIRE(state() && socket_test::relay(0));
}

void fram_thermostat_flags()
{
    thermostat_start();
    REQUIRE(thermostat_config() == SocketResult::Ok);
    const auto flash_writes = socket_test::nvs_commits();
    const auto fram_writes = socket_test::fram_commits();
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    REQUIRE(thermostat_flag());
    REQUIRE(thermostat_switch(false) == SocketResult::Ok);
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    REQUIRE(socket_test::nvs_commits() == flash_writes);
    REQUIRE(socket_test::fram_commits() == fram_writes + 3);
    reboot();
    REQUIRE(thermostat_flag() && !demand() && !socket_test::relay(0));
    REQUIRE(socket_test::nvs_commits() == flash_writes);
}

void fram_diagnostics()
{
    start();
    const auto probe = [] {
        Json result(controllers_probe_state_storage_json(), cJSON_Delete);
        REQUIRE(result);
        return result;
    };
    const auto number = [](const cJSON* root, const char* name) {
        const auto* value = field(root, name);
        REQUIRE(cJSON_IsNumber(value));
        return value->valuedouble;
    };
    auto empty = probe();
    REQUIRE(boolean(empty.get(), "available") && boolean(empty.get(), "valid"));
    REQUIRE(number(empty.get(), "payloadBytes") == 8);
    configure();
    REQUIRE(module_update(ControllerKind::Lights, light) == SocketResult::Ok);
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room") + "]")
            == SocketResult::Ok);
    REQUIRE(thermostat_config("[" + thermostat_row("heat", "rly-0/3") + "]") == SocketResult::Ok);
    step();
    REQUIRE(command(true) == SocketResult::Ok);
    REQUIRE(module_command(ControllerKind::Lights, true) == SocketResult::Ok);
    REQUIRE(thermostat_switch(true) == SocketResult::Ok);
    const auto flash_writes = socket_test::nvs_commits();
    const auto fram_writes = socket_test::fram_commits();
    const auto events = socket_test::events();
    std::vector<bool> levels;
    for (unsigned i = 0; i < 16; ++i)
        levels.push_back(socket_test::relay(i));
    const auto unchanged = [&] {
        REQUIRE(state() && module_state(ControllerKind::Lights) && thermostat_flag());
        REQUIRE(socket_test::nvs_commits() == flash_writes);
        REQUIRE(socket_test::fram_commits() == fram_writes);
        REQUIRE(socket_test::events() == events);
        for (unsigned i = 0; i < levels.size(); ++i)
            REQUIRE(socket_test::relay(i) == levels[i]);
    };
    auto healthy = probe();
    REQUIRE(boolean(healthy.get(), "available") && boolean(healthy.get(), "valid"));
    REQUIRE(number(healthy.get(), "capacityBytes") == 8192);
    REQUIRE(number(healthy.get(), "reservedBytes") == 512);
    REQUIRE(number(healthy.get(), "usedBytes") == 512);
    REQUIRE(number(healthy.get(), "freeBytes") == 7680);
    REQUIRE(number(healthy.get(), "payloadBytes") == 11);  // Three flags plus security state.
    REQUIRE(number(healthy.get(), "address") == 0x50);
    REQUIRE(std::string(cJSON_GetStringValue(field(healthy.get(), "model"))) == "FM24CL64B-GTR");
    REQUIRE(std::string(cJSON_GetStringValue(field(healthy.get(), "busId"))) == "io-expanders");
    unchanged();
    socket_test::set_fram_present(false);
    auto missing = probe();
    REQUIRE(!boolean(missing.get(), "available") && !boolean(missing.get(), "valid"));
    REQUIRE(number(missing.get(), "payloadBytes") == 0);
    unchanged();
    socket_test::set_fram_present(true);
    auto recovered = probe();
    REQUIRE(boolean(recovered.get(), "available") && boolean(recovered.get(), "valid"));
    REQUIRE(number(recovered.get(), "payloadBytes") == 11);
    REQUIRE(std::string(cJSON_GetStringValue(field(recovered.get(), "error"))).empty());
    unchanged();
    socket_test::corrupt_fram();
    auto corrupt = probe();
    REQUIRE(boolean(corrupt.get(), "available") && !boolean(corrupt.get(), "valid"));
    REQUIRE(number(corrupt.get(), "payloadBytes") == 0);
    unchanged();
    socket_test::erase_fram();
    auto blank = probe();
    REQUIRE(boolean(blank.get(), "available") && !boolean(blank.get(), "valid"));
    REQUIRE(number(blank.get(), "payloadBytes") == 0);
    unchanged();
}

#include "security_checks.inc"
#include "legacy_checks.inc"

}  // namespace

int main(int argc, char** argv)
{
    const std::vector<std::pair<std::string, std::function<void()>>> tests = {
        {"defaults", defaults},
        {"persistence", persistence},
        {"edges", edges},
        {"exclusive_inputs", exclusive_inputs},
        {"validation", validation},
        {"reconfigure", reconfigure},
        {"disable", disable},
        {"storage_failure", storage_failure},
        {"hardware_failure", hardware_failure},
        {"recovery", recovery},
        {"concurrent", concurrent},
        {"corrupt_storage", corrupt_storage},
        {"mqtt_set", mqtt_set},
        {"mqtt_replay", mqtt_replay},
        {"startup_low", startup_low},
        {"input_failure", input_failure},
        {"mqtt_snapshot", mqtt_snapshot},
        {"lights_basic", lights_basic},
        {"resource_exclusivity", resource_exclusivity},
        {"concurrent_claims", concurrent_claims},
        {"lights_mqtt", lights_mqtt},
        {"meteo_basic", meteo_basic},
        {"meteo_resources", meteo_resources},
        {"meteo_readings", meteo_readings},
        {"meteo_scan", meteo_scan},
        {"thermostat_heating", thermostat_heating},
        {"thermostat_cooling_shared", thermostat_cooling_shared},
        {"thermostat_faults", thermostat_faults},
        {"thermostat_source_binding", thermostat_source_binding},
        {"thermostat_validation", thermostat_validation},
        {"thermostat_safe_config", thermostat_safe_config},
        {"thermostat_hardware_recovery", thermostat_hardware_recovery},
        {"thermostat_expiry", thermostat_expiry},
        {"thermostat_failed_update_expiry", thermostat_failed_update_expiry},
        {"thermostat_item_switch", thermostat_item_switch},
        {"thermostat_item_buttons", thermostat_item_buttons},
        {"thermostat_item_input_fault", thermostat_item_input_fault},
        {"thermostat_item_claims_config", thermostat_item_claims_config},
        {"thermostat_item_storage_inhibit", thermostat_item_storage_inhibit},
        {"thermostat_item_expiry", thermostat_item_expiry},
        {"thermostat_item_mqtt", thermostat_item_mqtt},
        {"thermostat_recovery_policy", thermostat_recovery_policy},
        {"thermostat_dwell", thermostat_dwell},
        {"thermostat_dwell_defaults", thermostat_dwell_defaults},
        {"thermostat_cached_sample", thermostat_cached_sample},
        {"button_confirmation", button_confirmation},
        {"fram_states", fram_states},
        {"fram_safe_boot", fram_safe_boot},
        {"fram_config_transaction", fram_config_transaction},
        {"fram_thermostat_flags", fram_thermostat_flags},
        {"fram_diagnostics", fram_diagnostics},
        {"security_module_enable", security_module_enable},
        {"security_optional_hardware", security_optional_hardware},
        {"security_zones", security_zones},
        {"security_keys", security_keys},
        {"security_delays", security_delays},
        {"security_persistence", security_persistence},
        {"security_faults", security_faults},
        {"security_enrollment", security_enrollment},
        {"security_claims", security_claims},
        {"security_deadlines", security_deadlines},
        {"security_entry_reboot", security_entry_reboot},
        {"security_mqtt", security_mqtt},
        {"security_config_held_key", security_config_held_key},
        {"security_hub_touch", security_hub_touch},
        {"security_hub_freshness", security_hub_freshness},
        {"security_hub_fence", security_hub_fence},
        {"security_hub_busy", security_hub_busy},
        {"security_hub_failure_event", security_hub_failure_event},
        {"security_hub_contact_before_lease", security_hub_contact_before_lease},
        {"legacy_buttons", legacy_buttons},
        {"legacy_button_recovery", legacy_button_recovery},
        {"legacy_thermostat_button", legacy_thermostat_button},
        {"legacy_security_zones", legacy_security_zones},
        {"legacy_security_recovery", legacy_security_recovery}};
    try {
        REQUIRE(argc == 2);
        for (const auto& t : tests)
            if (t.first == argv[1]) {
                t.second();
                std::cout << "PASS FCPLCn sockets " << t.first << '\n';
                return 0;
            }
        throw std::runtime_error("Unknown case");
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
