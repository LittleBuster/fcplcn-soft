/** Native weekly rule and tank-interlock checks using a deterministic wall and monotonic clock. */
const auto irrigation = ControllerKind::Irrigation;
const std::string morning =
    R"({"id":"morning","name":"Грядки","relayId":"rly-0/3","tankId":"tank","days":[1,3],"startTime":"07:00","durationMinutes":2})";
const std::string overlap =
    R"({"id":"second","name":"Второе правило","relayId":"rly-0/3","tankId":"tank","days":[1],"startTime":"07:01","durationMinutes":2})";
const std::string unboundMorning =
    R"({"id":"morning","name":"Газон","relayId":"rly-0/3","days":[1,3],"startTime":"07:00","durationMinutes":2})";
const std::string unboundOverlap =
    R"({"id":"second","name":"Второе правило","relayId":"rly-0/3","tankId":"","days":[1],"startTime":"07:01","durationMinutes":2})";
constexpr std::int64_t mondayStart = 1704092400;  // Monday 2024-01-01 07:00 UTC

void setup_irrigation(const char* profile = kDefaultBoardProfileId)
{
    setenv("TZ", "UTC0", 1);
    tzset();
    controller_irrigation_test_clock(mondayStart - 1);
    start(profile);
    REQUIRE(module_update(ControllerKind::Tanks, tank_two) == ControllerResult::Ok);
    socket_test::input(0, board_profile_active().inputs[0].activeHigh);
    socket_test::input(1, !board_profile_active().inputs[1].activeHigh);
    tank_enable();
    tank_percent(50);
    REQUIRE(module_update(irrigation, "[" + morning + "," + overlap + "]") == ControllerResult::Ok);
    REQUIRE(!boolean(item(module(irrigation).get()), "enabled"));
    std::string error;
    REQUIRE(controller_irrigation_set_enabled("morning", true, error) == ControllerResult::Ok);
    REQUIRE(controller_irrigation_set_enabled("second", true, error) == ControllerResult::Ok);
    step();
}

void irrigation_run()
{
    setup_irrigation();
    controller_irrigation_test_clock(mondayStart);
    step();
    REQUIRE(socket_test::relay(2));
    REQUIRE(boolean(item(module(irrigation).get()), "actual"));
    REQUIRE(!boolean(item(module(irrigation).get(), 1), "actual"));
    controller_irrigation_test_clock(mondayStart + 60);
    step(60'000'000);
    REQUIRE(boolean(item(module(irrigation).get(), 1), "actual"));
    std::string error;
    REQUIRE(controller_irrigation_set_enabled("morning", false, error) == ControllerResult::Ok);
    REQUIRE(socket_test::relay(2));  // Later rule still has its own running demand.
    step(119'000'000);
    REQUIRE(socket_test::relay(2));
    step(1'000'001);
    REQUIRE(!socket_test::relay(2));
    step();
    REQUIRE(!socket_test::relay(2));
}

