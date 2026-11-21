#include "hardware/hardware_io.h"
#include "hardware/board_profile.h"
#include "hardware/fram.h"
#include "cJSON.h"
#include "test_driver.h"
#include "esp_timer.h"
#include "driver/i2c_master.h"
#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#define CHECK(condition)                                                                           \
    do {                                                                                           \
        if (!(condition)) {                                                                        \
            std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition);                   \
            std::exit(1);                                                                          \
        }                                                                                          \
    } while (false)
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

Json status()
{
    Json j(hardware_io_status_json(), cJSON_Delete);
    CHECK(j);
    return j;
}

cJSON* field(cJSON* j, const char* key)
{
    auto* value = cJSON_GetObjectItemCaseSensitive(j, key);
    CHECK(value);
    return value;
}

cJSON* channel(cJSON* j, const char* group, const char* id)
{
    cJSON* item = nullptr;
    cJSON_ArrayForEach(item, field(j, group))
    {
        if (std::string(cJSON_GetStringValue(field(item, "id"))) == id)
            return item;
    }
    CHECK(false);
    return nullptr;
}

void confirmed(const char* id, bool expected)
{
    auto j = status();
    auto* ch = channel(j.get(), "relays", id);
    CHECK(cJSON_IsTrue(field(ch, "valid")));
    CHECK(cJSON_IsBool(field(ch, "value")));
    CHECK(cJSON_IsTrue(field(ch, "value")) == expected);
}

void invalid(const char* id)
{
    auto j = status();
    auto* ch = channel(j.get(), "relays", id);
    CHECK(cJSON_IsFalse(field(ch, "valid")));
    CHECK(cJSON_IsNull(field(ch, "value")));
    CHECK(cJSON_IsNull(field(ch, "level")));
}

void step(unsigned ms)
{
    io_test::advance(ms);
    hardware_io_test_step();
}

void fake_map()
{
    i2c_master_bus_config_t config{};
    config.sda_io_num = 4;
    config.scl_io_num = 5;
    i2c_master_bus_handle_t bus = nullptr;
    CHECK(i2c_new_master_bus(&config, &bus) == ESP_OK);
    i2c_device_config_t deviceConfig{};
    deviceConfig.device_address = 0x20;
    i2c_master_dev_handle_t device = nullptr;
    CHECK(i2c_master_bus_add_device(bus, &deviceConfig, &device) == ESP_OK);
    const auto write = [&](std::uint8_t reg, std::initializer_list<std::uint8_t> values) {
        std::vector<std::uint8_t> bytes{reg};
        bytes.insert(bytes.end(), values);
        CHECK(i2c_master_transmit(device, bytes.data(), bytes.size(), 20) == ESP_OK);
    };
    const auto read = [&](std::uint8_t reg) {
        std::array<std::uint8_t, 4> bytes{};
        CHECK(i2c_master_transmit_receive(device, &reg, 1, bytes.data(), bytes.size(), 20)
              == ESP_OK);
        return bytes;
    };
    // Byte mode in BANK=0 alternates an A/B pair, not one frozen address.
    io_test::corrupt_pair(0, 0x20, 0, 0x3412);
    write(0x0a, {0x20});
    CHECK((read(0) == std::array<std::uint8_t, 4>{0x12, 0x34, 0x12, 0x34}));
    // BANK=1 byte mode repeats one byte and aliases IOCON A/B correctly.
    write(0x0b, {0xa0});
    CHECK((read(0) == std::array<std::uint8_t, 4>{0x12, 0x12, 0x12, 0x12}));
    CHECK((read(0x10) == std::array<std::uint8_t, 4>{0x34, 0x34, 0x34, 0x34}));
    write(0x15, {0x80});
    write(0x0a, {0x5a});
    write(0x1a, {0xa5});
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 0xa55a);
    // In BANK=1 a sequential read traverses IODIRA then IPOLA, not IODIRB.
    io_test::corrupt_pair(0, 0x20, 2, 0x7856);
    const auto banked = read(0);
    CHECK(banked[0] == 0x12 && banked[1] == 0x56);
    write(0x05, {0});
    CHECK(io_test::register_pair(0, 0x20, 0x0a) == 0);
    write(0, {0, 0});
    write(0x12, {0x12, 0x34});
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 0x3412);
    io_test::reset_mcp(0, 0x20);
    CHECK(io_test::register_pair(0, 0x20, 0) == 0xffff);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 0);
}

