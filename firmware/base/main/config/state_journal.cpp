/**
 * @file state_journal.cpp
 * @brief Bounded two-slot FRAM state transactions with configuration keys and CRC validation.
 */
#include "config/state_journal.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <mutex>

#include "hardware/fram.h"
#include "util/checksum.h"

namespace {
constexpr std::size_t kSlotBytes = kStateJournalReservedBytes / 2;
constexpr std::size_t kHeaderBytes = 40;
constexpr std::size_t kCommitOffset = kSlotBytes - 8;
constexpr std::array<std::uint8_t, 8> kMagic{{'F', 'C', 'F', 'R', 'A', 'M', '0', '1'}};
constexpr std::array<std::uint8_t, 8> kCommit{{'F', 'C', 'C', 'M', 'T', '0', '1', 0xa5}};
constexpr std::array<std::uint8_t, 8> kInvalidCommit{};
constexpr std::size_t kMaxRecordBytes = kHeaderBytes + kStateJournalMaxPayloadBytes + 4;
static_assert(kMaxRecordBytes <= kCommitOffset);

/** @brief Independently validated metadata and bytes from one physical FRAM slot. */
struct Slot {
    bool blank = false;
    bool valid = false;
    std::uint64_t generation = 0;
    StateJournalKey key{};
    std::size_t payloadBytes = 0;
    std::array<std::uint8_t, kMaxRecordBytes> bytes{};
};

std::mutex journal_mutex;
StateJournalStatus journal_status;

/**
 * @brief Decode an unsigned little-endian field without host alignment assumptions.
 * @param[in] data Borrowed field storage containing size bytes.
 * @param[in] size Field width, bounded by eight bytes by all internal callers.
 * @return Decoded unsigned field value.
 */
std::uint64_t read_number(const std::uint8_t* data, std::size_t size)
{
    std::uint64_t value = 0;
    for (std::size_t i = 0; i < size; ++i)
        value |= static_cast<std::uint64_t>(data[i]) << (8 * i);
    return value;
}

/**
 * @brief Encode an unsigned little-endian field without depending on the native ABI.
 * @param[out] data Writable field storage containing size bytes.
 * @param[in] size Field width, bounded by eight bytes by all internal callers.
 * @param[in] value Value whose low size bytes are written.
 */
void write_number(std::uint8_t* data, std::size_t size, std::uint64_t value)
{
    for (std::size_t i = 0; i < size; ++i)
        data[i] = static_cast<std::uint8_t>(value >> (8 * i));
}

/**
 * @brief Record the outcome of a serialized journal operation.
 * @param[in] result Operation result to expose to diagnostics.
 * @param[in] generation Confirmed record generation, or zero when none was confirmed.
 * @return The supplied operation result.
 * @pre The caller holds journal_mutex.
 */
esp_err_t finish(esp_err_t result, std::uint64_t generation = 0)
{
    journal_status.lastError = result;
    journal_status.generation = generation;
    journal_status.valid = result == ESP_OK;
    return result;
}

/**
 * @brief Distinguish entirely erased/zeroed storage from an interrupted or unknown record.
 * @param[in] slot Physical slot index, zero or one.
 * @param[out] blank True only when every slot byte is uniformly zero or 0xff.
 * @return ESP_OK or the FRAM read error.
 */
esp_err_t is_blank(unsigned slot, bool& blank)
{
    std::array<std::uint8_t, kSlotBytes> bytes{};
    const auto result =
        fram_read(static_cast<std::uint16_t>(slot * kSlotBytes), bytes.data(), bytes.size());
    if (result != ESP_OK)
        return result;
    const auto first = bytes.front();
    blank = (first == 0 || first == 0xff)
            && std::all_of(bytes.begin(), bytes.end(), [first](auto byte) {
                   return byte == first;
               });
    return ESP_OK;
}

/**
 * @brief Read and validate one independently committed record without exposing partial data.
 * @param[in] slot Physical slot index, zero or one.
 * @param[out] parsed Metadata and complete body; invalid bodies remain marked invalid.
 * @return ESP_OK after classification, or a FRAM transport error.
 */
esp_err_t read_slot(unsigned slot, Slot& parsed)
{
    parsed = Slot{};
    const auto base = static_cast<std::uint16_t>(slot * kSlotBytes);
    auto result = fram_read(base, parsed.bytes.data(), kHeaderBytes);
    if (result != ESP_OK)
        return result;
    if (!std::equal(kMagic.begin(), kMagic.end(), parsed.bytes.begin()))
        return is_blank(slot, parsed.blank);
    std::array<std::uint8_t, kCommit.size()> marker{};
    result = fram_read(base + kCommitOffset, marker.data(), marker.size());
    if (result != ESP_OK)
        return result;
    if (marker != kCommit)
        return ESP_OK;
    parsed.generation = read_number(parsed.bytes.data() + 8, 8);
    std::copy_n(parsed.bytes.begin() + 16, parsed.key.size(), parsed.key.begin());
    parsed.payloadBytes = static_cast<std::size_t>(read_number(parsed.bytes.data() + 32, 2));
    if (parsed.generation == 0 || parsed.payloadBytes == 0
        || parsed.payloadBytes > kStateJournalMaxPayloadBytes
        || !std::all_of(
            parsed.bytes.begin() + 34, parsed.bytes.begin() + kHeaderBytes, [](auto byte) {
                return byte == 0;
            }))
        return ESP_OK;
    result =
        fram_read(base + kHeaderBytes, parsed.bytes.data() + kHeaderBytes, parsed.payloadBytes + 4);
    if (result != ESP_OK)
        return result;
    const auto checked = kHeaderBytes + parsed.payloadBytes;
    parsed.valid = read_number(parsed.bytes.data() + checked, 4)
                   == fcplcn::util::crc32(parsed.bytes.data(), checked);
    return ESP_OK;
}

/**
 * @brief Read both slots before selecting an authoritative record or a write target.
 * @param[out] slots Independent slot classifications and validated bytes.
 * @return ESP_OK or the first FRAM transport error; uncertain media is never overwritten.
 */
esp_err_t read_slots(std::array<Slot, 2>& slots)
{
    for (unsigned i = 0; i < slots.size(); ++i) {
        const auto result = read_slot(i, slots[i]);
        if (result != ESP_OK)
            return result;
    }
    return ESP_OK;
}

/**
 * @brief Select the newest valid record, optionally restricted to a configuration identity.
 * @param[in] slots Fully classified physical slots.
 * @param[in] key Optional requested key; nullptr accepts records belonging to any configuration.
 * @return Matching physical slot index, or -1 when no valid record matches.
 */
int newest(const std::array<Slot, 2>& slots, const StateJournalKey* key = nullptr)
{
    int selected = -1;
    for (unsigned i = 0; i < slots.size(); ++i)
        if (slots[i].valid && (key == nullptr || slots[i].key == *key)
            && (selected < 0 || slots[i].generation > slots[selected].generation))
            selected = static_cast<int>(i);
    return selected;
}

/**
 * @brief Invalidate an uncertain candidate after commit/writeback failure when the bus permits.
 * @param[in] base Candidate slot's physical FRAM base address.
 * @note The previous authoritative slot is never touched. A failing bus can make rollback
 * uncertain, so the public save result still reports the original error.
 */
void abandon(std::uint16_t base)
{
    (void)fram_write(base + kCommitOffset, kInvalidCommit.data(), kInvalidCommit.size());
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Load the newest CRC-checked committed snapshot for one configuration key.
 * @param[in] key Configuration identity requested by the caller.
 * @param[out] payload Replaced only after complete matching-record verification.
 * @return ESP_OK, NOT_FOUND, INVALID_RESPONSE or a FRAM read error.
 * @endcond
 */
esp_err_t state_journal_load(const StateJournalKey& key, StateJournalPayload& payload)
{
    std::lock_guard<std::mutex> lock(journal_mutex);
    std::array<Slot, 2> slots;
    const auto result = read_slots(slots);
    if (result != ESP_OK)
        return finish(result);
    const auto selected = newest(slots, &key);
    if (selected < 0) {
        for (const auto& slot : slots)
            if (!slot.valid && !slot.blank)
                return finish(ESP_ERR_INVALID_RESPONSE);
        return finish(ESP_ERR_NOT_FOUND);
    }
    const auto& record = slots[selected];
    payload.assign(record.bytes.begin() + kHeaderBytes,
                   record.bytes.begin() + kHeaderBytes + record.payloadBytes);
    return finish(ESP_OK, record.generation);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Stage, verify and commit one bounded FRAM snapshot while preserving the protected slot.
 * @param[in] key Configuration identity owning the replacement.
 * @param[in] payload Validated nonempty controller-state bytes, up to the public maximum.
 * @param[in] protectedKey Optional durable configuration identity whose newest slot survives.
 * @return ESP_OK after readback, or an argument, generation-exhaustion or FRAM transaction error.
 * @endcond
 */
esp_err_t state_journal_save(const StateJournalKey& key,
                             const StateJournalPayload& payload,
                             const StateJournalKey* protectedKey)
{
    std::lock_guard<std::mutex> lock(journal_mutex);
    if (payload.empty() || payload.size() > kStateJournalMaxPayloadBytes)
        return finish(ESP_ERR_INVALID_SIZE);
    std::array<Slot, 2> slots;
    auto result = read_slots(slots);
    if (result != ESP_OK)
        return finish(result);
    const auto latest = newest(slots);
    if (latest >= 0 && slots[latest].generation == std::numeric_limits<std::uint64_t>::max())
        return finish(ESP_ERR_INVALID_STATE);
    const auto generation = latest < 0 ? 1 : slots[latest].generation + 1;
    auto preserve = protectedKey == nullptr ? -1 : newest(slots, protectedKey);
    if (preserve < 0)
        preserve = newest(slots, &key);
    if (preserve < 0)
        preserve = latest;
    const unsigned target = preserve < 0 ? 0 : 1U - static_cast<unsigned>(preserve);
    const auto base = static_cast<std::uint16_t>(target * kSlotBytes);
    std::array<std::uint8_t, kMaxRecordBytes> bytes{};
    std::copy(kMagic.begin(), kMagic.end(), bytes.begin());
    write_number(bytes.data() + 8, 8, generation);
    std::copy(key.begin(), key.end(), bytes.begin() + 16);
    write_number(bytes.data() + 32, 2, payload.size());
    std::copy(payload.begin(), payload.end(), bytes.begin() + kHeaderBytes);
    const auto checked = kHeaderBytes + payload.size();
    write_number(bytes.data() + checked, 4, fcplcn::util::crc32(bytes.data(), checked));
    const auto record_bytes = checked + 4;
    result = fram_write(base + kCommitOffset, kInvalidCommit.data(), kInvalidCommit.size());
    if (result != ESP_OK)
        return finish(result);
    result = fram_write(base, bytes.data(), record_bytes);
    if (result != ESP_OK)
        return finish(result);
    std::array<std::uint8_t, kMaxRecordBytes> verified{};
    result = fram_read(base, verified.data(), record_bytes);
    if (result != ESP_OK)
        return finish(result);
    if (!std::equal(bytes.begin(), bytes.begin() + record_bytes, verified.begin()))
        return finish(ESP_ERR_INVALID_RESPONSE);
    result = fram_write(base + kCommitOffset, kCommit.data(), kCommit.size());
    if (result != ESP_OK) {
        abandon(base);
        return finish(result);
    }
    std::array<std::uint8_t, kCommit.size()> marker{};
    result = fram_read(base + kCommitOffset, marker.data(), marker.size());
    if (result != ESP_OK || marker != kCommit) {
        abandon(base);
        return finish(result == ESP_OK ? ESP_ERR_INVALID_RESPONSE : result);
    }
    return finish(ESP_OK, generation);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy cached journal diagnostics without touching the shared I2C bus.
 * @return Last-operation error, confirmed generation and validity, copied under the journal lock.
 * @endcond
 */
StateJournalStatus state_journal_status()
{
    std::lock_guard<std::mutex> lock(journal_mutex);
    return journal_status;
}