void irrigation_water()
{
    setup_irrigation();
    controller_irrigation_test_clock(mondayStart);
    step();
    REQUIRE(socket_test::relay(2));
    socket_test::input(0, true);
    step();
    REQUIRE(!socket_test::relay(2));
    socket_test::input(0, false);
    tank_settle();
    REQUIRE(
        !socket_test::relay(2));  // Wet again in same minute does not resume the interrupted cycle.
    controller_irrigation_test_clock(mondayStart + 60);
    step();
    REQUIRE(socket_test::relay(2));
    step(400'000, false);
    REQUIRE(!socket_test::relay(2));  // Input data stale.
    reboot();
    REQUIRE(boolean(item(module(irrigation).get(), 1), "enabled"));
    REQUIRE(!socket_test::relay(2));  // No recovery of derived valve ON.
}

void irrigation_validation()
{
    setup_irrigation();
    REQUIRE(module_update(ControllerKind::Tanks, "[]") == ControllerResult::Conflict);
    for (const auto& replacement : {std::pair{"tankId\":\"tank", "tankId\":\"missing"},
                                    {"rly-0/3", "rly-0/1"},
                                    {"durationMinutes\":2", "durationMinutes\":0"},
                                    {"durationMinutes\":2", "durationMinutes\":1441"},
                                    {"07:00", "24:00"},
                                    {"[1,3]", "[1,1]"}}) {
        auto invalid = morning;
        invalid.replace(
            invalid.find(replacement.first), std::strlen(replacement.first), replacement.second);
        REQUIRE(module_update(irrigation, "[" + invalid + "]") != ControllerResult::Ok);
    }
    std::string error;
    REQUIRE(controllers_set_relay("rly-0/3", true, error) == ControllerResult::Conflict);
    controller_irrigation_test_clock(mondayStart + 15);
    step();
    REQUIRE(!socket_test::relay(2));  // Missed minute edge: no catch-up.
    controller_irrigation_test_clock(mondayStart + 86400 - 1);
    step();
    controller_irrigation_test_clock(mondayStart + 86400);
    step();
    REQUIRE(!socket_test::relay(2));  // Tuesday is not selected.
}

void irrigation_eeprom()
{
    setup_irrigation("fcplc-080806-3v1");
    reboot();
    const auto rule = module(irrigation);
    REQUIRE(boolean(item(rule.get()), "enabled"));
    REQUIRE(std::string(cJSON_GetStringValue(field(item(rule.get()), "startTime"))) == "07:00");
    REQUIRE(!socket_test::relay(2));
}

void irrigation_clock()
{
    setup_irrigation();
    controller_irrigation_test_clock(mondayStart);
    step();
    REQUIRE(socket_test::relay(2));
    controller_irrigation_test_clock(mondayStart + 86'400);
    step(60'000'000);
    REQUIRE(socket_test::relay(2));  // Wall-time corrections cannot shorten a running timer.
    controller_irrigation_test_clock(mondayStart - 1);
    step(59'000'000);
    REQUIRE(socket_test::relay(2));
    controller_irrigation_test_clock(mondayStart);
    step(1'000'001);
    REQUIRE(!socket_test::relay(2));  // Repeating the minute does not extend the run.
    controller_irrigation_test_clock(mondayStart + 60);
    step();
    REQUIRE(socket_test::relay(2));  // Independent second schedule.
    controller_irrigation_test_clock(0);
    step();
    REQUIRE(!socket_test::relay(2));
}

void irrigation_tank_off()
{
    setup_irrigation();
    controller_irrigation_test_clock(mondayStart);
    step();
    REQUIRE(socket_test::relay(2));
    std::string error;
    REQUIRE(controller_tank_set_enabled("tank", false, error) == ControllerResult::Ok);
    step();
    REQUIRE(!socket_test::relay(2));
    REQUIRE(cJSON_IsNull(field(item(module(irrigation).get()), "waterAvailable")));
    tank_enable();
    REQUIRE(!socket_test::relay(2));  // Re-enabling the tank does not replay the interrupted cycle.
}

void irrigation_no_tank()
{
    setenv("TZ", "UTC0", 1);
    tzset();
    controller_irrigation_test_clock(mondayStart - 1);
    start();
    REQUIRE(module_update(irrigation, "[" + unboundMorning + "," + unboundOverlap + "]")
            == ControllerResult::Ok);
    std::string error;
    REQUIRE(controller_irrigation_set_enabled("morning", true, error) == ControllerResult::Ok);
    REQUIRE(controller_irrigation_set_enabled("second", true, error) == ControllerResult::Ok);
    step();
    controller_irrigation_test_clock(mondayStart);
    step();
    const auto status = module(irrigation);
    const auto* first = item(status.get());
    REQUIRE(boolean(first, "actual") && socket_test::relay(2));
    REQUIRE(cJSON_IsNull(field(first, "waterAvailable")));
    REQUIRE(cJSON_IsNull(field(first, "error")));
    REQUIRE(std::string(cJSON_GetStringValue(field(first, "tankId"))).empty());
    controller_irrigation_test_clock(mondayStart + 60);
    step(60'000'000);
    REQUIRE(boolean(item(module(irrigation).get(), 1), "actual"));
    REQUIRE(controller_irrigation_set_enabled("morning", false, error) == ControllerResult::Ok);
    REQUIRE(socket_test::relay(2));
    step(119'000'000);
    REQUIRE(socket_test::relay(2));
    step(1'000'001);
    REQUIRE(!socket_test::relay(2));
    reboot();
    REQUIRE(boolean(item(module(irrigation).get(), 1), "enabled"));
    REQUIRE(cJSON_IsNull(field(item(module(irrigation).get(), 1), "waterAvailable")));
}

void irrigation_rebind()
{
    setup_irrigation();
    controller_irrigation_test_clock(mondayStart);
    step();
    REQUIRE(socket_test::relay(2));
    REQUIRE(module_update(irrigation, "[" + morning + "," + unboundOverlap + "]")
            != ControllerResult::Ok);  // A shared valve has one interlock policy.
    REQUIRE(socket_test::relay(2));
    REQUIRE(module_update(irrigation, "[" + unboundMorning + "," + unboundOverlap + "]")
            == ControllerResult::Ok);
    REQUIRE(!socket_test::relay(2));
    step();
    REQUIRE(!socket_test::relay(2));
    REQUIRE(module_update(ControllerKind::Tanks, "[]") == ControllerResult::Ok);
    controller_irrigation_test_clock(mondayStart + 60);
    step();
    REQUIRE(socket_test::relay(2));
    REQUIRE(module_update(ControllerKind::Tanks, tank_two) == ControllerResult::Ok);
    REQUIRE(module_update(irrigation, "[" + morning + "," + overlap + "]") == ControllerResult::Ok);
    REQUIRE(!socket_test::relay(2));
    step();
    const auto status = module(irrigation);
    REQUIRE(cJSON_IsNull(field(item(status.get(), 1), "waterAvailable")));
    REQUIRE(cJSON_IsString(field(item(status.get(), 1), "error")));
    REQUIRE(!socket_test::relay(2));
}

constexpr std::string_view ownIrrigationId = "fcplcn-valve";
constexpr std::string_view irrigationBoot = "valve-boot";
constexpr std::string_view waterControllerId = "fcplcn-water";

unsigned request_water(std::string_view prioritized = {})
{
    Json request(irrigation_water_request(irrigationBoot, esp_timer_get_time()), cJSON_Delete);
    REQUIRE(request);
    const auto* refs = field(request.get(), "sources");
    if (!prioritized.empty()) {
        REQUIRE(cJSON_GetArraySize(refs) == 1);
        REQUIRE(prioritized == cJSON_GetStringValue(cJSON_GetArrayItem(refs, 0)));
    }
    return static_cast<unsigned>(field(request.get(), "sequence")->valuedouble);
}

bool water_reply(unsigned sequence,
                 std::string_view water,
                 bool retained = false,
                 std::string_view boot = irrigationBoot,
                 std::string_view source = waterControllerId,
                 std::string_view id = "tank")
{
    const auto body = "{\"bootId\":\"" + std::string(boot) + "\",\"sequence\":"
                      + std::to_string(sequence) + ",\"source\":\"" + std::string(source)
                      + "\",\"sourceName\":\"Насосная\",\"id\":\"" + std::string(id)
                      + "\",\"name\":\"Запас воды\",\"water\":" + std::string(water) + "}";
    return irrigation_water_receive(
        body, retained, ownIrrigationId, irrigationBoot, esp_timer_get_time());
}

void irrigation_remote_grant()
{
    setup_irrigation();  // Includes a wet, local tank with the same short ID as the remote tank.
    const std::string reference = std::string(waterControllerId) + "/tank";
    auto rule = morning;
    rule.replace(rule.find("\"tankId\":\"tank\""), 15, "\"tankId\":\"" + reference + "\"");
    REQUIRE(module_update(irrigation, "[" + rule + "]") == ControllerResult::Ok);
    irrigation_water_connection(true);
    step();
    REQUIRE(cJSON_IsNull(field(item(module(irrigation).get()), "waterAvailable")));
    const auto first = request_water(reference);
    REQUIRE(!water_reply(first, "true", true));  // Retained messages are never water evidence.
    REQUIRE(!water_reply(first, "true", false, "previous-boot"));
    REQUIRE(!water_reply(first + 1, "true"));
    REQUIRE(!water_reply(first, "true", false, irrigationBoot, ownIrrigationId));
    REQUIRE(!water_reply(first, "true", false, irrigationBoot, waterControllerId, "tank\\u0000"));
    REQUIRE(water_reply(first, "true"));
    REQUIRE(!water_reply(first, "false"));  // Duplicate row can't alter the validated response.
    controller_irrigation_test_clock(mondayStart);
    step();
    REQUIRE(socket_test::relay(2));
    auto status = module(irrigation);
    const auto* remote = cJSON_GetArrayItem(field(status.get(), "remoteTanks"), 0);
    REQUIRE(remote && boolean(remote, "waterAvailable"));
    REQUIRE(reference == cJSON_GetStringValue(field(remote, "id")));
    Json mqtt(controller_mqtt_status_json(irrigation), cJSON_Delete);
    REQUIRE(mqtt && field(mqtt.get(), "remoteTanks") == nullptr);

    const auto live = request_water(reference);
    REQUIRE(water_reply(live, "true"));
    step(900'000);
    REQUIRE(socket_test::relay(2));  // An uninterrupted grant never cuts a normal run short.
    const auto dry = request_water(reference);
    REQUIRE(water_reply(dry, "false"));
    REQUIRE(!water_reply(live, "true"));
    step();
    REQUIRE(!socket_test::relay(2));
    REQUIRE(!boolean(item(module(irrigation).get()), "waterAvailable"));
    REQUIRE(water_reply(request_water(reference), "true"));
    step();
    REQUIRE(!socket_test::relay(2));  // A refill does not restart the interrupted minute.
}

void irrigation_remote_reboot()
{
    setenv("TZ", "UTC0", 1);
    tzset();
    controller_irrigation_test_clock(mondayStart - 1);
    start("fcplc-080806-3v1");
    const std::string source = "fcplcn-" + std::string(97, 'p');
    const std::string id(32, 't');
    const auto ref = source + "/" + id;
    auto rule = unboundMorning;
    rule.insert(rule.find("\"days\""), "\"tankId\":\"" + ref + "\",");
    REQUIRE(module_update(irrigation, "[" + rule + "]") == ControllerResult::Ok);
    std::string error;
    REQUIRE(controller_irrigation_set_enabled("morning", true, error) == ControllerResult::Ok);
    irrigation_water_connection(true);
    step();
    const auto challenge = request_water(ref);
    step(2'700'000);
    REQUIRE(water_reply(challenge, "true", false, irrigationBoot, source, id));
    controller_irrigation_test_clock(mondayStart);
    step();
    REQUIRE(socket_test::relay(2));
    step(200'000);  // Exactly three seconds from the request, regardless of arrival time.
    REQUIRE(!socket_test::relay(2));
    REQUIRE(cJSON_IsNull(field(item(module(irrigation).get()), "waterAvailable")));
    REQUIRE(!water_reply(challenge, "true", false, irrigationBoot, source, id));
    const auto retired = request_water(ref);
    irrigation_water_connection(false);
    irrigation_water_connection(true);
    REQUIRE(!water_reply(retired, "true", false, irrigationBoot, source, id));
    reboot();
    const auto restored = module(irrigation);
    REQUIRE(ref == cJSON_GetStringValue(field(item(restored.get()), "tankId")));
    REQUIRE(boolean(item(restored.get()), "enabled"));
    REQUIRE(!socket_test::relay(2));
}
