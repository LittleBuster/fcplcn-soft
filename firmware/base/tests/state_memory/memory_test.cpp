#include "hardware/board_profile.h"
#include "hardware/eeprom.h"
#include "hardware/fram.h"
#include "hardware/hardware_io.h"
#include "hardware/state_memory.h"
#include "config/state_journal.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
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

namespace {
struct Transfer {
    char operation;
    std::uint16_t offset;
    std::vector<std::uint8_t> bytes;
    std::thread::id thread;
};

std::array<std::uint8_t, 65536> bytes;
std::vector<Transfer> transfers;
std::mutex bus_mutex;
std::atomic<std::int64_t> now_us{1000000};
std::int64_t busy_until = 0;
std::uint32_t cycle_us = 5000;
std::uint32_t probe_elapsed_us = 0;
unsigned reads = 0, writes = 0, probes = 0, waits = 0, foreign_traffic = 0;
int fail_write = -1, fail_read = -1;
int cut_write = -1, stuck_after_write = -1;
esp_err_t probe_error = ESP_OK;
bool ignore_write = false, is_eeprom = true, probe_stuck = false, concurrent_delays = false;
bool transaction_active = false;

bool target(std::string_view bus, std::uint8_t address)
{
    const auto& memory = *board_profile_active().stateMemory;
    return bus == memory.i2cBusId && address == memory.address;
}

unsigned operation_count(char operation)
{
    return static_cast<unsigned>(
        std::count_if(transfers.begin(), transfers.end(), [=](const auto& t) {
            return t.operation == operation;
        }));
}

void round_trip(std::uint16_t offset, std::size_t length)
{
    std::vector<std::uint8_t> source(length), destination(length);
    for (std::size_t i = 0; i < length; ++i)
        source[i] = static_cast<std::uint8_t>(i * 17);
    CHECK(state_memory_write(offset, source.data(), source.size()) == ESP_OK);
    CHECK(state_memory_read(offset, destination.data(), destination.size()) == ESP_OK);
    CHECK(source == destination);
}

void fram_dispatch()
{
    is_eeprom = false;
    CHECK(board_profile_activate(kDefaultBoardProfileId));
    CHECK(eeprom_read(0, bytes.data(), 1) == ESP_ERR_NOT_SUPPORTED);
    CHECK(eeprom_write(0, bytes.data(), 1) == ESP_ERR_NOT_SUPPORTED);
    round_trip(8170, 22);
    CHECK(probes == 0 && waits == 0);
    CHECK(state_memory_read(8191, bytes.data(), 2) == ESP_ERR_INVALID_ARG);
    CHECK(operation_count('w') == 1);
}

void eeprom_dispatch()
{
    CHECK(fram_read(0, bytes.data(), 1) == ESP_ERR_NOT_SUPPORTED);
    CHECK(fram_write(0, bytes.data(), 1) == ESP_ERR_NOT_SUPPORTED);
    round_trip(65500, 36);
    CHECK(probes > writes && writes == 2);
    CHECK(bytes.front() == 0xff);
}

void eeprom_bounds()
{
    const auto history = transfers.size();
    CHECK(state_memory_read(65535, bytes.data(), 2) == ESP_ERR_INVALID_ARG);
    CHECK(state_memory_write(65535, bytes.data(), 2) == ESP_ERR_INVALID_ARG);
    CHECK(state_memory_read(0, nullptr, 1) == ESP_ERR_INVALID_ARG);
    CHECK(state_memory_write(0, nullptr, 1) == ESP_ERR_INVALID_ARG);
    CHECK(state_memory_read(0, bytes.data(), 0) == ESP_ERR_INVALID_ARG);
    CHECK(state_memory_write(0, bytes.data(), 0) == ESP_ERR_INVALID_ARG);
    CHECK(state_memory_read(0, bytes.data(), SIZE_MAX) == ESP_ERR_INVALID_ARG);
    CHECK(state_memory_write(0, bytes.data(), SIZE_MAX) == ESP_ERR_INVALID_ARG);
    CHECK(transfers.size() == history);
    round_trip(65535, 1);
}

void eeprom_page_wrap()
{
    // A realistic fake wraps bytes inside a physical page if the driver crosses it.
    // The unaligned range touches four pages and both sides of every boundary.
    round_trip(127, 259);
    CHECK(bytes[126] == 0xff && bytes[386] == 0xff);
    bool ended_page = false, started_page = false;
    for (const auto& t : transfers) {
        if (t.operation != 'w')
            continue;
        CHECK(!t.bytes.empty() && t.bytes.size() <= 32);
        CHECK(t.offset / 128 == (t.offset + t.bytes.size() - 1) / 128);
        if (t.offset == 127)
            ended_page = t.bytes.size() == 1;
        if (t.offset == 128)
            started_page = true;
    }
    CHECK(ended_page && started_page);
}

void eeprom_busy()
{
    round_trip(120, 48);
    CHECK(waits > 0 && foreign_traffic == waits);
    CHECK(now_us >= 1000000 + static_cast<std::int64_t>(writes) * cycle_us);
    CHECK(probes >= writes * 10);
    // Reads were never issued during internal programming: the fake rejects them.
    CHECK(reads > writes);
}

void eeprom_timeout()
{
    cycle_us = 50000;
    const std::uint8_t value = 0x55;
    const auto start = now_us.load();
    CHECK(state_memory_write(0, &value, 1) == ESP_ERR_TIMEOUT);
    CHECK(writes == 1);
    CHECK(now_us - start == 10000);
    // Lost ACK does not cause a data-write retry or a second chunk.
    CHECK(operation_count('w') == 1);
}

void eeprom_errors()
{
    const std::array<std::uint8_t, 40> source{};
    fail_write = 0;
    CHECK(state_memory_write(0, source.data(), source.size()) == ESP_FAIL);
    CHECK(writes == 1 && waits == 0);
    fail_write = -1;
    fail_read = reads;
    CHECK(state_memory_write(64, source.data(), 1) == ESP_FAIL);
    CHECK(writes == 1);
    fail_read = -1;
    probe_error = ESP_ERR_INVALID_STATE;
    CHECK(state_memory_read(0, bytes.data(), 1) == ESP_ERR_INVALID_STATE);
    CHECK(waits == 0);
}

void eeprom_transport_deadline()
{
    probe_elapsed_us = 20000;
    probe_error = ESP_FAIL;
    const auto start = now_us.load();
    std::uint8_t output = 0;
    CHECK(state_memory_read(0, &output, 1) == ESP_FAIL);
    CHECK(now_us - start == 20000);
    CHECK(probes == 1 && reads == 0 && writes == 0 && waits == 0);
    // An already-running transport can complete after the polling deadline.
    // Even an eventual ACK must not be mistaken for a timely successful operation.
    probe_elapsed_us = 11000;
    probe_error = ESP_OK;
    CHECK(state_memory_read(0, &output, 1) == ESP_ERR_TIMEOUT);
    CHECK(probes == 2 && reads == 0 && writes == 0 && waits == 0);
}

void eeprom_verify()
{
    const std::uint8_t source = 0x55;
    ignore_write = true;
    CHECK(state_memory_write(0, &source, 1) == ESP_ERR_INVALID_RESPONSE);
    CHECK(writes == 1);
    ignore_write = false;
    // A transport error on readback also must remain a failure after a durable write.
    fail_read = reads + 1;
    CHECK(state_memory_write(0, &source, 1) == ESP_FAIL);
    CHECK(writes == 2 && bytes[0] == source);
}

void eeprom_unchanged()
{
    round_trip(13, 200);
    const auto programmed = writes;
    const auto start = now_us.load();
    std::vector<std::uint8_t> existing(bytes.begin() + 13, bytes.begin() + 213);
    CHECK(state_memory_write(13, existing.data(), existing.size()) == ESP_OK);
    CHECK(writes == programmed && now_us == start);
    existing[100] ^= 0x7f;
    CHECK(state_memory_write(13, existing.data(), existing.size()) == ESP_OK);
    CHECK(writes == programmed + 1);
}

void eeprom_concurrent()
{
    concurrent_delays = true;
    std::array<std::uint8_t, 120> first{}, second{};
    first.fill(0x11);
    second.fill(0x22);
    std::thread a([&] {
        CHECK(state_memory_write(0, first.data(), first.size()) == ESP_OK);
    });
    std::thread b([&] {
        CHECK(state_memory_write(256, second.data(), second.size()) == ESP_OK);
    });
    a.join();
    b.join();
    unsigned transitions = 0;
    auto owner = transfers.front().thread;
    for (const auto& t : transfers)
        if (t.thread != owner) {
            owner = t.thread;
            ++transitions;
        }
    CHECK(transitions == 1);
    CHECK(std::equal(first.begin(), first.end(), bytes.begin()));
    CHECK(std::equal(second.begin(), second.end(), bytes.begin() + 256));
}

StateJournalKey journal_key(std::uint8_t seed = 0x41)
{
    StateJournalKey key{};
    for (std::size_t i = 0; i < key.size(); ++i)
        key[i] = static_cast<std::uint8_t>(seed + i);
    return key;
}

StateJournalPayload journal_payload(std::uint8_t seed)
{
    StateJournalPayload payload(kStateJournalMaxPayloadBytes);
    for (std::size_t i = 0; i < payload.size(); ++i)
        payload[i] = static_cast<std::uint8_t>(seed + i);
    return payload;
}

void reconnect_memory()
{
    now_us += 10000;
    probe_stuck = false;
    busy_until = now_us;
    cut_write = stuck_after_write = -1;
}

void assert_previous_slot(const std::array<std::uint8_t, 65536>& image)
{
    CHECK(std::equal(image.begin(), image.begin() + 256, bytes.begin()));
    CHECK(std::equal(image.begin() + kStateJournalReservedBytes,
                     image.end(),
                     bytes.begin() + kStateJournalReservedBytes));
}

void journal_roundtrip()
{
    const auto key = journal_key();
    const auto first = journal_payload(0x11), second = journal_payload(0x31);
    StateJournalPayload output{0xee};
    CHECK(state_journal_load(key, output) == ESP_ERR_NOT_FOUND);
    CHECK(output == StateJournalPayload{0xee});
    CHECK(state_journal_save(key, first) == ESP_OK);
    CHECK(state_journal_status().valid && state_journal_status().generation == 1);
    CHECK(state_journal_load(key, output) == ESP_OK && output == first);
    const auto image = bytes;
    CHECK(state_journal_save(key, second) == ESP_OK);
    CHECK(state_journal_load(key, output) == ESP_OK && output == second);
    CHECK(state_journal_status().valid && state_journal_status().generation == 2);
    assert_previous_slot(image);
    CHECK(probes > writes && waits > 0 && foreign_traffic == waits);
    for (const auto& t : transfers)
        if (t.operation == 'w') {
            CHECK(t.offset + t.bytes.size() <= kStateJournalReservedBytes);
            CHECK(t.offset / 128 == (t.offset + t.bytes.size() - 1) / 128);
        }
}

void journal_power_cut()
{
    const auto key = journal_key();
    const auto first = journal_payload(0x21), second = journal_payload(0x71);
    CHECK(state_journal_save(key, first) == ESP_OK);
    const auto image = bytes;
    const auto initial_writes = writes;
    CHECK(state_journal_save(key, second) == ESP_OK);
    const auto candidate_writes = writes - initial_writes;
    CHECK(candidate_writes >= 8);  // Invalid marker, page-split body, final commit marker.
    for (unsigned failure = 0; failure < candidate_writes; ++failure) {
        bytes = image;
        reconnect_memory();
        const auto start_writes = writes;
        cut_write = static_cast<int>(writes + failure);
        // Cut programs only a prefix of the selected transaction, then loses the device.
        CHECK(state_journal_save(key, second) == ESP_FAIL);
        CHECK(writes - start_writes == failure + 1);
        CHECK(!state_journal_status().valid);
        assert_previous_slot(image);
        reconnect_memory();
        StateJournalPayload output;
        CHECK(state_journal_load(key, output) == ESP_OK && output == first);
        CHECK(state_journal_status().generation == 1);
        // The interrupted candidate may be reused only after transport recovery.
        CHECK(state_journal_save(key, second) == ESP_OK);
        CHECK(state_journal_load(key, output) == ESP_OK && output == second);
    }
}

void journal_busy_disconnect()
{
    const auto key = journal_key();
    const auto first = journal_payload(0x41), second = journal_payload(0x81);
    CHECK(state_journal_save(key, first) == ESP_OK);
    const auto image = bytes;
    // The invalid marker is durable; the first candidate-body write then starts
    // an internally busy/disconnected state that never ACKs until reconnect.
    stuck_after_write = static_cast<int>(writes + 1);
    CHECK(state_journal_save(key, second) == ESP_ERR_TIMEOUT);
    CHECK(!state_journal_status().valid);
    assert_previous_slot(image);
    StateJournalPayload output{0xee};
    CHECK(state_journal_load(key, output) == ESP_ERR_TIMEOUT);
    CHECK(output == StateJournalPayload{0xee});
    reconnect_memory();
    CHECK(state_journal_load(key, output) == ESP_OK && output == first);
    CHECK(state_journal_status().generation == 1);
}

void journal_integrity()
{
    const auto key = journal_key();
    const auto first = journal_payload(0x51), second = journal_payload(0x91);
    CHECK(state_journal_save(key, first) == ESP_OK);
    CHECK(state_journal_save(key, second) == ESP_OK);
    StateJournalPayload output{0xab, 0xcd};
    const auto programmed = writes;
    CHECK(state_journal_load(journal_key(0x01), output) == ESP_ERR_NOT_FOUND);
    CHECK((output == StateJournalPayload{0xab, 0xcd}));
    CHECK(writes == programmed);
    // Corrupt the newest committed payload: CRC verification must fall back to slot zero.
    bytes[256 + 40 + 5] ^= 0x80;
    CHECK(state_journal_load(key, output) == ESP_OK && output == first);
    CHECK(state_journal_status().generation == 1);
    bytes[40 + 7] ^= 0x40;
    output = {0xab, 0xcd};
    CHECK(state_journal_load(key, output) == ESP_ERR_INVALID_RESPONSE);
    CHECK((output == StateJournalPayload{0xab, 0xcd}));
    CHECK(!state_journal_status().valid && writes == programmed);
}

void journal_commit_ack_loss()
{
    const auto key = journal_key();
    const auto first = journal_payload(0x61), second = journal_payload(0xa1);
    CHECK(state_journal_save(key, first) == ESP_OK);
    const auto image = bytes;
    const auto initial_writes = writes;
    CHECK(state_journal_save(key, second) == ESP_OK);
    const auto candidate_writes = writes - initial_writes;
    bytes = image;
    reconnect_memory();
    stuck_after_write = static_cast<int>(writes + candidate_writes - 1);
    // The final commit-marker data can reach EEPROM before all subsequent probes NACK.
    // The caller receives an honest failure and the previous committed slot is untouched.
    CHECK(state_journal_save(key, second) == ESP_ERR_TIMEOUT);
    CHECK(!state_journal_status().valid);
    assert_previous_slot(image);
    reconnect_memory();
    StateJournalPayload output;
    CHECK(state_journal_load(key, output) == ESP_OK && output == second);
    CHECK(state_journal_status().generation == 2);
    // This ambiguous-completion contract requires caller rollback/inhibit on failed save;
    // it does not promise that an unacknowledged physical write was never committed.
}
}  // namespace

