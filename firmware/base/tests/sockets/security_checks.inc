// These cases run inside socket_test.cpp's fixture namespace against production controller code.

std::string hub_pulse(bool target,
                      unsigned sequence = 1,
                      unsigned revision = 1,
                      bool busy = false,
                      const std::string& epoch = "hub-one",
                      std::int64_t ttl = 4000)
{
    return "{\"schemaVersion\":1,\"bootId\":\"boot-hub-test\",\"hubEpoch\":\"" + epoch
           + "\",\"leaseSequence\":" + std::to_string(sequence)
           + ",\"modeRevision\":" + std::to_string(revision) + ",\"expiresAtUptimeMs\":"
           + std::to_string(esp_timer_get_time() / 1000 + ttl) + ",\"touchArmed\":"
           + (target ? "true" : "false") + ",\"busy\":" + (busy ? "true" : "false") + "}";
}

bool hub_pulse_receive(const std::string& pulse, bool retained = false)
{
    return security_sync_receive(pulse, retained, "boot-hub-test", esp_timer_get_time() / 1000);
}

std::string key_rom(unsigned serial)
{
    std::array<std::uint8_t, 8> bytes{1,
                                      static_cast<std::uint8_t>(serial),
                                      static_cast<std::uint8_t>(serial >> 8),
                                      0,
                                      0,
                                      0,
                                      0,
                                      0};
    bytes[7] = fcplcn::util::crc8_dallas(bytes.data(), 7);
    std::string result;
    for (auto value : bytes) {
        result.push_back("0123456789abcdef"[value >> 4]);
        result.push_back("0123456789abcdef"[value & 15]);
    }
    return result;
}

Json security_status()
{
    return module(ControllerKind::Security);
}

bool security_flag(const char* name)
{
    auto value = security_status();
    return boolean(value.get(), name);
}

std::string security_phase()
{
    auto value = security_status();
    REQUIRE(cJSON_IsString(field(value.get(), "phase")));
    return field(value.get(), "phase")->valuestring;
}

std::string security_zone(const std::string& id,
                          const std::string& input,
                          const std::string& type,
                          bool delayed = false)
{
    return "{\"id\":\"" + id + "\",\"name\":\"" + id + "\",\"inputId\":\"" + input
           + "\",\"sensorType\":\"" + type + "\",\"entryDelay\":" + (delayed ? "true" : "false")
           + "}";
}

const std::string security_standard_zones = "[" + security_zone("door", "in-0/1", "reed", true)
                                            + "," + security_zone("hall", "in-0/2", "motion") + "]";

Json security_request(unsigned exitSeconds = 0,
                      unsigned entrySeconds = 0,
                      bool enabled = true,
                      const std::string& zones = security_standard_zones)
{
    return parse(
        "{\"baseRevision\":" + std::to_string(module_revision(ControllerKind::Security))
        + ",\"enabled\":" + (enabled ? "true" : "false")
        + ",\"sirenRelayId\":\"rly-0/16\",\"readerPortId\":\"sens-0/8\",\"exitDelaySeconds\":"
        + std::to_string(exitSeconds) + ",\"entryDelaySeconds\":" + std::to_string(entrySeconds)
        + ",\"keys\":[{\"id\":\"home\",\"name\":\"Дом\",\"address\":\"" + key_rom(1)
        + "\"}],\"items\":" + zones + "}");
}

SocketResult security_update(const cJSON* request)
{
    std::string error;
    return controller_update(ControllerKind::Security, request, error);
}

SocketResult security_arm(bool armed)
{
    std::string error;
    return controller_security_set_armed(armed, error);
}