void safe_init()
{
    hardware_io_init();
    hardware_io_init();
    CHECK(io_test::bus_creations() == 2);
    CHECK(io_test::worker_creations() == 1);
    auto j = status();
    CHECK(cJSON_GetArraySize(field(j.get(), "relays")) == 16);
    CHECK(cJSON_GetArraySize(field(j.get(), "inputs")) == 16);
    for (int address : {0x20, 0x21}) {
        CHECK(io_test::register_pair(0, address, 0) == 0x7f01);
        CHECK(io_test::register_pair(0, address, 0x14) == 0);
        CHECK(io_test::register_pair(0, address, 0x0c) == 0);
        bool offWritten = false;
        for (const auto& t : io_test::transfers()) {
            if (t.address != address || t.operation != "write")
                continue;
            if (t.reg == 0x14) {
                CHECK(t.data.size() == 2 && t.data[0] == 0 && t.data[1] == 0);
                offWritten = true;
            }
            if (t.reg == 0) {
                CHECK(offWritten);
            }
        }
    }
    for (const char* relay : {"rly-0/1", "rly-0/8", "rly-0/9", "rly-0/16"})
        confirmed(relay, false);
    CHECK(hardware_io_set_led("led-status", true) == ESP_OK);
    CHECK(hardware_io_set_led("unknown", true) == ESP_ERR_NOT_FOUND);
    // An expired command never changes OLAT, including a deadline that expires
    // while the driver reads the current MCP state before the output write.
    CHECK(hardware_io_set_relay_until("rly-0/1", true, esp_timer_get_time() - 1)
          == ESP_ERR_TIMEOUT);
    confirmed("rly-0/1", false);
    const auto expires = esp_timer_get_time() + 5'000;
    io_test::elapse_next_read_ms(10);
    CHECK(hardware_io_set_relay_until("rly-0/1", true, expires) == ESP_ERR_TIMEOUT);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 0);
    confirmed("rly-0/1", false);
    CHECK(hardware_io_set_relay_until("rly-0/1", true, esp_timer_get_time() + 100'000) == ESP_OK);
    confirmed("rly-0/1", true);
}

void relay_rmw()
{
    hardware_io_init();
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/2", true) == ESP_OK);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 0x0006);
    CHECK(hardware_io_set_relay("rly-0/1", false) == ESP_OK);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 0x0004);
    CHECK(hardware_io_set_relay("rly-0/7", true) == ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/8", true) == ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/8", true) == ESP_OK);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 0x8084);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
    confirmed("rly-0/8", true);
    CHECK(hardware_io_set_relay("rly-missing", true) == ESP_ERR_NOT_FOUND);
}

void raw_inputs()
{
    hardware_io_init();
    io_test::input_levels(0, 0x20, 0x0101);
    step(100);
    auto j = status();
    auto* high = channel(j.get(), "inputs", "in-0/1");
    CHECK(cJSON_IsTrue(field(high, "value")));
    CHECK(cJSON_IsFalse(field(high, "active")));
    CHECK(cJSON_IsFalse(field(channel(j.get(), "inputs", "in-0/2"), "value")));
    CHECK(cJSON_IsTrue(field(channel(j.get(), "inputs", "in-0/8"), "value")));
    CHECK(hardware_io_set_relay("rly-0/8", true) == ESP_OK);
    j = status();
    CHECK(cJSON_IsTrue(field(channel(j.get(), "inputs", "in-0/8"), "value")));
}