std::int64_t esp_timer_get_time()
{
    return now_us.load();
}

void esp_rom_delay_us(std::uint32_t delay)
{
    CHECK(!transaction_active);
    // A separate bus client can run at every EEPROM polling pause.
    CHECK(bus_mutex.try_lock());
    ++foreign_traffic;
    bus_mutex.unlock();
    ++waits;
    now_us += delay;
}

esp_err_t hardware_i2c_probe(std::string_view bus, std::uint8_t address, std::uint32_t timeout)
{
    CHECK(timeout > 0 && timeout <= 20);
    std::lock_guard<std::mutex> lock(bus_mutex);
    CHECK(target(bus, address));
    ++probes;
    transfers.push_back({'p', 0, {}, std::this_thread::get_id()});
    now_us += probe_elapsed_us;
    if (probe_error != ESP_OK)
        return probe_error;
    return probe_stuck || now_us < busy_until ? ESP_ERR_NOT_FOUND : ESP_OK;
}

esp_err_t hardware_i2c_memory_read(std::string_view bus,
                                   std::uint8_t address,
                                   std::uint16_t offset,
                                   std::uint8_t* output,
                                   std::size_t length)
{
    std::lock_guard<std::mutex> lock(bus_mutex);
    transaction_active = true;
    CHECK(target(bus, address) && length > 0 && length <= 32);
    CHECK(length <= bytes.size() - offset);
    transfers.push_back({'r', offset, {}, std::this_thread::get_id()});
    const bool failed = fail_read == static_cast<int>(reads++);
    if (concurrent_delays)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    transaction_active = false;
    if (failed)
        return ESP_FAIL;
    if (is_eeprom && now_us < busy_until)
        return ESP_ERR_NOT_FOUND;
    std::copy_n(bytes.begin() + offset, length, output);
    return ESP_OK;
}