void security_samples(unsigned count = 3, std::int64_t periodUs = 20'000)
{
    for (unsigned i = 0; i < count; ++i)
        step(periodUs);
}

void security_start(unsigned exitSeconds = 0, unsigned entrySeconds = 0)
{
    socket_controller_test_reset();
    start();
    socket_test::input(0, false);  // NC reed closed is normal.
    socket_test::input(1, true);  // NO motion contact open is normal.
    auto request = security_request(exitSeconds, entrySeconds);
    REQUIRE(security_update(request.get()) == SocketResult::Ok);
    security_samples();
    REQUIRE(ibutton_fake::configured() == "sens-0/8");
}

void security_reboot()
{
    socket_controller_test_reset();
    socket_test::reboot_hardware();
    socket_test::input(0, false);
    socket_test::input(1, true);
    REQUIRE(socket_controller_init() == ESP_OK);
    security_samples();
}

void security_hub_touch()
{
    security_start();
    ibutton_fake::release();
    step();
    security_sync_connection(true, "boot-hub-test");
    REQUIRE(hub_pulse_receive(hub_pulse(false)));
    // The global target is explicit: disarmed locally must not invert to armed.
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(!security_flag("armed"));
    Json event(security_sync_take_event(esp_timer_get_time() / 1000), cJSON_Delete);
    REQUIRE(event);
    REQUIRE(!boolean(event.get(), "value"));
    REQUIRE(boolean(event.get(), "localApplied"));
    REQUIRE(std::string(cJSON_GetStringValue(field(event.get(), "keyId"))) == "home");
    REQUIRE(!field(event.get(), "address"));
    step();
    REQUIRE(security_sync_take_event(esp_timer_get_time() / 1000) == nullptr);
    ibutton_fake::release();
    step();
    REQUIRE(hub_pulse_receive(hub_pulse(true, 2, 2)));
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(security_flag("armed"));
    Json second(security_sync_take_event(esp_timer_get_time() / 1000), cJSON_Delete);
    REQUIRE(second && boolean(second.get(), "value"));
    REQUIRE(field(second.get(), "eventSequence")->valuedouble
            > field(event.get(), "eventSequence")->valuedouble);
}

void security_hub_freshness()
{
    security_start();
    ibutton_fake::release();
    step();
    security_sync_connection(true, "boot-hub-test");
    const auto pulse = hub_pulse(true);
    REQUIRE(!hub_pulse_receive(pulse, true));
    REQUIRE(!hub_pulse_receive(hub_pulse(true, 1, 1, false, "hub-one", 5001)));
    REQUIRE(hub_pulse_receive(pulse));
    REQUIRE(!hub_pulse_receive(pulse));
    REQUIRE(hub_pulse_receive(hub_pulse(false, 1, 2, false, "hub-two")));
    REQUIRE(!hub_pulse_receive(hub_pulse(true, 20, 2, false, "hub-one")));
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(!security_flag("armed"));
    security_sync_connection(false, "boot-hub-test");
    REQUIRE(security_sync_take_event(esp_timer_get_time() / 1000) == nullptr);
    security_sync_connection(true, "boot-hub-test");
    REQUIRE(security_sync_take_event(esp_timer_get_time() / 1000) == nullptr);
    REQUIRE(hub_pulse_receive(hub_pulse(false, 1, 2, false, "hub-two")));
    step(4'100'000);
    ibutton_fake::release();
    step();
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(security_flag("armed"));  // Expired authority falls back to autonomous local control.
    REQUIRE(security_sync_take_event(esp_timer_get_time() / 1000) == nullptr);
}

void security_hub_fence()
{
    security_start();
    socket_mqtt_test_reset();
    security_sync_connection(true, "boot-hub-test");
    REQUIRE(hub_pulse_receive(hub_pulse(true, 1, 0)));
    auto command = [&](unsigned sequence,
                       unsigned lease,
                       unsigned revision,
                       bool value,
                       const std::string& epoch = "hub-one") {
        const auto payload =
            "{\"bootId\":\"boot-hub-test\",\"sequence\":" + std::to_string(sequence)
            + ",\"expiresAtUptimeMs\":" + std::to_string(esp_timer_get_time() / 1000 + 3000)
            + ",\"id\":\"alarm\",\"value\":" + (value ? "true" : "false") + ",\"hubEpoch\":\""
            + epoch + "\",\"modeRevision\":" + std::to_string(revision)
            + ",\"leaseSequence\":" + std::to_string(lease) + "}";
        return Json(controller_mqtt_command(ControllerKind::Security,
                                            payload,
                                            false,
                                            "boot-hub-test",
                                            esp_timer_get_time() / 1000),
                    cJSON_Delete);
    };
    auto initial = command(1, 1, 0, true);
    REQUIRE(initial && boolean(initial.get(), "ok") && security_flag("armed"));
    REQUIRE(hub_pulse_receive(hub_pulse(false, 2, 1)));
    auto old = command(2, 1, 0, false);
    REQUIRE(old && !boolean(old.get(), "ok") && security_flag("armed"));
    auto next = command(3, 2, 1, false);
    REQUIRE(next && boolean(next.get(), "ok") && !security_flag("armed"));
    step(4'100'000);
    auto expired = command(4, 2, 1, true);
    REQUIRE(expired && !boolean(expired.get(), "ok") && !security_flag("armed"));
}

void security_hub_busy()
{
    security_start();
    ibutton_fake::release();
    step();
    security_sync_connection(true, "boot-hub-test");
    REQUIRE(hub_pulse_receive(hub_pulse(true, 1, 1, true)));
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(!security_flag("armed"));
    REQUIRE(security_sync_take_event(esp_timer_get_time() / 1000) == nullptr);
    REQUIRE(hub_pulse_receive(hub_pulse(true, 2, 1)));
    step();  // A held tablet cannot become a deferred event after busy clears.
    REQUIRE(!security_flag("armed"));
    ibutton_fake::release();
    step();
    ibutton_fake::key(key_rom(2));  // Unknown keys never reach the hub.
    step();
    REQUIRE(!security_flag("armed"));
    REQUIRE(security_sync_take_event(esp_timer_get_time() / 1000) == nullptr);
    ibutton_fake::release();
    step();
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(security_flag("armed"));
    step(1'600'000);
    REQUIRE(security_sync_take_event(esp_timer_get_time() / 1000) == nullptr);
}

void security_hub_failure_event()
{
    security_start();
    ibutton_fake::release();
    step();
    security_sync_connection(true, "boot-hub-test");
    REQUIRE(hub_pulse_receive(hub_pulse(true)));
    socket_test::input(0, true);  // Open protected door prevents immediate local arming.
    security_samples();
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(!security_flag("armed"));
    Json event(security_sync_take_event(esp_timer_get_time() / 1000), cJSON_Delete);
    REQUIRE(event);
    REQUIRE(boolean(event.get(), "value"));
    REQUIRE(!boolean(event.get(), "localApplied"));
    // The authorized intention still reaches the hub so other devices and extras can execute.
}

void security_hub_contact_before_lease()
{
    security_start();
    ibutton_fake::release();
    step();
    // A queued driver contact occurred while no hub authority was present.
    ibutton_fake::key(key_rom(1));
    socket_test::advance(20'000, true);
    security_sync_connection(true, "boot-hub-test");
    REQUIRE(hub_pulse_receive(hub_pulse(false)));
    step();
    REQUIRE(security_flag("armed"));  // The pre-lease contact keeps autonomous local semantics.
    REQUIRE(security_sync_take_event(esp_timer_get_time() / 1000) == nullptr);
    ibutton_fake::release();
    step();
    ibutton_fake::key(key_rom(1));
    socket_test::advance(20'000, true);
    // Ordinary pulses of continuous authority do not invalidate an already fresh contact.
    REQUIRE(hub_pulse_receive(hub_pulse(false, 2)));
    step();
    REQUIRE(!security_flag("armed"));
    Json event(security_sync_take_event(esp_timer_get_time() / 1000), cJSON_Delete);
    REQUIRE(event && !boolean(event.get(), "value"));
    REQUIRE(hub_pulse_receive(hub_pulse(false, 3)));
    const SecurityCommandFence original{"hub-one", 1, 2};
    SecuritySyncGuard sync;
    std::int64_t deadline = 0;
    REQUIRE(!sync.allows(original, esp_timer_get_time() / 1000, deadline));
    REQUIRE(sync.allows_event(
        original,
        static_cast<std::int64_t>(field(event.get(), "eventAtUptimeMs")->valuedouble),
        esp_timer_get_time() / 1000));
}

/** @brief Enabling the module never implicitly arms an incomplete or unavailable guard. */
void security_module_enable()
{
    const auto requireUnarmed = [](bool ready = false) {
        REQUIRE(security_flag("enabled"));
        REQUIRE(!security_flag("armed") && !security_flag("triggered"));
        REQUIRE(security_phase() == "disarmed");
        REQUIRE(security_flag("readyToArm") == ready);
        for (unsigned i = 0; i < 16; ++i)
            REQUIRE(!socket_test::relay(i));
    };
    const auto requireValidBackup = [] {
        SettingsSnapshot snapshot;
        std::string error;
        Json backup(controllers_backup_snapshot(snapshot, error), cJSON_Delete);
        REQUIRE(backup);
        SettingsBytes record;
        REQUIRE(controllers_backup_record(backup.get(), 1, 1, 1, 1, record, error, 1));
        auto* security = cJSON_GetObjectItemCaseSensitive(backup.get(), "security");
        REQUIRE(cJSON_ReplaceItemInObjectCaseSensitive(security, "armed", cJSON_CreateBool(true)));
        // Incomplete settings are valid while disarmed, never as an armed backup.
        REQUIRE(!controllers_backup_record(backup.get(), 1, 1, 1, 1, record, error, 1));
    };

    socket_controller_test_reset();
    start();
    auto blank = security_request(0, 0, true, "[]");
    cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(blank.get(), "sirenRelayId"), "");
    cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(blank.get(), "readerPortId"), "");
    cJSON_DeleteItemFromArray(cJSON_GetObjectItemCaseSensitive(blank.get(), "keys"), 0);
    REQUIRE(security_update(blank.get()) == SocketResult::Ok);
    requireUnarmed();
    REQUIRE(security_arm(true) == SocketResult::Unavailable);
    requireUnarmed();
    requireValidBackup();
    security_reboot();
    requireUnarmed();
    socket_test::erase_fram();
    security_reboot();
    requireUnarmed();  // A missing state record cannot manufacture a never-armed alarm.

    socket_controller_test_reset();
    start();
    auto noZones = security_request(0, 0, true, "[]");
    REQUIRE(security_update(noZones.get()) == SocketResult::Ok);
    security_samples();
    requireUnarmed();
    REQUIRE(security_arm(true) == SocketResult::Unavailable);
    requireValidBackup();
    security_reboot();
    requireUnarmed();
    socket_test::erase_fram();
    security_reboot();
    requireUnarmed();

    socket_controller_test_reset();
    start();
    socket_test::input(0, false);
    socket_test::input(1, true);
    auto configuredOff = security_request(0, 0, false);
    REQUIRE(security_update(configuredOff.get()) == SocketResult::Ok);
    security_samples();
    ibutton_fake::fail("RMT unavailable");
    auto enable = security_request();
    REQUIRE(security_update(enable.get()) == SocketResult::Ok);
    security_samples();
    REQUIRE(!ibutton_read().available);
    REQUIRE(ibutton_fake::configured() == "sens-0/8");
    auto view = security_status();
    REQUIRE(std::string(cJSON_GetStringValue(field(view.get(), "sirenRelayId"))) == "rly-0/16");
    REQUIRE(std::string(cJSON_GetStringValue(field(view.get(), "readerPortId"))) == "sens-0/8");
    REQUIRE(cJSON_GetArraySize(field(view.get(), "items")) == 2);
    requireUnarmed(true);  // Reader health gates physical keys, never explicit web/MQTT arming.
    REQUIRE(security_arm(true) == SocketResult::Ok);
    REQUIRE(security_flag("armed") && !security_flag("triggered"));
    security_reboot();
    REQUIRE(security_flag("armed") && !security_flag("triggered"));
}

void security_zones()
{
    security_start();
    const auto flashWrites = socket_test::nvs_commits();
    REQUIRE(security_arm(true) == SocketResult::Ok);
    REQUIRE(security_flag("armed") && !security_flag("triggered"));
    socket_test::input(0, true);
    security_samples(2);
    REQUIRE(!security_flag("triggered") && !socket_test::relay(15));
    security_samples(1);
    REQUIRE(security_flag("triggered") && socket_test::relay(15));
    auto view = security_status();
    REQUIRE(boolean(item(view.get()), "active") && !boolean(item(view.get()), "closed"));
    socket_test::input(0, false);
    security_samples();
    REQUIRE(security_flag("triggered") && socket_test::relay(15));
    REQUIRE(security_arm(false) == SocketResult::Ok);
    REQUIRE(!security_flag("armed") && !security_flag("triggered") && !socket_test::relay(15));
    REQUIRE(security_arm(true) == SocketResult::Ok);
    socket_test::input(1, false);
    security_samples();
    REQUIRE(security_flag("triggered") && socket_test::relay(15));
    view = security_status();
    REQUIRE(boolean(item(view.get(), 1), "active") && boolean(item(view.get(), 1), "closed"));
    REQUIRE(socket_test::nvs_commits() == flashWrites);
}

void security_keys()
{
    security_start();
    const auto flashWrites = socket_test::nvs_commits();
    ibutton_fake::key(key_rom(99));
    step();
    REQUIRE(!security_flag("armed"));
    ibutton_fake::release();
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(security_flag("armed"));
    const auto framWrites = socket_test::fram_commits();
    for (unsigned i = 0; i < 10; ++i) {
        ibutton_fake::key(key_rom(1));
        step();
    }
    REQUIRE(security_flag("armed") && socket_test::fram_commits() == framWrites);
    ibutton_fake::release();
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(!security_flag("armed"));
    ibutton_fake::release();
    ibutton_fake::key(key_rom(1));
    security_reboot();
    REQUIRE(!security_flag("armed"));  // A held pre-reboot key is only a baseline.
    REQUIRE(socket_test::nvs_commits() == flashWrites);
}

void security_delays()
{
    security_start(3, 2);
    socket_test::input(0, true);
    security_samples();
    REQUIRE(security_arm(true) == SocketResult::Ok);
    REQUIRE(security_phase() == "exit_delay" && !socket_test::relay(15));
    socket_test::input(0, false);
    security_samples();
    step(3'000'000);
    REQUIRE(security_phase() == "armed" && !security_flag("triggered"));
    socket_test::input(0, true);
    security_samples();
    REQUIRE(security_phase() == "entry_delay" && !socket_test::relay(15));
    socket_test::input(0, false);
    security_samples();
    step(2'000'000);
    REQUIRE(security_phase() == "alarm" && socket_test::relay(15));
    REQUIRE(security_arm(false) == SocketResult::Ok);
    REQUIRE(security_arm(true) == SocketResult::Ok);
    step(3'000'000);
    socket_test::input(0, true);
    security_samples();
    REQUIRE(security_phase() == "entry_delay");
    socket_test::input(1, false);
    security_samples();
    REQUIRE(security_phase() == "alarm");  // Immediate zone bypasses another zone's countdown.
    REQUIRE(security_arm(false) == SocketResult::Ok);
    socket_test::input(1, true);
    security_samples();
    REQUIRE(security_arm(true) == SocketResult::Ok);
    step(3'000'000);
    REQUIRE(security_phase() == "alarm");  // Open at exit expiry gets no extra entry grace.
}

void security_persistence()
{
    security_start(30, 15);
    const auto flashWrites = socket_test::nvs_commits();
    REQUIRE(security_arm(true) == SocketResult::Ok);
    REQUIRE(security_phase() == "exit_delay");
    security_reboot();
    REQUIRE(security_flag("armed") && security_phase() == "armed");
    REQUIRE(!security_flag("triggered"));
    socket_test::input(1, false);
    security_samples();
    REQUIRE(security_flag("triggered") && socket_test::relay(15));
    security_reboot();
    REQUIRE(security_flag("armed") && security_flag("triggered") && socket_test::relay(15));
    REQUIRE(security_phase() == "alarm");
    REQUIRE(socket_test::nvs_commits() == flashWrites);
    REQUIRE(security_arm(false) == SocketResult::Ok);
    socket_test::erase_fram();
    security_reboot();
    REQUIRE(security_flag("armed") && security_flag("triggered") && socket_test::relay(15));
    REQUIRE(security_arm(false) == SocketResult::Ok);
}

void security_faults()
{
    security_start();
    const auto flashWrites = socket_test::nvs_commits();
    socket_test::input(0, true);
    security_samples();
    REQUIRE(security_arm(true) == SocketResult::Unavailable);
    socket_test::input(0, false);
    security_samples();
    ibutton_fake::fail("RMT unavailable");
    REQUIRE(security_arm(true) == SocketResult::Ok);
    REQUIRE(security_flag("armed") && !security_flag("triggered"));
    REQUIRE(security_arm(false) == SocketResult::Ok);
    ibutton_fake::release();
    socket_test::set_fram_present(false);
    REQUIRE(security_arm(true) == SocketResult::StorageError);
    REQUIRE(!security_flag("armed") && !socket_test::relay(15));
    socket_test::set_fram_present(true);
    REQUIRE(security_arm(true) == SocketResult::Ok);
    step(400'000);
    socket_test::input(0, false, false);
    step();
    REQUIRE(security_flag("triggered") && socket_test::relay(15));
    socket_test::set_fram_present(false);
    REQUIRE(security_arm(false) == SocketResult::StorageError);
    REQUIRE(security_flag("inhibited") && security_flag("armed") && !socket_test::relay(15));
    step(2'000'000);
    REQUIRE(!socket_test::relay(15));
    socket_test::set_fram_present(true);
    REQUIRE(security_arm(false) == SocketResult::Ok);
    REQUIRE(!security_flag("armed") && !security_flag("triggered"));
    REQUIRE(socket_test::nvs_commits() == flashWrites);
}

void security_enrollment()
{
    security_start();
    const auto flashWrites = socket_test::nvs_commits();
    ibutton_fake::scan(std::vector<std::string>{key_rom(1), key_rom(2)});
    cJSON* out = nullptr;
    std::string error;
    REQUIRE(controller_security_scan("sens-0/7", true, out, error) == SocketResult::Ok);
    Json result(out, cJSON_Delete);
    REQUIRE(cJSON_GetArraySize(field(result.get(), "addresses")) == 2);
    REQUIRE(ibutton_fake::configured() == "sens-0/8");
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(!security_flag("armed"));
    step(31'000'000);
    REQUIRE(!security_flag("armed"));
    ibutton_fake::release();
    ibutton_fake::key(key_rom(1));
    step();
    REQUIRE(security_flag("armed"));
    out = nullptr;
    REQUIRE(controller_security_scan("sens-0/8", false, out, error) == SocketResult::Conflict);
    REQUIRE(out == nullptr);
    REQUIRE(socket_test::nvs_commits() == flashWrites);
}

void security_claims()
{
    security_start();
    auto request = security_request();
    cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(request.get(), "sirenRelayId"),
                         "rly-0/1");
    configure();
    REQUIRE(security_update(request.get()) == SocketResult::Conflict);
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("x", "sens-0/8") + "]")
            == SocketResult::Conflict);
    cJSON* forbiddenScan = nullptr;
    std::string scanError;
    const auto scanCalls = meteo_fake::scan_calls();
    REQUIRE(controller_meteo_scan("sens-0/8", true, forbiddenScan, scanError)
            == SocketResult::Conflict);
    REQUIRE(forbiddenScan == nullptr && meteo_fake::scan_calls() == scanCalls);
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("x", "sens-0/7") + "]")
            == SocketResult::Ok);
    cJSON* out = nullptr;
    std::string error;
    REQUIRE(controller_security_scan("sens-0/7", false, out, error) == SocketResult::Conflict);
    REQUIRE(out == nullptr);
    auto bad = security_request();
    auto* key = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(bad.get(), "keys"), 0);
    cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(key, "address"), "0100000000000000");
    REQUIRE(security_update(bad.get()) == SocketResult::InvalidInput);
    REQUIRE(security_arm(true) == SocketResult::Ok);
    auto renamed = security_request();
    cJSON_SetValuestring(
        cJSON_GetObjectItemCaseSensitive(
            cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(renamed.get(), "items"), 0),
            "name"),
        "changed");
    REQUIRE(security_update(renamed.get()) == SocketResult::Conflict);
    REQUIRE(security_flag("armed"));
    REQUIRE(controllers_set_relay("rly-0/16", true, error) == SocketResult::Conflict);
    auto disabled = security_request(0, 0, false);
    REQUIRE(security_update(disabled.get()) == SocketResult::Ok);
    REQUIRE(!security_flag("armed") && !security_flag("triggered") && !socket_test::relay(15));
}