void failures()
{
    hardware_io_init();
    CHECK(hardware_io_set_relay("rly-0/2", true) == ESP_OK);
    io_test::fail_next_write(0, 0x20);
    CHECK(hardware_io_set_relay("rly-0/1", true) != ESP_OK);
    invalid("rly-0/1");
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 4);
    step(1000);
    confirmed("rly-0/2", true);
    io_test::fail_next_read(0, 0x20);
    CHECK(hardware_io_set_relay("rly-0/1", true) != ESP_OK);
    invalid("rly-0/1");
    step(1000);
    confirmed("rly-0/1", false);
    // A write may reach the chip even when its acknowledgement/readback fails.
    // Such an output is unknown, not confirmed ON or falsely reported OFF.
    io_test::fail_readback_after_next_latch_write(0, 0x20);
    CHECK(hardware_io_set_relay("rly-0/1", true) != ESP_OK);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 6);
    invalid("rly-0/1");
    step(1000);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
    // Simulate brownout resetting direction while every relay was already OFF.
    io_test::corrupt_register(0, 0x20, 0, 0xff);
    step(100);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
    std::uint8_t data = 0;
    CHECK(hardware_i2c_read("io-expanders", 0x01, 0, &data, 1) == ESP_ERR_INVALID_ARG);
    CHECK(hardware_i2c_read("io-expanders", 0x68, 255, &data, 2) == ESP_ERR_INVALID_ARG);
    CHECK(hardware_i2c_read("unknown", 0x68, 0, &data, 1) == ESP_ERR_INVALID_STATE);
}

void missing_recovery()
{
    io_test::set_present(0, 0x20, false);
    hardware_io_init();
    invalid("rly-0/1");
    CHECK(hardware_io_set_relay("rly-0/1", true) != ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/9", true) == ESP_OK);
    confirmed("rly-0/9", true);
    io_test::set_present(0, 0x20, true);
    step(1000);
    confirmed("rly-0/1", false);
    confirmed("rly-0/9", true);
}

void scans()
{
    hardware_io_init();
    hardware_io_request_scan();
    for (int i = 0; i < 224; ++i) {
        if (i == 5)
            hardware_io_request_scan();
        step(10);
    }
    auto j = status();
    auto* buses = field(j.get(), "i2c");
    CHECK(cJSON_GetArraySize(buses) == 2);
    for (int i = 0; i < 2; ++i) {
        auto* bus = cJSON_GetArrayItem(buses, i);
        CHECK(cJSON_IsFalse(field(bus, "scanning")));
        auto* addresses = field(bus, "addresses");
        CHECK(cJSON_GetArraySize(addresses) == (i == 0 ? 3 : 1));
        CHECK(cJSON_GetArrayItem(addresses, 0)->valueint == (i == 0 ? 0x20 : 0x44));
    }
    int probes = 0;
    for (const auto& t : io_test::transfers()) {
        CHECK(t.timeout > 0 && t.timeout <= 50);
        if (t.operation == "probe") {
            ++probes;
            CHECK(t.address >= 8 && t.address <= 0x77);
        }
    }
    CHECK(probes == 224);
    hardware_io_request_scan();
    step(15000);
    hardware_io_test_step();
    j = status();
    for (int i = 0; i < 2; ++i)
        CHECK(cJSON_IsFalse(field(cJSON_GetArrayItem(field(j.get(), "i2c"), i), "scanning")));
}

void concurrent()
{
    hardware_io_init();
    io_test::transfer_delay(1);
    std::atomic<bool> okay{true};
    std::vector<std::thread> threads;
    for (int index = 1; index <= 8; ++index)
        threads.emplace_back([index, &okay] {
            for (int i = 0; i < 5; ++i)
                if (hardware_io_set_relay("rly-0/" + std::to_string(index), true) != ESP_OK)
                    okay = false;
        });
    threads.emplace_back([&okay] {
        for (int i = 0; i < 20; ++i) {
            std::array<std::uint8_t, 7> bytes{};
            if (hardware_i2c_read("io-expanders", 0x68, 0, bytes.data(), bytes.size()) != ESP_OK)
                okay = false;
            auto j = status();
        }
    });
    for (auto& thread : threads)
        thread.join();
    CHECK(okay);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 0x80fe);
    CHECK(io_test::max_parallel(0) == 1);
}

using Image = std::array<std::uint16_t, 2>;

Image sparse_image()
{
    Image image{};
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.relayCount; ++i) {
        const auto& relay = board.relays[i];
        const bool on = i % 3 == 0 || i + 1 == board.relayCount;
        CHECK(hardware_io_set_relay(relay.name, on) == ESP_OK);
        if (on == relay.activeHigh)
            image.at(relay.expanderIndex) |= static_cast<std::uint16_t>(1U << relay.pin);
    }
    return image;
}

