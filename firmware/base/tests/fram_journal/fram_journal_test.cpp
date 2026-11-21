#include "config/state_journal.h"
#include "hardware/fram.h"
#include "util/checksum.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
#define REQUIRE(condition)                                                                         \
    do {                                                                                           \
        if (!(condition))                                                                          \
            throw std::runtime_error(std::string(__func__) + ":" + std::to_string(__LINE__)        \
                                     + ": " #condition);                                           \
    } while (false)

constexpr std::size_t kSlotBytes = 256;
std::array<std::uint8_t, 8192> memory;
bool powered = true;
bool fail_reads = false;
bool corrupt_write = false;
std::size_t written = 0;
std::size_t cut_after = std::numeric_limits<std::size_t>::max();
unsigned read_calls = 0;
unsigned fail_read_at = 0;
unsigned write_calls = 0;

StateJournalKey key(std::uint8_t value)
{
    StateJournalKey result{};
    result.fill(value);
    return result;
}

void reset(std::uint8_t fill = 0xff)
{
    memory.fill(fill);
    powered = true;
    fail_reads = corrupt_write = false;
    written = 0;
    cut_after = std::numeric_limits<std::size_t>::max();
    read_calls = fail_read_at = write_calls = 0;
}

void reconnect()
{
    powered = true;
    cut_after = std::numeric_limits<std::size_t>::max();
    fail_reads = false;
    fail_read_at = 0;
}

void expect_payload(const StateJournalKey& identity, const StateJournalPayload& expected)
{
    StateJournalPayload loaded{0x73};
    REQUIRE(state_journal_load(identity, loaded) == ESP_OK);
    REQUIRE(loaded == expected);
    REQUIRE(state_journal_status().valid);
}

std::uint64_t number(std::size_t offset, std::size_t count)
{
    std::uint64_t result = 0;
    for (std::size_t i = 0; i < count; ++i)
        result |= static_cast<std::uint64_t>(memory[offset + i]) << (8 * i);
    return result;
}

unsigned latest_slot()
{
    return number(8, 8) > number(256 + 8, 8) ? 0 : 1;
}

void blank()
{
    for (auto fill : {0x00, 0xff}) {
        reset(static_cast<std::uint8_t>(fill));
        StateJournalPayload loaded{0x73};
        REQUIRE(state_journal_load(key(1), loaded) == ESP_ERR_NOT_FOUND);
        REQUIRE(loaded == StateJournalPayload{0x73});
        REQUIRE(!state_journal_status().valid);
    }
    reset(0x5a);
    StateJournalPayload loaded;
    REQUIRE(state_journal_load(key(1), loaded) == ESP_ERR_INVALID_RESPONSE);
    REQUIRE(state_journal_save(key(1), {1}) == ESP_OK);
    expect_payload(key(1), {1});
}

void roundtrip()
{
    reset();
    REQUIRE(state_journal_save(key(1), {0, 1, 0xff}) == ESP_OK);
    expect_payload(key(1), {0, 1, 0xff});
    REQUIRE(state_journal_status().generation == 1);
    REQUIRE(state_journal_save(key(1), {5}) == ESP_OK);
    expect_payload(key(1), {5});
    REQUIRE(state_journal_status().generation == 2);
    StateJournalPayload maximum(kStateJournalMaxPayloadBytes, 0xa3);
    REQUIRE(state_journal_save(key(1), maximum) == ESP_OK);
    expect_payload(key(1), maximum);
    REQUIRE(state_journal_status().generation == 3);
    REQUIRE(std::all_of(memory.begin() + 512, memory.end(), [](auto byte) {
        return byte == 0xff;
    }));
}

void key_miss()
{
    reset();
    REQUIRE(state_journal_save(key(1), {1}) == ESP_OK);
    StateJournalPayload loaded{7};
    REQUIRE(state_journal_load(key(2), loaded) == ESP_ERR_NOT_FOUND);
    REQUIRE(loaded == StateJournalPayload{7});
    REQUIRE(state_journal_save(key(2), {2}) == ESP_OK);
    expect_payload(key(2), {2});
    expect_payload(key(1), {1});
    REQUIRE(state_journal_load(key(3), loaded) == ESP_ERR_NOT_FOUND);
}

void corruption()
{
    reset();
    REQUIRE(state_journal_save(key(1), {1}) == ESP_OK);
    REQUIRE(state_journal_save(key(1), {2}) == ESP_OK);
    const auto intact = memory;
    const auto recent = latest_slot();
    // Header, length, payload, CRC and commit marker corruption must all reject the candidate.
    for (auto within : {0U, 8U, 16U, 32U, 34U, 40U, 41U, 248U}) {
        memory = intact;
        memory[recent * kSlotBytes + within] ^= 0x01;
        expect_payload(key(1), {1});
    }
    memory = intact;
    memory[40] ^= 0x80;
    memory[256 + 40] ^= 0x80;
    StateJournalPayload loaded{0x73};
    REQUIRE(state_journal_load(key(1), loaded) == ESP_ERR_INVALID_RESPONSE);
    REQUIRE(loaded == StateJournalPayload{0x73});
    REQUIRE(state_journal_load(key(2), loaded) == ESP_ERR_INVALID_RESPONSE);
    REQUIRE(state_journal_save(key(1), {3}) == ESP_OK);
    expect_payload(key(1), {3});
}

void power_cuts()
{
    reset();
    REQUIRE(state_journal_save(key(1), {0x19, 0x28}) == ESP_OK);
    REQUIRE(state_journal_save(key(1), {0x31, 0x42}) == ESP_OK);
    const auto intact = memory;
    const auto previous = latest_slot();
    const StateJournalPayload replacement{0xa5, 0x5a, 0x13, 0x24, 0x35};
    const auto baseline_written = written;
    REQUIRE(state_journal_save(key(1), replacement) == ESP_OK);
    const auto transaction_bytes = written - baseline_written;
    for (std::size_t cut = 1; cut <= transaction_bytes; ++cut) {
        memory = intact;
        powered = true;
        written = 0;
        cut_after = cut;
        REQUIRE(state_journal_save(key(1), replacement) != ESP_OK);
        reconnect();
        StateJournalPayload loaded;
        REQUIRE(state_journal_load(key(1), loaded) == ESP_OK);
        REQUIRE((loaded == StateJournalPayload{0x31, 0x42} || loaded == replacement));
        REQUIRE(std::equal(intact.begin() + previous * kSlotBytes,
                           intact.begin() + (previous + 1) * kSlotBytes,
                           memory.begin() + previous * kSlotBytes));
    }
    // Loss during the very first initialization must never expose a partial payload as valid.
    for (std::size_t cut = 1; cut <= transaction_bytes; ++cut) {
        reset();
        cut_after = cut;
        REQUIRE(state_journal_save(key(1), replacement) != ESP_OK);
        reconnect();
        StateJournalPayload loaded{0x73};
        const auto result = state_journal_load(key(1), loaded);
        REQUIRE(result == ESP_OK || result == ESP_ERR_NOT_FOUND
                || result == ESP_ERR_INVALID_RESPONSE);
        REQUIRE(result != ESP_OK || loaded == replacement);
        REQUIRE(result == ESP_OK || loaded == StateJournalPayload{0x73});
    }
}

void protected_retries()
{
    reset();
    const auto active = key(1);
    REQUIRE(state_journal_save(active, {1}) == ESP_OK);
    REQUIRE(state_journal_save(active, {2}) == ESP_OK);
    const auto protected_index = latest_slot();
    const auto before = memory;
    for (std::uint8_t attempt = 2; attempt < 20; ++attempt) {
        REQUIRE(state_journal_save(key(attempt), {attempt}, &active) == ESP_OK);
        expect_payload(active, {2});
        expect_payload(key(attempt), {attempt});
        REQUIRE(std::equal(before.begin() + protected_index * kSlotBytes,
                           before.begin() + (protected_index + 1) * kSlotBytes,
                           memory.begin() + protected_index * kSlotBytes));
    }
    const auto staged = key(19);
    REQUIRE(state_journal_save(staged, {0x61}, &staged) == ESP_OK);
    expect_payload(staged, {0x61});
}

void read_failures()
{
    reset();
    REQUIRE(state_journal_save(key(1), {1}) == ESP_OK);
    const auto intact = memory;
    const auto writes = write_calls;
    fail_reads = true;
    StateJournalPayload loaded{0x73};
    REQUIRE(state_journal_load(key(1), loaded) == ESP_FAIL);
    REQUIRE(loaded == StateJournalPayload{0x73});
    REQUIRE(state_journal_save(key(1), {2}) == ESP_FAIL);
    REQUIRE(memory == intact && write_calls == writes);
    REQUIRE(state_journal_status().lastError == ESP_FAIL);
    reconnect();
    expect_payload(key(1), {1});
}

void write_readback()
{
    reset();
    REQUIRE(state_journal_save(key(1), {1}) == ESP_OK);
    const auto intact = memory;
    corrupt_write = true;
    REQUIRE(state_journal_save(key(1), {2}) == ESP_ERR_INVALID_RESPONSE);
    corrupt_write = false;
    expect_payload(key(1), {1});
    // Every read failure leaves the previous matching slot usable after bus recovery.
    for (unsigned failure = 1; failure <= 9; ++failure) {
        memory = intact;
        read_calls = 0;
        fail_read_at = failure;
        const auto result = state_journal_save(key(1), {2});
        REQUIRE(result == ESP_OK || result == ESP_FAIL);
        reconnect();
        StateJournalPayload loaded;
        REQUIRE(state_journal_load(key(1), loaded) == ESP_OK);
        REQUIRE((loaded == StateJournalPayload{1} || loaded == StateJournalPayload{2}));
    }
}

void bounds()
{
    reset();
    REQUIRE(state_journal_save(key(1), {}) == ESP_ERR_INVALID_SIZE);
    REQUIRE(state_journal_save(key(1), StateJournalPayload(kStateJournalMaxPayloadBytes + 1))
            == ESP_ERR_INVALID_SIZE);
    REQUIRE(write_calls == 0 && read_calls == 0);
}

void generation_exhaustion()
{
    reset();
    REQUIRE(state_journal_save(key(1), {1}) == ESP_OK);
    std::fill_n(memory.begin() + 8, 8, 0xff);
    const auto crc = fcplcn::util::crc32(memory.data(), 41);
    for (std::size_t i = 0; i < 4; ++i)
        memory[41 + i] = static_cast<std::uint8_t>(crc >> (8 * i));
    expect_payload(key(1), {1});
    const auto before = memory;
    REQUIRE(state_journal_save(key(1), {2}) == ESP_ERR_INVALID_STATE);
    REQUIRE(memory == before);
}
}  // namespace