void security_deadlines()
{
    security_start();
    const auto flashWrites = socket_test::nvs_commits();
    std::string error;
    const auto nowMs = esp_timer_get_time() / 1000;
    REQUIRE(controller_security_set_armed_until(true, nowMs, error) == SocketResult::Conflict);
    socket_test::advance_on_relay_read(200'000);
    REQUIRE(controller_security_set_armed_until(true, nowMs + 100, error)
            == SocketResult::Conflict);
    REQUIRE(!security_flag("armed"));
    REQUIRE(security_arm(true) == SocketResult::Ok);
    REQUIRE(controller_security_set_armed_until(false, esp_timer_get_time() / 1000, error)
            == SocketResult::Conflict);
    REQUIRE(security_flag("armed"));
    REQUIRE(socket_test::nvs_commits() == flashWrites);
}

void security_entry_reboot()
{
    security_start(0, 15);
    const auto flashWrites = socket_test::nvs_commits();
    REQUIRE(security_arm(true) == SocketResult::Ok);
    socket_test::input(0, true);
    security_samples();
    REQUIRE(security_phase() == "entry_delay" && security_flag("triggered"));
    REQUIRE(security_flag("pendingEntry") && !socket_test::relay(15));
    socket_test::input(0, false);
    security_samples();
    const auto frames = socket_test::fram_commits();
    REQUIRE(security_arm(true) == SocketResult::Ok);
    REQUIRE(socket_test::fram_commits() == frames && security_phase() == "entry_delay");
    security_reboot();
    REQUIRE(security_phase() == "alarm" && security_flag("triggered") && socket_test::relay(15));
    REQUIRE(!security_flag("pendingEntry"));
    REQUIRE(security_arm(false) == SocketResult::Ok);
    REQUIRE(security_arm(true) == SocketResult::Ok);
    socket_test::fail_fram_commit();
    socket_test::input(0, true);
    security_samples();
    REQUIRE(security_phase() == "alarm" && !security_flag("pendingEntry"));
    REQUIRE(socket_test::relay(15));  // No quiet grace without a confirmed durable marker.
    socket_test::input(0, false);
    security_samples();
    step(1'100'000);
    security_reboot();
    REQUIRE(security_phase() == "alarm" && socket_test::relay(15));
    REQUIRE(socket_test::nvs_commits() == flashWrites);
}

std::string security_mqtt_payload(unsigned sequence,
                                  bool value,
                                  const std::string& id = "alarm",
                                  const std::string& boot = "security-boot",
                                  unsigned expiry = 20'000)
{
    return "{\"id\":\"" + id + "\",\"value\":" + (value ? "true" : "false") + ",\"bootId\":\""
           + boot + "\",\"sequence\":" + std::to_string(sequence)
           + ",\"expiresAtUptimeMs\":" + std::to_string(expiry) + "}";
}

void security_mqtt()
{
    security_start();
    socket_mqtt_test_reset();
    const auto flashWrites = socket_test::nvs_commits();
    auto execute = [&](const std::string& payload, bool retained = false) {
        Json reply(controller_mqtt_command(ControllerKind::Security,
                                           payload,
                                           retained,
                                           "security-boot",
                                           esp_timer_get_time() / 1000),
                   cJSON_Delete);
        REQUIRE(reply);
        return reply;
    };
    for (const auto& bad : {security_mqtt_payload(1, true, "door"),
                            security_mqtt_payload(1, true, "alarm", "other-boot"),
                            security_mqtt_payload(1, true, "alarm", "security-boot", 0)}) {
        auto reply = execute(bad);
        REQUIRE(!boolean(reply.get(), "ok") && !security_flag("armed"));
        REQUIRE(controller_mqtt_sequence(ControllerKind::Security) == 0);
    }
    auto reply = execute(security_mqtt_payload(1, true), true);
    REQUIRE(!boolean(reply.get(), "ok") && !security_flag("armed"));
    const auto first = security_mqtt_payload(1, true);
    reply = execute(first);
    REQUIRE(boolean(reply.get(), "ok") && security_flag("armed"));
    const auto frames = socket_test::fram_commits();
    reply = execute(first);
    REQUIRE(boolean(reply.get(), "ok") && boolean(reply.get(), "duplicate"));
    REQUIRE(security_flag("armed") && socket_test::fram_commits() == frames);
    REQUIRE(security_arm(false) == SocketResult::Ok);
    reply = execute(first);
    REQUIRE(boolean(reply.get(), "ok") && boolean(reply.get(), "duplicate"));
    REQUIRE(
        !security_flag("armed"));  // Cached ACK cannot reapply an old ARM after local disarming.
    reply = execute(security_mqtt_payload(2, true));
    REQUIRE(boolean(reply.get(), "ok") && security_flag("armed"));
    reply = execute(security_mqtt_payload(2, false));
    REQUIRE(!boolean(reply.get(), "ok") && security_flag("armed"));
    reply = execute(security_mqtt_payload(1, false));
    REQUIRE(!boolean(reply.get(), "ok") && security_flag("armed"));
    reply = execute(security_mqtt_payload(3, false));
    REQUIRE(boolean(reply.get(), "ok") && !security_flag("armed"));
    REQUIRE(socket_test::nvs_commits() == flashWrites);
}

void security_config_held_key()
{
    security_start();
    ibutton_fake::candidate(key_rom(2));
    auto request = security_request();
    auto* keys = cJSON_GetObjectItemCaseSensitive(request.get(), "keys");
    auto key = parse("{\"id\":\"second\",\"name\":\"Второй\",\"address\":\"" + key_rom(2) + "\"}");
    REQUIRE(cJSON_AddItemToArray(keys, key.get()));
    key.release();
    REQUIRE(security_update(request.get()) == SocketResult::Ok);
    security_samples();
    ibutton_fake::key(key_rom(2));  // Second poll of the key already held during configuration.
    step();
    REQUIRE(!security_flag("armed"));
    ibutton_fake::release();
    ibutton_fake::key(key_rom(2));
    step();
    REQUIRE(security_flag("armed"));
}

/** @brief Web-only guards preserve local zones, alarm latching and FRAM without optional devices.
 */
void security_optional_hardware()
{
    for (unsigned missing = 0; missing < 3; ++missing) {
        socket_controller_test_reset();
        start();
        socket_test::input(0, false);
        socket_test::input(1, true);
        auto request = security_request();
        const bool hasSiren = missing == 1;
        const bool hasReader = missing == 0;
        if (!hasSiren)
            cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(request.get(), "sirenRelayId"),
                                 "");
        if (!hasReader) {
            cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(request.get(), "readerPortId"),
                                 "");
            cJSON_DeleteItemFromArray(cJSON_GetObjectItemCaseSensitive(request.get(), "keys"), 0);
        }
        REQUIRE(security_update(request.get()) == SocketResult::Ok);
        security_samples();
        REQUIRE(!security_flag("armed") && security_flag("readyToArm"));
        const auto flashWrites = socket_test::nvs_commits();
        REQUIRE(security_arm(true) == SocketResult::Ok);
        step(400'000);
        REQUIRE(security_flag("armed") && !security_flag("triggered"));
        SettingsSnapshot snapshot;
        std::string error;
        Json backup(controllers_backup_snapshot(snapshot, error), cJSON_Delete);
        REQUIRE(backup);
        SettingsBytes record;
        REQUIRE(controllers_backup_record(backup.get(), 1, 1, 1, 1, record, error, 1));
        security_reboot();
        REQUIRE(security_flag("armed") && !security_flag("triggered"));
        socket_test::input(0, true);
        security_samples();
        REQUIRE(security_flag("triggered"));
        for (unsigned relay = 0; relay < 16; ++relay)
            REQUIRE(socket_test::relay(relay) == (hasSiren && relay == 15));
        REQUIRE(security_arm(false) == SocketResult::Ok);
        REQUIRE(!security_flag("armed") && !security_flag("triggered"));
        socket_test::erase_fram();
        security_reboot();
        REQUIRE(security_flag("armed") && security_flag("triggered"));
        for (unsigned relay = 0; relay < 16; ++relay)
            REQUIRE(socket_test::relay(relay) == (hasSiren && relay == 15));
        REQUIRE(security_arm(false) == SocketResult::Ok);
        REQUIRE(socket_test::nvs_commits() == flashWrites);
    }

    security_start();
    ibutton_fake::fail("Reader disconnected");
    auto failedReader = ibutton_read();
    ++failedReader.eventSequence;
    failedReader.eventAddress = key_rom(1);
    failedReader.eventAtMs = esp_timer_get_time() / 1000;
    ibutton_fake::reading(failedReader);
    step();
    REQUIRE(!security_flag("armed"));  // An unhealthy reader cannot authorize even a known ROM.
    REQUIRE(security_flag("readyToArm"));
    REQUIRE(security_arm(true) == SocketResult::Ok);
    REQUIRE(security_flag("armed"));
    REQUIRE(security_arm(false) == SocketResult::Ok);
    socket_test::relay_valid(15, false);
    REQUIRE(security_arm(true)
            == SocketResult::Unavailable);  // Assigned siren still requires health.
    REQUIRE(!security_flag("armed"));
}