void image_confirmed(const Image& image)
{
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.expanderCount; ++i) {
        const auto& expander = board.expanders[i];
        CHECK(io_test::register_pair(0, expander.address, 0)
              == static_cast<std::uint16_t>(~expander.relayMask));
        CHECK(io_test::register_pair(0, expander.address, 0x0c) == 0);
        CHECK(io_test::register_pair(0, expander.address, 0x14) == image.at(i));
        for (auto reg : {2, 4, 6, 8, 10})
            CHECK(io_test::register_pair(0, expander.address, reg) == 0);
    }
    for (std::size_t i = 0; i < board.relayCount; ++i) {
        const auto& relay = board.relays[i];
        confirmed(relay.name,
                  ((image.at(relay.expanderIndex) & (1U << relay.pin)) != 0) == relay.activeHigh);
    }
}

std::uint32_t generation(const char* input = "in-0/1")
{
    HardwareIoChannelState state;
    CHECK(hardware_io_read_input(input, state) == ESP_OK);
    CHECK(state.valid && state.fresh);
    return state.generation;
}

void input_unknown(const char* id)
{
    HardwareIoChannelState state;
    CHECK(hardware_io_read_input(id, state) == ESP_OK);
    CHECK(!state.valid && !state.fresh);
    auto j = status();
    auto* input = channel(j.get(), "inputs", id);
    CHECK(cJSON_IsFalse(field(input, "valid")));
    CHECK(cJSON_IsNull(field(input, "value")));
}

std::size_t transfer_count(std::uint8_t address)
{
    std::size_t count = 0;
    for (const auto& transfer : io_test::transfers())
        if (transfer.bus == 0 && transfer.address == address)
            ++count;
    return count;
}

void emi_reset()
{
    hardware_io_init();
    const auto image = sparse_image();
    const auto firstGeneration = generation(), secondGeneration = generation("in-0/9");
    io_test::reset_mcp(0, 0x20);
    io_test::reset_mcp(0, 0x21);
    step(20);
    image_confirmed(image);
    CHECK(generation() != firstGeneration);
    CHECK(generation("in-0/9") != secondGeneration);
    // All 16 outputs, including channels with no controller owner, retain RAM intent.
    for (const auto& transfer : io_test::transfers())
        if (transfer.operation == "write" && transfer.reg == 0 && transfer.data.size() == 2) {
            CHECK((transfer.data[0] & 0x80) == 0);
            CHECK((transfer.data[1] & 0x80) == 0);
        }
}

void emi_layout()
{
    hardware_io_init();
    const auto image = sparse_image();
    for (auto iocon : {0x20, 0x80, 0xa0, 0xfe, 0x40, 0x16}) {
        const auto before = generation();
        io_test::corrupt_register(0, 0x20, 0x0a, static_cast<std::uint8_t>(iocon));
        step(20);
        image_confirmed(image);
        CHECK(generation() != before);
    }
}

void emi_fields()
{
    hardware_io_init();
    const auto image = sparse_image();
    for (auto reg : {0, 2, 4, 6, 8, 12}) {
        const auto before = generation();
        io_test::corrupt_pair(0, 0x20, reg, reg == 0 ? 0xffff : 0x0101);
        step(20);
        image_confirmed(image);
        CHECK(generation() != before);
    }
    // EMI can force a requested-OFF bit ON or erase a requested-ON bit. Neither
    // observation is allowed to become the new desired image.
    for (auto latch :
         {static_cast<std::uint16_t>(image[0] | 4), static_cast<std::uint16_t>(image[0] & ~2)}) {
        io_test::corrupt_pair(0, 0x20, 0x14, latch);
        step(20);
        image_confirmed(image);
    }
}

void emi_readback()
{
    hardware_io_init();
    const auto image = sparse_image();
    const auto before = generation();
    io_test::corrupt_next_read(0, 0x20, 0x14, 2);
    step(20);
    image_confirmed(image);
    CHECK(generation() != before);
    io_test::force_gpio(0, 0x20, 2, 0);
    step(20);
    invalid("rly-0/1");
    input_unknown("in-0/1");
    // The independent chip remains operational during a persistent bad GPIO.
    confirmed("rly-0/16", true);
    io_test::force_gpio(0, 0x20, 0, 0);
    step(1000);
    image_confirmed(image);
}

