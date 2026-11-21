// Legacy contact circuits invert physical levels relative to the current board.

void legacy_buttons()
{
    start("fcplc-080806-3v1");
    socket_test::input(0, false);  // Released contact is physical LOW.
    configure(with_input);
    socket_test::input(0, true);
    step(20'000);
    socket_controller_test_step();
    socket_controller_test_step();
    REQUIRE(!state());  // One cached HIGH observation cannot confirm a press.
    step(20'000);
    REQUIRE(!state());
    step(20'000);
    REQUIRE(state());
    for (unsigned i = 0; i < 20; ++i)
        step(20'000);
    REQUIRE(state());  // A held physical HIGH toggles exactly once.
    auto s = status();
    REQUIRE(boolean(item(s.get()), "inputLevel"));  // Diagnostics retain physical HIGH.
    socket_test::input(0, false);
    step(20'000);
    step(60'000);
    REQUIRE(state());  // Releasing the contact is never a press.
    socket_test::input(0, true);
    for (unsigned i = 0; i < 3; ++i)
        step(20'000);
    REQUIRE(!state());
}

void legacy_button_recovery()
{
    start("fcplc-080806-3v1");
    socket_test::input(0, true);  // Contact held at configuration/boot.
    configure(with_input);
    for (unsigned i = 0; i < 6; ++i)
        step();
    REQUIRE(!state());
    socket_test::input(0, false);
    step(20'000);
    step(60'000);
    socket_test::input(0, true);
    for (unsigned i = 0; i < 3; ++i)
        step(20'000);
    REQUIRE(state());
    reboot();  // Fake hardware boots with physical HIGH, still a held legacy contact.
    for (unsigned i = 0; i < 6; ++i)
        step();
    REQUIRE(state());
    socket_test::input(0, true, false);
    step();
    socket_test::input(0, true, true);
    for (unsigned i = 0; i < 6; ++i)
        step();
    REQUIRE(state());  // Input recovery/generation change cannot manufacture a press.
    socket_test::input(0, false);
    step(20'000);
    step(60'000);
    socket_test::input(0, true);
    for (unsigned i = 0; i < 3; ++i)
        step(20'000);
    REQUIRE(!state());
}

void legacy_thermostat_button()
{
    start("fcplc-080806-3v1");
    REQUIRE(module_update(ControllerKind::Meteo, "[" + meteo_row("room") + "]")
            == SocketResult::Ok);
    socket_test::input(0, true);  // Held HIGH does not enable a freshly bound thermostat.
    REQUIRE(thermostat_config("[" + thermostat_button_row() + "]") == SocketResult::Ok);
    temperature(20);
    for (unsigned i = 0; i < 5; ++i)
        step();
    REQUIRE(!thermostat_flag());
    socket_test::input(0, false);
    step(20'000);
    step(60'000);
    socket_test::input(0, true);
    for (unsigned i = 0; i < 3; ++i)
        step(20'000);
    REQUIRE(thermostat_flag());
    for (unsigned i = 0; i < 10; ++i)
        step();
    REQUIRE(thermostat_flag());
}

void legacy_security_start()
{
    start("fcplc-080806-3v1");
    socket_test::input(0, true);  // NC reed closed: physical HIGH.
    socket_test::input(1, false);  // NO motion open: physical LOW.
    auto request = security_request();
    REQUIRE(cJSON_SetValuestring(cJSON_GetObjectItemCaseSensitive(request.get(), "sirenRelayId"),
                                 "rly-0/8"));
    REQUIRE(security_update(request.get()) == SocketResult::Ok);
    security_samples();
}

void legacy_security_zones()
{
    legacy_security_start();
    auto snapshot = security_status();
    REQUIRE(boolean(item(snapshot.get()), "inputLevel"));
    REQUIRE(boolean(item(snapshot.get()), "closed"));
    REQUIRE(!boolean(item(snapshot.get()), "active"));
    REQUIRE(!boolean(item(snapshot.get(), 1), "inputLevel"));
    REQUIRE(!boolean(item(snapshot.get(), 1), "closed"));
    REQUIRE(!boolean(item(snapshot.get(), 1), "active"));
    REQUIRE(security_arm(true) == SocketResult::Ok);
    step(400'000);
    REQUIRE(!security_flag("triggered"));
    socket_test::input(0, false);  // Open reed is physical LOW on this board.
    security_samples();
    REQUIRE(security_flag("triggered") && socket_test::relay(7));
    snapshot = security_status();
    REQUIRE(!boolean(item(snapshot.get()), "inputLevel"));
    REQUIRE(!boolean(item(snapshot.get()), "closed"));
    REQUIRE(boolean(item(snapshot.get()), "active"));
    REQUIRE(security_arm(false) == SocketResult::Ok);
    socket_test::input(0, true);
    security_samples();
    REQUIRE(security_arm(true) == SocketResult::Ok);
    socket_test::input(1, true);  // Motion closes its contact: physical HIGH.
    security_samples();
    REQUIRE(security_flag("triggered") && socket_test::relay(7));
    snapshot = security_status();
    REQUIRE(boolean(item(snapshot.get(), 1), "inputLevel"));
    REQUIRE(boolean(item(snapshot.get(), 1), "closed"));
    REQUIRE(boolean(item(snapshot.get(), 1), "active"));
}

void legacy_security_recovery()
{
    legacy_security_start();
    REQUIRE(security_arm(true) == SocketResult::Ok);
    step(400'000);
    // A completed MCP repair changes generation even if no unavailable sample
    // reaches this worker. Normal closed/open contacts must remain normal.
    socket_test::input(0, true, false);
    socket_test::input(0, true, true);
    security_samples();
    step(400'000);
    REQUIRE(security_flag("armed") && !security_flag("triggered"));
    REQUIRE(!socket_test::relay(7));
    socket_controller_test_reset();
    socket_test::reboot_hardware();
    socket_test::input(0, true);
    socket_test::input(1, false);
    REQUIRE(socket_controller_init() == ESP_OK);
    security_samples();
    step(400'000);
    REQUIRE(security_flag("armed") && !security_flag("triggered"));
    REQUIRE(!socket_test::relay(7));
}