esp_err_t fram_read(std::uint16_t offset, std::uint8_t* data, std::size_t length)
{
    ++read_calls;
    if (!powered || fail_reads || (fail_read_at != 0 && read_calls == fail_read_at))
        return ESP_FAIL;
    REQUIRE(offset <= memory.size() && length <= memory.size() - offset);
    std::copy_n(memory.begin() + offset, length, data);
    return ESP_OK;
}

esp_err_t fram_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length)
{
    ++write_calls;
    if (!powered)
        return ESP_FAIL;
    REQUIRE(offset <= memory.size() && length <= memory.size() - offset);
    for (std::size_t i = 0; i < length; ++i) {
        memory[offset + i] = data[i];
        if (++written == cut_after) {
            powered = false;
            return ESP_FAIL;
        }
    }
    if (corrupt_write && offset % kSlotBytes == 0)
        memory[offset + 40] ^= 0x01;
    return ESP_OK;
}

int main(int argc, char** argv)
{
    const std::vector<std::pair<std::string, std::function<void()>>> tests{
        {"blank", blank},
        {"roundtrip", roundtrip},
        {"key_miss", key_miss},
        {"corruption", corruption},
        {"power_cuts", power_cuts},
        {"protected_retries", protected_retries},
        {"read_failures", read_failures},
        {"write_readback", write_readback},
        {"bounds", bounds},
        {"generation_exhaustion", generation_exhaustion},
    };
    try {
        for (const auto& [name, run] : tests)
            if (argc == 1 || argv[1] == name) {
                run();
                std::cout << name << " PASS\n";
            }
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    return 0;
}