void emi_repair_faults()
{
    hardware_io_init();
    const auto image = sparse_image();
    io_test::reset_mcp(0, 0x20);
    io_test::nack_after_next_write_to(0, 0x20, 0x0c);
    step(20);
    invalid("rly-0/1");
    input_unknown("in-0/1");
    const auto failedCount = transfer_count(0x20);
    step(100);
    CHECK(transfer_count(0x20) == failedCount);
    step(900);
    image_confirmed(image);
    io_test::reset_mcp(0, 0x20);
    io_test::ignore_next_nonzero_latch_write(0, 0x20);
    step(20);
    invalid("rly-0/1");
    input_unknown("in-0/1");
    step(1000);
    image_confirmed(image);
    // A silently ignored layout-normalization write must fail the single-byte
    // IOCON guard before ordinary OLAT/direction writes use the wrong map.
    for (auto iocon : {0x80, 0x20}) {
        io_test::corrupt_register(0, 0x20, 0x0a, static_cast<std::uint8_t>(iocon));
        io_test::ignore_next_write_to(0, 0x20, iocon == 0x80 ? 0x05 : 0x0a);
        const auto begin = io_test::transfers().size();
        step(20);
        invalid("rly-0/1");
        input_unknown("in-0/1");
        const auto history = io_test::transfers();
        for (std::size_t i = begin; i < history.size(); ++i)
            if (history[i].address == 0x20 && history[i].operation == "write")
                CHECK(history[i].reg != 0 && history[i].reg != 0x14);
        step(1000);
        image_confirmed(image);
    }
}

void off_revocation()
{
    hardware_io_init();
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/2", true) == ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/9", true) == ESP_OK);
    io_test::set_present(0, 0x20, false);
    CHECK(hardware_io_set_relay("rly-0/1", false) != ESP_OK);
    invalid("rly-0/1");
    CHECK(hardware_io_set_relay("rly-0/3", true) != ESP_OK);  // Failed ON must not queue.
    io_test::set_present(0, 0x20, true);
    step(1000);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
    confirmed("rly-0/3", false);
    confirmed("rly-0/9", true);
    io_test::nack_after_next_write(0, 0x20);
    CHECK(hardware_io_set_relay("rly-0/2", false) != ESP_OK);
    step(1000);
    confirmed("rly-0/2", false);
    confirmed("rly-0/9", true);
}

void failed_on()
{
    hardware_io_init();
    CHECK(hardware_io_set_relay("rly-0/2", true) == ESP_OK);
    io_test::nack_after_next_write(0, 0x20);
    CHECK(hardware_io_set_relay("rly-0/1", true) != ESP_OK);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 6);
    invalid("rly-0/1");
    step(1000);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
    io_test::fail_readback_after_next_latch_write(0, 0x20);
    CHECK(hardware_io_set_relay("rly-0/1", true) != ESP_OK);
    invalid("rly-0/1");
    step(1000);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
    CHECK(hardware_io_set_relay_until("rly-0/1", true, esp_timer_get_time() - 1)
          == ESP_ERR_TIMEOUT);
    // A healthy preread can consume the delivery window. This rejected OFF
    // must preserve the confirmed ON intent, unlike an OFF that hits I/O failure.
    const auto offDeadline = esp_timer_get_time() + 5'000;
    io_test::elapse_next_read_ms(10);
    CHECK(hardware_io_set_relay_until("rly-0/2", false, offDeadline) == ESP_ERR_TIMEOUT);
    CHECK(io_test::register_pair(0, 0x20, 0x14) == 4);
    confirmed("rly-0/2", true);
    io_test::reset_mcp(0, 0x20);
    step(20);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
}

void recovery_visibility()
{
    hardware_io_init();
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    io_test::reset_mcp(0, 0x20);
    io_test::transfer_delay(1);
    io_test::advance(20);
    std::atomic<bool> done{false}, okay{true};
    std::thread recovery([&] {
        hardware_io_test_step();
        done = true;
    });
    do {
        HardwareIoChannelState state;
        if (hardware_io_read_relay("rly-0/1", state) != ESP_OK || (state.valid && !state.value))
            okay = false;
    } while (!done);
    recovery.join();
    CHECK(okay);
    confirmed("rly-0/1", true);
    CHECK(io_test::max_parallel(0) == 1);
}