esp_err_t hardware_i2c_memory_write(std::string_view bus,
                                    std::uint8_t address,
                                    std::uint16_t offset,
                                    const std::uint8_t* input,
                                    std::size_t length)
{
    std::lock_guard<std::mutex> lock(bus_mutex);
    transaction_active = true;
    CHECK(target(bus, address) && length > 0 && length <= 32);
    CHECK(length <= bytes.size() - offset);
    transfers.push_back({'w', offset, {input, input + length}, std::this_thread::get_id()});
    const auto current_write = static_cast<int>(writes++);
    const bool failed = fail_write == current_write;
    transaction_active = false;
    if (failed)
        return ESP_FAIL;
    if (is_eeprom && now_us < busy_until)
        return ESP_ERR_NOT_FOUND;
    const bool cut = cut_write == current_write;
    const auto programmed = cut ? length / 2 : length;
    for (std::size_t i = 0; i < programmed; ++i) {
        const auto destination = is_eeprom ? (offset / 128) * 128 + (offset + i) % 128 : offset + i;
        if (!ignore_write)
            bytes[destination] = input[i];
    }
    if (is_eeprom)
        busy_until = now_us + cycle_us;
    if (cut || stuck_after_write == current_write)
        probe_stuck = true;
    if (cut)
        return ESP_FAIL;
    return ESP_OK;
}