void controller_policy()
{
    hardware_io_init();
    CHECK(hardware_io_set_relay_recovery("rly-0/1", HardwareRelayRecovery::Controller) == ESP_OK);
    CHECK(hardware_io_set_relay_recovery("unknown", HardwareRelayRecovery::Controller)
          == ESP_ERR_NOT_FOUND);
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/2", true) == ESP_OK);
    io_test::corrupt_pair(0, 0x20, 0x14, 0);
    step(20);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);  // One chip, different recovery policies.
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    io_test::fail_next_read(0, 0x20);
    step(20);
    invalid("rly-0/1");
    step(1000);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    step(301);
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);  // A fresh-looking read cannot replay stale controller ON.
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    io_test::advance(301);
    HardwareIoChannelState expired;
    CHECK(hardware_io_read_relay("rly-0/1", expired) == ESP_OK);
    CHECK(!expired.valid && !expired.fresh);
    hardware_io_test_step();
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
    // A later explicit controller decision can authorize ON again; marking the
    // ownership policy itself is metadata and never queues an ON command.
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    confirmed("rly-0/1", true);
    CHECK(hardware_io_set_relay_recovery("rly-0/1", HardwareRelayRecovery::Buffered) == ESP_OK);
    io_test::reset_mcp(0, 0x20);
    step(20);
    confirmed("rly-0/1", true);
    confirmed("rly-0/2", true);
}