int main(int argc, char** argv)
{
    CHECK(argc == 2);
    bytes.fill(0xff);
    const std::string name = argv[1];
    if (name == "fram_dispatch") {
        fram_dispatch();
    } else {
        CHECK(board_profile_activate("fcplc-080806-3v1"));
        if (name == "eeprom_dispatch")
            eeprom_dispatch();
        else if (name == "eeprom_bounds")
            eeprom_bounds();
        else if (name == "eeprom_page_wrap")
            eeprom_page_wrap();
        else if (name == "eeprom_busy")
            eeprom_busy();
        else if (name == "eeprom_timeout")
            eeprom_timeout();
        else if (name == "eeprom_errors")
            eeprom_errors();
        else if (name == "eeprom_transport_deadline")
            eeprom_transport_deadline();
        else if (name == "eeprom_verify")
            eeprom_verify();
        else if (name == "eeprom_unchanged")
            eeprom_unchanged();
        else if (name == "eeprom_concurrent")
            eeprom_concurrent();
        else if (name == "journal_roundtrip")
            journal_roundtrip();
        else if (name == "journal_power_cut")
            journal_power_cut();
        else if (name == "journal_busy_disconnect")
            journal_busy_disconnect();
        else if (name == "journal_integrity")
            journal_integrity();
        else if (name == "journal_commit_ack_loss")
            journal_commit_ack_loss();
        else
            CHECK(false);
    }
    std::printf("FCPLCn state memory: %s passed\n", argv[1]);
}