void json_stale()
{
    hardware_io_init();
    CHECK(hardware_io_set_relay_recovery("rly-0/1", HardwareRelayRecovery::Controller) == ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/1", true) == ESP_OK);
    CHECK(hardware_io_set_relay("rly-0/2", true) == ESP_OK);
    io_test::advance(301);  // No worker or typed read is allowed to expire the cache first.
    auto snapshot = status();
    for (const char* id : {"rly-0/1", "rly-0/2"}) {
        auto* row = channel(snapshot.get(), "relays", id);
        CHECK(cJSON_IsFalse(field(row, "valid")));
        CHECK(cJSON_IsNull(field(row, "value")));
        CHECK(cJSON_IsNull(field(row, "level")));
    }
    auto* input = channel(snapshot.get(), "inputs", "in-0/1");
    CHECK(cJSON_IsFalse(field(input, "valid")));
    CHECK(cJSON_IsNull(field(input, "value")));
    hardware_io_test_step();
    confirmed("rly-0/1", false);
    confirmed("rly-0/2", true);
}

void fram_transfer()
{
    const auto& profile = board_profile_active();
    CHECK(profile.fram && profile.fram->address == 0x50 && profile.fram->capacityBytes == 8192);
    CHECK(std::string(profile.fram->i2cBusId) == "io-expanders");
    Json metadata(board_profile_json(profile), cJSON_Delete);
    CHECK(metadata && cJSON_IsTrue(field(field(metadata.get(), "capabilities"), "fram")));
    CHECK(field(field(metadata.get(), "fram"), "address")->valueint == 0x50);
    hardware_io_init();
    io_test::set_present(0, 0x50, true);
    std::array<std::uint8_t, 89> source{}, destination{};
    for (std::size_t i = 0; i < source.size(); ++i)
        source[i] = static_cast<std::uint8_t>(i ^ 0xa5);
    CHECK(fram_write(0x00fa, source.data(), source.size()) == ESP_OK);
    CHECK(fram_read(0x00fa, destination.data(), destination.size()) == ESP_OK);
    CHECK(source == destination);
    const std::uint8_t last = 0x35;
    std::uint8_t result = 0;
    CHECK(fram_write(8191, &last, 1) == ESP_OK);
    CHECK(fram_read(8191, &result, 1) == ESP_OK && result == last);
    bool crossed = false;
    for (const auto& transfer : io_test::transfers()) {
        if (transfer.address != 0x50)
            continue;
        CHECK(transfer.bus == 0 && transfer.timeout == 20);
        CHECK(transfer.data.size() <= 32);
        crossed = crossed || transfer.reg == 0x011a;
    }
    CHECK(crossed);
}

void fram_bounds()
{
    hardware_io_init();
    io_test::set_present(0, 0x50, true);
    const auto history = io_test::transfers().size();
    std::array<std::uint8_t, 64> data{};
    for (const auto offset : {8191, 8192, 65535}) {
        CHECK(fram_write(static_cast<std::uint16_t>(offset), data.data(), 2)
              == ESP_ERR_INVALID_ARG);
        CHECK(fram_read(static_cast<std::uint16_t>(offset), data.data(), 2) == ESP_ERR_INVALID_ARG);
    }
    CHECK(fram_write(0, data.data(), 0) == ESP_ERR_INVALID_ARG);
    CHECK(fram_read(0, nullptr, 1) == ESP_ERR_INVALID_ARG);
    CHECK(fram_write(0, data.data(), 8193) == ESP_ERR_INVALID_ARG);
    CHECK(hardware_i2c_memory_read("io-expanders", 0x50, 65535, data.data(), 2)
          == ESP_ERR_INVALID_ARG);
    CHECK(hardware_i2c_memory_write("io-expanders", 0x50, 0, data.data(), 33)
          == ESP_ERR_INVALID_ARG);
    CHECK(hardware_i2c_memory_read("io-expanders", 0x07, 0, data.data(), 1) == ESP_ERR_INVALID_ARG);
    CHECK(io_test::transfers().size() == history);
}

void fram_failures()
{
    std::array<std::uint8_t, 65> data{};
    CHECK(fram_read(0, data.data(), data.size()) == ESP_ERR_INVALID_STATE);
    hardware_io_init();
    CHECK(fram_write(0, data.data(), data.size()) == ESP_ERR_TIMEOUT);
    io_test::set_present(0, 0x50, true);
    io_test::fail_write_after(0, 0x50, 1);
    const auto before = io_test::transfers().size();
    CHECK(fram_write(0x0f00, data.data(), data.size()) == ESP_ERR_TIMEOUT);
    auto transfers = io_test::transfers();
    CHECK(transfers.size() == before + 2 && transfers.back().reg == 0x0f20);
    io_test::fail_read_after(0, 0x50, 1);
    CHECK(fram_read(0x0f00, data.data(), data.size()) == ESP_ERR_TIMEOUT);
    transfers = io_test::transfers();
    CHECK(transfers.size() == before + 4 && transfers.back().reg == 0x0f20);
    CHECK(fram_write(0, data.data(), data.size()) == ESP_OK);
    CHECK(fram_read(0, data.data(), data.size()) == ESP_OK);
    step(20);
    confirmed("rly-0/1", false);
}

void fram_concurrent()
{
    hardware_io_init();
    io_test::set_present(0, 0x50, true);
    io_test::transfer_delay(1);
    std::thread memory([] {
        std::array<std::uint8_t, 80> data{};
        for (int i = 0; i < 8; ++i) {
            CHECK(fram_write(0x1f00, data.data(), data.size()) == ESP_OK);
            CHECK(fram_read(0x1f00, data.data(), data.size()) == ESP_OK);
        }
    });
    std::thread relay([] {
        for (int i = 0; i < 8; ++i)
            CHECK(hardware_io_set_relay("rly-0/1", (i & 1) != 0) == ESP_OK);
    });
    memory.join();
    relay.join();
    CHECK(io_test::max_parallel(0) == 1);
    confirmed("rly-0/1", true);
}

int main(int argc, char** argv)
{
    CHECK(argc == 2);
    const std::string name = argv[1];
    if (name == "fake_map")
        fake_map();
    else if (name == "safe_init")
        safe_init();
    else if (name == "relay_rmw")
        relay_rmw();
    else if (name == "raw_inputs")
        raw_inputs();
    else if (name == "failures")
        failures();
    else if (name == "missing_recovery")
        missing_recovery();
    else if (name == "scans")
        scans();
    else if (name == "concurrent")
        concurrent();
    else if (name == "emi_reset")
        emi_reset();
    else if (name == "emi_layout")
        emi_layout();
    else if (name == "emi_fields")
        emi_fields();
    else if (name == "emi_readback")
        emi_readback();
    else if (name == "emi_repair_faults")
        emi_repair_faults();
    else if (name == "off_revocation")
        off_revocation();
    else if (name == "failed_on")
        failed_on();
    else if (name == "recovery_visibility")
        recovery_visibility();
    else if (name == "controller_policy")
        controller_policy();
    else if (name == "json_stale")
        json_stale();
    else if (name == "fram_transfer")
        fram_transfer();
    else if (name == "fram_bounds")
        fram_bounds();
    else if (name == "fram_failures")
        fram_failures();
    else if (name == "fram_concurrent")
        fram_concurrent();
    else
        CHECK(false);
    std::printf("FCPLCn hardware I/O: %s passed\n", argv[1]);
}
