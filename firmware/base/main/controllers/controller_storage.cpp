/**
 * @file controller_storage.cpp
 * @brief Versioned durable controller records and portable backup codecs.
 */
#include "controllers/controller_internal.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <vector>

#include "hardware/board_profile.h"
#include "cJSON.h"
#include "hardware/hardware_io.h"
#include "sensors/meteo_sensors.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "config/settings_json.h"
#include "config/model.h"
#include "platform/runtime_supervisor.h"
#include "platform/checksum.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {

/** @brief Bounds-checked non-owning reader for ABI-independent controller-record fields. */
class Reader {
public:
    /**
     * @brief Open a non-owning bounded view over the payload portion of a record.
     * @param[in] data Borrowed record storage that outlives the reader.
     * @param[in] limit Exclusive payload end, normally before the trailing CRC.
     * @pre limit does not exceed data.size().
     */
    Reader(const std::vector<std::uint8_t>& data, std::size_t limit) : bytes(data), end(limit)
    {
    }

    /**
     * @brief Consume one payload byte without crossing the configured end.
     * @param[out] value Decoded byte on success; unchanged if no byte remains.
     * @return True when a byte was available; the cursor advances only on success.
     */
    bool byte(std::uint8_t& value)
    {
        if (position >= end)
            return false;
        value = bytes[position++];
        return true;
    }

    /**
     * @brief Consume a four-byte little-endian record field.
     * @param[out] value Decoded integer; may contain a partial value on a truncated record.
     * @return True when all four bytes were available; failed reads do not rewind the cursor.
     */
    bool number(std::uint32_t& value)
    {
        value = 0;
        for (unsigned shift = 0; shift < 32; shift += 8) {
            std::uint8_t part;
            if (!byte(part))
                return false;
            value |= static_cast<std::uint32_t>(part) << shift;
        }
        return true;
    }

    /**
     * @brief Consume a two-byte little-endian record field.
     * @param[out] value Decoded integer on success; unchanged on truncation.
     * @return True when both bytes were available; the cursor may advance before failure.
     */
    bool small_number(std::uint16_t& value)
    {
        std::uint8_t low, high;
        if (!byte(low) || !byte(high))
            return false;
        value = static_cast<std::uint16_t>(low | (static_cast<std::uint16_t>(high) << 8));
        return true;
    }

    /**
     * @brief Decode a length-prefixed string while rejecting oversized or embedded-NUL text.
     * @param[out] value Owned decoded string; it may contain rejected NUL bytes on failure.
     * @param[in] maximum Maximum allowed encoded byte length for this field.
     * @return True for a complete bounded string without NUL; failed reads do not rewind the
     * cursor.
     */
    bool text(std::string& value, std::size_t maximum)
    {
        std::uint8_t size;
        if (!byte(size) || size > maximum || size > end - position)
            return false;
        value.assign(reinterpret_cast<const char*>(bytes.data() + position), size);
        position += size;
        return value.find('\0') == std::string::npos;
    }

    /**
     * @brief Check that the decoder consumed the whole bounded payload.
     * @return True when the cursor is exactly at the configured end, with no trailing fields.
     */
    bool finished() const
    {
        return position == end;
    }

private:
    const std::vector<std::uint8_t>& bytes;
    std::size_t end;
    std::size_t position = 0;
};

/**
 * @brief Compute the reflected CRC-32 used by controller storage records.
 * @param[in] data Borrowed byte sequence; valid for size bytes.
 * @param[in] size Number of bytes included, excluding the stored checksum itself.
 * @return Final complemented CRC with polynomial 0xEDB88320.
 */
std::uint32_t crc32(const std::uint8_t* data, std::size_t size)
{
    return fcplcn::util::crc32(data, size);
}

/**
 * @brief Append a 32-bit integer to the portable controller record in little-endian order.
 * @param[in,out] bytes Destination byte vector, extended by four bytes.
 * @param[in] value Unsigned field value to encode.
 */
void append_u32(std::vector<std::uint8_t>& bytes, std::uint32_t value)
{
    for (unsigned shift = 0; shift < 32; shift += 8)
        bytes.push_back(static_cast<std::uint8_t>(value >> shift));
}

/**
 * @brief Append a two-byte little-endian field without depending on host layout.
 * @param[in,out] bytes Destination byte vector, extended by two bytes.
 * @param[in] value Unsigned field bits; signed setpoints are encoded by their caller.
 */
void append_u16(std::vector<std::uint8_t>& bytes, std::uint16_t value)
{
    bytes.push_back(static_cast<std::uint8_t>(value));
    bytes.push_back(static_cast<std::uint8_t>(value >> 8));
}

/**
 * @brief Append an 8-bit length followed by the exact string bytes.
 * @param[in,out] bytes Destination controller-record vector.
 * @param[in] text Borrowed text already validated against its field limit.
 * @pre text.size() fits in one byte; this encoder does not truncate or validate strings.
 */
void append_text(std::vector<std::uint8_t>& bytes, std::string_view text)
{
    bytes.push_back(static_cast<std::uint8_t>(text.size()));
    bytes.insert(bytes.end(), text.begin(), text.end());
}

// Version 8 assigns a new state-memory identity to every durable configuration replacement.
// The encoded switch values are migration/import seeds, never the live state store.
/**
 * @brief Encode a bounded, ABI-independent little-endian controller record.
 * @details One CRC covers all modules, revisions and confirmed operative flags.
 * Thermostat demand/measurements are intentionally absent; legacy versions are
 * migrated once by load() after their state-memory seed has been confirmed.
 * @param[in] configs Complete validated module set whose profiles resolve to one canonical board.
 * @return Current-version record with CRC and a fresh state identity, or an empty vector.
 * @pre Row strings and counts satisfy their schema limits; the storage caller enforces the total
 * blob bound.
 */
SettingsBytes encode_record(const Configurations& configs)
{
    const auto board_id = board_profile_canonical_id(configs[0].boardId);
    if (board_id.empty())
        return {};
    for (const auto& config : configs)
        if (board_profile_canonical_id(config.boardId) != board_id)
            return {};
    SettingsBytes bytes;
    bytes.reserve(kMaxBlobBytes);
    bytes.insert(bytes.end(), kControllerMagic.begin(), kControllerMagic.end());
    bytes.push_back(static_cast<std::uint8_t>(kControllerStorageVersion));
    bytes.push_back(static_cast<std::uint8_t>(kControllerStorageVersion >> 8));
    StateJournalKey key{};
    do {
        esp_fill_random(key.data(), key.size());
    } while (std::all_of(key.begin(), key.end(), [](auto byte) {
        return byte == 0;
    }));
    bytes.insert(bytes.end(), key.begin(), key.end());
    append_text(bytes, board_id);
    for (std::size_t module = 0; module < kControllerCount; ++module) {
        const auto& config = configs[module];
        append_u32(bytes, config.revision);
        bytes.push_back(config.enabled);
        bytes.push_back(static_cast<std::uint8_t>(config.items.size()));
        if (module == index(ControllerKind::Security)) {
            append_text(bytes, config.security.sirenRelayId);
            append_text(bytes, config.security.readerPortId);
            append_u16(bytes, config.security.entryDelaySeconds);
            append_u16(bytes, config.security.exitDelaySeconds);
            bytes.push_back(static_cast<std::uint8_t>(config.security.keys.size()));
            for (const auto& key : config.security.keys) {
                append_text(bytes, key.id);
                append_text(bytes, key.name);
                append_text(bytes, key.address);
            }
            bytes.push_back(config.armed);
            bytes.push_back(config.triggered);
        }
        for (const auto& item : config.items) {
            append_text(bytes, item.id);
            append_text(bytes, item.name);
            if (module == index(ControllerKind::Meteo)) {
                append_text(bytes, item.portId);
                bytes.push_back(item.sensorType == SensorProtocol::Dht22 ? 1 : 2);
                append_text(bytes, item.address);
            } else if (module == index(ControllerKind::Thermostats)) {
                append_text(bytes, item.meteoId);
                append_text(bytes, item.relayId);
                append_text(bytes, item.inputId);
                bytes.push_back(item.enabled);
                bytes.push_back(item.mode == ThermostatMode::Heating ? 1 : 2);
                append_u16(bytes,
                           static_cast<std::uint16_t>(
                               static_cast<std::int16_t>(std::lround(item.setpointC * 10))));
                bytes.push_back(static_cast<std::uint8_t>(item.hysteresisC));
            } else if (module == index(ControllerKind::Irrigation)) {
                append_text(bytes, item.relayId);
                append_text(bytes, item.tankId);
                bytes.push_back(item.daysMask);
                append_u16(bytes, item.startMinute);
                append_u16(bytes, item.durationMinutes);
                bytes.push_back(item.enabled);
            } else if (module == index(ControllerKind::Tanks)) {
                append_text(bytes, item.pumpRelayId);
                append_text(bytes, item.valveRelayId);
                bytes.push_back(static_cast<std::uint8_t>(item.levelInputs.size()));
                for (const auto& input : item.levelInputs)
                    append_text(bytes, input);
                bytes.push_back(static_cast<std::uint8_t>(item.fillLevel));
                bytes.push_back(item.enabled);
            } else if (module == index(ControllerKind::Security)) {
                append_text(bytes, item.inputId);
                bytes.push_back(item.securityType == SecuritySensorType::Reed ? 1 : 2);
                bytes.push_back(item.entryDelay);
            } else {
                append_text(bytes, item.relayId);
                append_text(bytes, item.inputId);
                bytes.push_back(item.state);
            }
        }
    }
    append_u32(bytes, crc32(bytes.data(), bytes.size()));
    return bytes;
}

/**
 * @brief Encode all modules and atomically replace their common settings section.
 * @param[in] configs Complete validated replacement set.
 * @return ESP_OK, an encoding/size error, or the settings-store commit error.
 * @pre The caller holds the settings write guard before controller_mutex.
 * @note Runtime configuration is published by the caller only after durable success.
 */
esp_err_t save(const Configurations& configs)
{
    const auto bytes = encode_record(configs);
    if (bytes.empty())
        return ESP_ERR_INVALID_ARG;
    if (bytes.size() > kMaxBlobBytes)
        return ESP_ERR_INVALID_SIZE;
    SettingsBytes previous;
    const auto previous_error = settings_store_get(SettingsSection::Controllers, previous);
    if (previous_error != ESP_OK && previous_error != ESP_ERR_NVS_NOT_FOUND)
        return previous_error;
    const auto prepared = controllers_prepare_restore_states(bytes, previous);
    if (prepared != ESP_OK)
        return prepared;
    const auto result = settings_store_set(SettingsSection::Controllers, bytes);
    if (result == ESP_OK)
        activate_state_record(bytes);
    return result;
}

/**
 * @brief Decode the original sockets-only record without writing migration data.
 * @param[in] bytes Borrowed complete legacy record, including its checksum.
 * @param[out] result Validated sockets configuration on success; unchanged on failure.
 * @return ESP_OK for a valid canonicalized record, otherwise ESP_ERR_INVALID_RESPONSE.
 * @note Board aliases are normalized only in RAM after CRC validation; saved switch states are
 * retained.
 */
esp_err_t decode_legacy_record(const SettingsBytes& bytes, Configuration& result)
{
    if (bytes.size() < 20 || bytes.size() > kMaxBlobBytes)
        return ESP_ERR_INVALID_RESPONSE;
    Reader reader(bytes, bytes.size() - 4);
    for (auto expected : kMagic) {
        std::uint8_t actual;
        if (!reader.byte(actual) || actual != expected)
            return ESP_ERR_INVALID_RESPONSE;
    }
    std::uint8_t version_low, version_high, enabled, count;
    Configuration parsed;
    if (!reader.byte(version_low) || !reader.byte(version_high)
        || (version_low | (static_cast<unsigned>(version_high) << 8)) != kSocketStorageVersion
        || !reader.number(parsed.revision) || !reader.byte(enabled) || enabled > 1
        || !reader.text(parsed.boardId, 64) || !reader.byte(count) || count > kSocketMaxItems)
        return ESP_ERR_INVALID_RESPONSE;
    parsed.enabled = enabled != 0;
    for (unsigned i = 0; i < count; ++i) {
        Item item;
        std::uint8_t state;
        if (!reader.text(item.id, kSocketMaxIdBytes) || !reader.text(item.name, kSocketMaxNameBytes)
            || !reader.text(item.relayId, 32) || !reader.text(item.inputId, 32)
            || !reader.byte(state) || state > 1)
            return ESP_ERR_INVALID_RESPONSE;
        item.state = state != 0;
        parsed.items.push_back(std::move(item));
    }
    const auto offset = bytes.size() - 4;
    const auto checksum = static_cast<std::uint32_t>(bytes[offset])
                          | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8)
                          | (static_cast<std::uint32_t>(bytes[offset + 2]) << 16)
                          | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
    if (!reader.finished() || checksum != crc32(bytes.data(), offset))
        return ESP_ERR_INVALID_RESPONSE;
    const auto board_id = board_profile_canonical_id(parsed.boardId);
    if (board_id.empty())
        return ESP_ERR_INVALID_RESPONSE;
    // Normalize in RAM only, after validating the original record's checksum.
    // Persisted ON states and bindings survive the board's technical rename.
    parsed.boardId = board_id;
    if (!valid_configuration(parsed, parsed.boardId == board_profile_active().id))
        return ESP_ERR_INVALID_RESPONSE;
    result = std::move(parsed);
    return ESP_OK;
}

/**
 * @brief Validate CRC, version, bounds and profile identity before accepting a record.
 * @details Legacy shared input claims remain explicit diagnostics and do not
 * toggle multiple owners. Relay/sensor conflicts are rejected. Historical v4
 * thermostat rows become enabled with no input. Version 6 dwell fields are validated and discarded;
 * their runtime demand is never restored.
 * @param[in] bytes Borrowed complete record, including version and CRC.
 * @param[out] result Fully validated canonicalized modules on success; unchanged on failure.
 * @return ESP_OK for a supported record, otherwise a validation/decode error.
 * @note Validation and legacy conversion do not mutate storage or live controller configuration.
 */
esp_err_t decode_record(const SettingsBytes& bytes, Configurations& result)
{
    if (bytes.size() >= kMagic.size() && std::equal(kMagic.begin(), kMagic.end(), bytes.begin())) {
        Configurations parsed = defaults();
        const auto error = decode_legacy_record(bytes, parsed[0]);
        if (error != ESP_OK)
            return error;
        for (std::size_t module = 1; module < kControllerCount; ++module)
            parsed[module].boardId = parsed[0].boardId;
        if (resource_conflict(parsed, false))
            return ESP_ERR_INVALID_RESPONSE;
        result = std::move(parsed);  // Legacy duplicate inputs remain visible and durable.
        return ESP_OK;
    }
    if (bytes.size() < 28 || bytes.size() > kMaxBlobBytes)
        return ESP_ERR_INVALID_RESPONSE;
    const auto offset = bytes.size() - 4;
    const auto checksum = static_cast<std::uint32_t>(bytes[offset])
                          | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8)
                          | (static_cast<std::uint32_t>(bytes[offset + 2]) << 16)
                          | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
    if (checksum != crc32(bytes.data(), offset))
        return ESP_ERR_INVALID_RESPONSE;
    const bool version2 = std::equal(kV2Magic.begin(), kV2Magic.end(), bytes.begin());
    const bool version3 = std::equal(kV3Magic.begin(), kV3Magic.end(), bytes.begin());
    const bool version4 = std::equal(kV4Magic.begin(), kV4Magic.end(), bytes.begin());
    const bool version5 = std::equal(kV5Magic.begin(), kV5Magic.end(), bytes.begin());
    const bool version6 = std::equal(kV6Magic.begin(), kV6Magic.end(), bytes.begin());
    const bool version7 = std::equal(kV7Magic.begin(), kV7Magic.end(), bytes.begin());
    const bool version8 = std::equal(kV8Magic.begin(), kV8Magic.end(), bytes.begin());
    const bool version9 = std::equal(kV9Magic.begin(), kV9Magic.end(), bytes.begin());
    const bool version10 = std::equal(kV10Magic.begin(), kV10Magic.end(), bytes.begin());
    const auto& magic = version10  ? kV10Magic
                        : version2 ? kV2Magic
                        : version3 ? kV3Magic
                        : version4 ? kV4Magic
                        : version5 ? kV5Magic
                        : version6 ? kV6Magic
                        : version7 ? kV7Magic
                        : version8 ? kV8Magic
                        : version9 ? kV9Magic
                                   : kControllerMagic;
    Reader reader(bytes, offset);
    for (const auto expected : magic) {
        std::uint8_t actual;
        if (!reader.byte(actual) || actual != expected)
            return ESP_ERR_INVALID_RESPONSE;
    }
    std::uint8_t low, high;
    std::string board;
    if (!reader.byte(low) || !reader.byte(high)
        || (low | (static_cast<unsigned>(high) << 8))
               != (version2    ? 2U
                   : version3  ? 3U
                   : version4  ? 4U
                   : version5  ? 5U
                   : version6  ? 6U
                   : version7  ? 7U
                   : version8  ? 8U
                   : version9  ? 9U
                   : version10 ? 10U
                               : kControllerStorageVersion))
        return ESP_ERR_INVALID_RESPONSE;
    if (!version2 && !version3 && !version4 && !version5 && !version6 && !version7) {
        StateJournalKey key{};
        for (auto& byte : key)
            if (!reader.byte(byte))
                return ESP_ERR_INVALID_RESPONSE;
        if (std::all_of(key.begin(), key.end(), [](auto byte) {
                return byte == 0;
            }))
            return ESP_ERR_INVALID_RESPONSE;
    }
    if (!reader.text(board, 64))
        return ESP_ERR_INVALID_RESPONSE;
    const auto canonical = board_profile_canonical_id(board);
    if (canonical.empty())
        return ESP_ERR_INVALID_RESPONSE;
    Configurations parsed;
    for (auto& config : parsed)
        config.boardId = canonical;
    const bool legacy_four = version4 || version5 || version6 || version7 || version8;
    for (std::size_t module = 0; module < (version2      ? kRelayControllerCount
                                           : version3    ? 3U
                                           : legacy_four ? 4U
                                           : version10   ? 6U
                                           : version9    ? 5U
                                                         : kControllerCount);
         ++module) {
        auto& config = parsed[module];
        std::uint8_t enabled, count;
        config.boardId = canonical;
        if (!reader.number(config.revision) || !reader.byte(enabled) || enabled > 1
            || !reader.byte(count) || count > kSocketMaxItems)
            return ESP_ERR_INVALID_RESPONSE;
        config.enabled = enabled != 0;
        if (module == index(ControllerKind::Security)) {
            std::uint8_t key_count, armed, triggered;
            if (!reader.text(config.security.sirenRelayId, 32)
                || !reader.text(config.security.readerPortId, 32)
                || !reader.small_number(config.security.entryDelaySeconds)
                || !reader.small_number(config.security.exitDelaySeconds) || !reader.byte(key_count)
                || key_count > 16)
                return ESP_ERR_INVALID_RESPONSE;
            for (unsigned i = 0; i < key_count; ++i) {
                SecurityKey key;
                if (!reader.text(key.id, kSocketMaxIdBytes)
                    || !reader.text(key.name, kSocketMaxNameBytes) || !reader.text(key.address, 16))
                    return ESP_ERR_INVALID_RESPONSE;
                config.security.keys.push_back(std::move(key));
            }
            if (!reader.byte(armed) || armed > 1 || !reader.byte(triggered) || triggered > 1)
                return ESP_ERR_INVALID_RESPONSE;
            config.armed = armed != 0;
            config.triggered = triggered != 0;
        }
        for (unsigned i = 0; i < count; ++i) {
            Item item;
            if (!reader.text(item.id, kSocketMaxIdBytes)
                || !reader.text(item.name, kSocketMaxNameBytes))
                return ESP_ERR_INVALID_RESPONSE;
            if (module == index(ControllerKind::Meteo)) {
                std::uint8_t type;
                if (!reader.text(item.portId, 32) || !reader.byte(type) || (type != 1 && type != 2)
                    || !reader.text(item.address, 16))
                    return ESP_ERR_INVALID_RESPONSE;
                item.sensorType = type == 1 ? SensorProtocol::Dht22 : SensorProtocol::OneWire;
                if (type == 2 && !normalize_address(item.address))
                    return ESP_ERR_INVALID_RESPONSE;
            } else if (module == index(ControllerKind::Thermostats)) {
                std::uint8_t mode, hysteresis;
                std::uint16_t setpoint;
                if (!reader.text(item.meteoId, kSocketMaxIdBytes) || !reader.text(item.relayId, 32))
                    return ESP_ERR_INVALID_RESPONSE;
                if (version4)
                    item.enabled = true;
                else {
                    std::uint8_t item_enabled;
                    if (!reader.text(item.inputId, 32) || !reader.byte(item_enabled)
                        || item_enabled > 1)
                        return ESP_ERR_INVALID_RESPONSE;
                    item.enabled = item_enabled != 0;
                }
                if (!reader.byte(mode) || (mode != 1 && mode != 2) || !reader.small_number(setpoint)
                    || !reader.byte(hysteresis))
                    return ESP_ERR_INVALID_RESPONSE;
                item.mode = mode == 1 ? ThermostatMode::Heating : ThermostatMode::Cooling;
                const auto signed_setpoint = setpoint >= 0x8000
                                                 ? static_cast<int>(setpoint) - 0x10000
                                                 : static_cast<int>(setpoint);
                item.setpointC = signed_setpoint / 10.0;
                item.hysteresisC = hysteresis;
                if (version6) {
                    // Read and validate the historical settings without retaining them.
                    std::uint32_t legacy_on, legacy_off;
                    if (!reader.number(legacy_on) || !reader.number(legacy_off)
                        || legacy_on > kLegacyMaxDwellSeconds
                        || legacy_off > kLegacyMaxDwellSeconds)
                        return ESP_ERR_INVALID_RESPONSE;
                }
            } else if (module == index(ControllerKind::Irrigation)) {
                std::uint8_t flag;
                if (!reader.text(item.relayId, 32)
                    || !reader.text(item.tankId, kIrrigationTankIdBytes)
                    || !reader.byte(item.daysMask) || !reader.small_number(item.startMinute)
                    || !reader.small_number(item.durationMinutes) || !reader.byte(flag) || flag > 1)
                    return ESP_ERR_INVALID_RESPONSE;
                item.enabled = flag != 0;
            } else if (module == index(ControllerKind::Tanks)) {
                std::uint8_t count_inputs, fill, enabled;
                if (!reader.text(item.pumpRelayId, 32) || !reader.text(item.valveRelayId, 32)
                    || !reader.byte(count_inputs) || count_inputs < 1 || count_inputs > 3)
                    return ESP_ERR_INVALID_RESPONSE;
                for (unsigned n = 0; n < count_inputs; ++n) {
                    std::string input;
                    if (!reader.text(input, 32))
                        return ESP_ERR_INVALID_RESPONSE;
                    item.levelInputs.push_back(std::move(input));
                }
                if (!reader.byte(fill) || !reader.byte(enabled) || enabled > 1)
                    return ESP_ERR_INVALID_RESPONSE;
                item.fillLevel = fill;
                item.enabled = enabled != 0;
            } else if (module == index(ControllerKind::Security)) {
                std::uint8_t type, delayed;
                if (!reader.text(item.inputId, 32) || !reader.byte(type) || (type != 1 && type != 2)
                    || !reader.byte(delayed) || delayed > 1)
                    return ESP_ERR_INVALID_RESPONSE;
                item.securityType =
                    type == 1 ? SecuritySensorType::Reed : SecuritySensorType::Motion;
                item.entryDelay = delayed != 0;
            } else {
                std::uint8_t state;
                if (!reader.text(item.relayId, 32) || !reader.text(item.inputId, 32)
                    || !reader.byte(state) || state > 1)
                    return ESP_ERR_INVALID_RESPONSE;
                item.state = state != 0;
            }
            config.items.push_back(std::move(item));
        }
        if (!valid_configuration(config,
                                 config.boardId == board_profile_active().id,
                                 static_cast<ControllerKind>(module)))
            return ESP_ERR_INVALID_RESPONSE;
    }
    // Existing duplicate inputs are not discarded even after a manual state
    // save migrated a legacy record to the current format. Relay conflicts are never executed.
    if (!reader.finished() || item_count(parsed) > kSocketMaxItems
        || resource_conflict(parsed, false))
        return ESP_ERR_INVALID_RESPONSE;
    result = std::move(parsed);
    return ESP_OK;
}

/**
 * @brief Read and decode the authoritative controller section from the shared store.
 * @param[out] result Decoded complete configuration set on success; unchanged on failure.
 * @return ESP_OK, a missing/storage error, or a record-validation error.
 */
esp_err_t load(Configurations& result)
{
    SettingsBytes bytes;
    auto error = settings_store_get(SettingsSection::Controllers, bytes);
    if (error != ESP_OK || (error = decode_record(bytes, result)) != ESP_OK)
        return error;
    StateJournalKey key{};
    if (bytes[8] != kControllerStorageVersion) {
        if (state_record_key(bytes, key)) {
            // Previous journaled formats keep frequent states outside flash; the NVS seed is
            // deliberately stale.
            activate_state_record(bytes);
            if (load_states(result) != ESP_OK)
                clear_states(result);
        }
        // A one-time migration records the old confirmed flags in state-memory before replacing
        // NVS.
        error = save(result);
        if (error != ESP_OK) {
            clear_states(result);
            service_error = "Перенос состояний в память не выполнен; выходы выключены";
        }
        return ESP_OK;
    }
    activate_state_record(bytes);
    error = load_states(result);
    if (error != ESP_OK) {
        // A current-format record must never resurrect its stale migration/import seeds.
        clear_states(result);
        ESP_LOGW(kTag,
                 "State memory unavailable: %s; starting with operative flags OFF",
                 esp_err_to_name(error));
    }
    return ESP_OK;
}

/**
 * @brief Serialize one module's portable settings and confirmed durable operative states.
 * @param[in] config Validated borrowed module configuration.
 * @param[in] kind Schema selecting switch state, Meteo binding or thermostat fields.
 * @return Owned JSON object, or nullptr on allocation failure.
 * @note Runtime measurements, faults and automatic thermostat relay demand are excluded.
 */
cJSON* backup_module_json(const Configuration& config, ControllerKind kind)
{
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddBoolToObject(root.get(), "enabled", config.enabled))
        return nullptr;
    if (kind == ControllerKind::Security) {
        if (!cJSON_AddStringToObject(
                root.get(), "sirenRelayId", config.security.sirenRelayId.c_str())
            || !cJSON_AddStringToObject(
                root.get(), "readerPortId", config.security.readerPortId.c_str())
            || !cJSON_AddNumberToObject(
                root.get(), "entryDelaySeconds", config.security.entryDelaySeconds)
            || !cJSON_AddNumberToObject(
                root.get(), "exitDelaySeconds", config.security.exitDelaySeconds)
            || !cJSON_AddBoolToObject(root.get(), "armed", config.armed)
            || !cJSON_AddBoolToObject(root.get(), "triggered", config.triggered))
            return nullptr;
        auto* keys = cJSON_AddArrayToObject(root.get(), "keys");
        if (!keys)
            return nullptr;
        for (const auto& key : config.security.keys) {
            Json object(cJSON_CreateObject(), cJSON_Delete);
            if (!object || !cJSON_AddStringToObject(object.get(), "id", key.id.c_str())
                || !cJSON_AddStringToObject(object.get(), "name", key.name.c_str())
                || !cJSON_AddStringToObject(object.get(), "address", key.address.c_str())
                || !cJSON_AddItemToArray(keys, object.get()))
                return nullptr;
            object.release();
        }
    }
    auto* items = cJSON_AddArrayToObject(root.get(), "items");
    if (!items)
        return nullptr;
    for (const auto& item : config.items) {
        Json object(kind == ControllerKind::Irrigation ? irrigation_item_json(item)
                    : kind == ControllerKind::Tanks    ? tank_item_json(item)
                                                       : cJSON_CreateObject(),
                    cJSON_Delete);
        if (kind == ControllerKind::Irrigation || kind == ControllerKind::Tanks) {
            if (!object || !cJSON_AddItemToArray(items, object.get()))
                return nullptr;
            object.release();
            continue;
        }
        if (!object || !cJSON_AddStringToObject(object.get(), "id", item.id.c_str())
            || !cJSON_AddStringToObject(object.get(), "name", item.name.c_str()))
            return nullptr;
        if (kind == ControllerKind::Meteo) {
            if (!cJSON_AddStringToObject(object.get(), "portId", item.portId.c_str())
                || !cJSON_AddStringToObject(object.get(), "sensorType", sensor_id(item.sensorType))
                || !cJSON_AddStringToObject(object.get(), "address", item.address.c_str()))
                return nullptr;
        } else if (kind == ControllerKind::Thermostats) {
            if (!cJSON_AddStringToObject(object.get(), "meteoId", item.meteoId.c_str())
                || !cJSON_AddStringToObject(object.get(), "relayId", item.relayId.c_str())
                || !cJSON_AddStringToObject(object.get(), "inputId", item.inputId.c_str())
                || !cJSON_AddBoolToObject(object.get(), "enabled", item.enabled)
                || !cJSON_AddStringToObject(object.get(), "mode", mode_id(item.mode))
                || !cJSON_AddNumberToObject(object.get(), "setpointC", item.setpointC)
                || !cJSON_AddNumberToObject(object.get(), "hysteresisC", item.hysteresisC))
                return nullptr;
        } else if (kind == ControllerKind::Security) {
            if (!cJSON_AddStringToObject(object.get(), "inputId", item.inputId.c_str())
                || !cJSON_AddStringToObject(
                    object.get(), "sensorType", security_type_id(item.securityType))
                || !cJSON_AddBoolToObject(object.get(), "entryDelay", item.entryDelay))
                return nullptr;
        } else if (!cJSON_AddStringToObject(object.get(), "relayId", item.relayId.c_str())
                   || !cJSON_AddStringToObject(object.get(), "inputId", item.inputId.c_str())
                   || !cJSON_AddBoolToObject(object.get(), "state", item.state))
            return nullptr;
        if (!cJSON_AddItemToArray(items, object.get()))
            return nullptr;
        object.release();
    }
    return root.release();
}

/**
 * @brief Decode and validate one portable module section against the active board profile.
 * @param[in] json Borrowed section with enabled and items fields.
 * @param[in] revision Nonzero local revision to assign to the imported section.
 * @param[out] parsed Decoded configuration; may be partially populated on failure.
 * @param[out] error Failure diagnostic; the caller manages clearing it after success.
 * @param[in] kind Module schema and port-validation policy.
 * @return True for valid fields and row values; cross-module ownership is checked by the caller.
 */
bool parse_backup_module(const cJSON* json,
                         std::uint32_t revision,
                         Configuration& parsed,
                         std::string& error,
                         ControllerKind kind)
{
    if (kind == ControllerKind::Security) {
        parsed = Configuration{};
        parsed.boardId = board_profile_active().id;
        parsed.revision = revision;
        return parse_security_module(json, parsed, error, true)
               && valid_configuration(parsed, true, kind);
    }
    const auto* enabled = cJSON_GetObjectItemCaseSensitive(json, "enabled");
    const auto* items = cJSON_GetObjectItemCaseSensitive(json, "items");
    if (!settings_json_fields(json, {"enabled", "items"}) || !cJSON_IsBool(enabled)
        || !cJSON_IsArray(items)
        || cJSON_GetArraySize(items)
               > static_cast<int>(kind == ControllerKind::Meteo ? kMeteoMaxItems : kSocketMaxItems)
        || revision == 0) {
        error = "Неполная или неизвестная схема контроллера";
        return false;
    }
    parsed = Configuration{};
    parsed.boardId = board_profile_active().id;
    parsed.revision = revision;
    parsed.enabled = cJSON_IsTrue(enabled);
    const cJSON* object;
    cJSON_ArrayForEach(object, items)
    {
        Item item;
        if (kind == ControllerKind::Meteo) {
            if (!parse_meteo_item(object, item)) {
                error = "Некорректные поля Метео или ROM DS18B20";
                return false;
            }
        } else if (kind == ControllerKind::Irrigation) {
            if (!parse_irrigation_item(object, item, true)) {
                error = "Некорректное правило полива";
                return false;
            }
        } else if (kind == ControllerKind::Tanks) {
            if (!parse_tank_item(object, item, true)) {
                error = "Некорректные поля бака";
                return false;
            }
        } else if (kind == ControllerKind::Thermostats) {
            if (!parse_thermostat_item(object, item, true)) {
                error = "Некорректные поля термостата";
                return false;
            }
        } else {
            const auto* state = cJSON_GetObjectItemCaseSensitive(object, "state");
            if (!settings_json_fields(object, {"id", "name", "relayId", "inputId", "state"})
                || !cJSON_IsBool(state) || !text_field(object, "id", item.id, kSocketMaxIdBytes)
                || !text_field(object, "name", item.name, kSocketMaxNameBytes)
                || !text_field(object, "relayId", item.relayId, 32)
                || !text_field(object, "inputId", item.inputId, 32)) {
                error = "Некорректный элемент контроллера в резервной копии";
                return false;
            }
            item.state = cJSON_IsTrue(state);
        }
        parsed.items.push_back(std::move(item));
    }
    if (!valid_configuration(parsed, true, kind)) {
        error = "Некорректные привязки или состояния контроллера";
        return false;
    }
    return true;
}

}  // namespace fcplcn::controllers::detail

/** @endcond */

using namespace fcplcn::controllers::detail;

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decode a durable controller record into full backup configuration.
 * @param record Borrowed opaque Controllers section, including supported legacy versions.
 * @param[out] error Failure diagnostic.
 * @return Owned module-config JSON, or nullptr on decoding/allocation failure.
 * @details Includes confirmed switch states and enabled flags, but no measurement,
 * automatic thermostat demand or RAM inhibit. Canonical board IDs are used.
 * @endcond
 */
cJSON* controllers_backup_json(const SettingsBytes& record, std::string& error)
{
    Configurations parsed;
    if (decode_record(record, parsed) != ESP_OK || parsed[0].boardId != board_profile_active().id) {
        error = "Сохранённые контроллеры повреждены или относятся к другой плате";
        return nullptr;
    }
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root) {
        error = "Недостаточно памяти";
        return nullptr;
    }
    for (std::size_t module = 0; module < kControllerCount; ++module) {
        Json json(backup_module_json(parsed[module], static_cast<ControllerKind>(module)),
                  cJSON_Delete);
        if (!json
            || !cJSON_AddItemToObject(
                root.get(), controller_id(static_cast<ControllerKind>(module)), json.get())) {
            error = "Недостаточно памяти";
            return nullptr;
        }
        json.release();
    }
    return root.release();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param meteoRevision Target Meteo config revision.
 * @param thermostatRevision Target Thermostats config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @param securityRevision Target Security configuration revision.
 * @param tankRevision Target tank configuration revision.
 * @param irrigationRevision Target irrigation configuration revision.
 * @return Typed result distinguishing malformed data from resource conflicts.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 * @endcond
 */
ControllerResult controllers_backup_prepare(const cJSON* json,
                                            std::uint32_t socketRevision,
                                            std::uint32_t lightRevision,
                                            std::uint32_t meteoRevision,
                                            std::uint32_t thermostatRevision,
                                            SettingsBytes& record,
                                            std::string& error,
                                            std::uint32_t securityRevision,
                                            std::uint32_t tankRevision,
                                            std::uint32_t irrigationRevision)
{
    const bool has_security = cJSON_GetObjectItemCaseSensitive(json, "security") != nullptr;
    const bool has_tanks = cJSON_GetObjectItemCaseSensitive(json, "tanks") != nullptr;
    const bool has_irrigation = cJSON_HasObjectItem(json, "irrigation");
    if (!(has_irrigation ? settings_json_fields(json,
                                                {"sockets",
                                                 "lights",
                                                 "meteo",
                                                 "thermostats",
                                                 "security",
                                                 "tanks",
                                                 "irrigation"})
          : has_tanks
              ? settings_json_fields(
                    json, {"sockets", "lights", "meteo", "thermostats", "security", "tanks"})
          : has_security
              ? settings_json_fields(json,
                                     {"sockets", "lights", "meteo", "thermostats", "security"})
              : settings_json_fields(json, {"sockets", "lights", "meteo", "thermostats"}))) {
        error = "Неизвестный или отсутствующий контроллер в резервной копии";
        return SocketResult::InvalidInput;
    }
    Configurations parsed = defaults();
    const std::array<std::uint32_t, kControllerCount> revisions{{socketRevision,
                                                                 lightRevision,
                                                                 meteoRevision,
                                                                 thermostatRevision,
                                                                 securityRevision,
                                                                 tankRevision,
                                                                 irrigationRevision}};
    for (std::size_t module = 0; module < kControllerCount; ++module) {
        const auto kind = static_cast<ControllerKind>(module);
        if (kind == ControllerKind::Irrigation && !has_irrigation) {
            parsed[module].revision = irrigationRevision;
            continue;
        }
        if (kind == ControllerKind::Tanks && !has_tanks) {
            parsed[module].revision = tankRevision;
            continue;
        }
        if (kind == ControllerKind::Security && !has_security) {
            parsed[module].revision = securityRevision;
            continue;
        }
        if (!parse_backup_module(cJSON_GetObjectItemCaseSensitive(json, controller_id(kind)),
                                 revisions[module],
                                 parsed[module],
                                 error,
                                 kind))
            return SocketResult::InvalidInput;
    }
    if (item_count(parsed) > kSocketMaxItems || resource_conflict(parsed, true)) {
        error = "Конфликт назначений реле, входов или датчиков в резервной копии";
        return SocketResult::Conflict;
    }
    auto encoded = encode_record(parsed);
    if (encoded.empty() || encoded.size() > kMaxBlobBytes) {
        error = "Настройки превышают доступный объём памяти контроллеров";
        return SocketResult::InvalidInput;
    }
    record = std::move(encoded);
    return SocketResult::Ok;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param meteoRevision Target Meteo config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @return Typed result distinguishing malformed data from resource conflicts.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 * @endcond
 */
ControllerResult controllers_backup_prepare(const cJSON* json,
                                            std::uint32_t socketRevision,
                                            std::uint32_t lightRevision,
                                            std::uint32_t meteoRevision,
                                            SettingsBytes& record,
                                            std::string& error)
{
    if (settings_json_fields(
            json, {"sockets", "lights", "meteo", "thermostats", "security", "tanks", "irrigation"})
        || settings_json_fields(json,
                                {"sockets", "lights", "meteo", "thermostats", "security", "tanks"})
        || settings_json_fields(json, {"sockets", "lights", "meteo", "thermostats"})
        || settings_json_fields(json, {"sockets", "lights", "meteo", "thermostats", "security"}))
        return controllers_backup_prepare(
            json, socketRevision, lightRevision, meteoRevision, 1, record, error);
    if (!settings_json_fields(json, {"sockets", "lights", "meteo"})) {
        error = "Неизвестный или отсутствующий контроллер в резервной копии";
        return SocketResult::InvalidInput;
    }
    Json extended(cJSON_Duplicate(json, true), cJSON_Delete);
    auto* thermostat = extended ? cJSON_AddObjectToObject(extended.get(), "thermostats") : nullptr;
    if (!thermostat || !cJSON_AddBoolToObject(thermostat, "enabled", false)
        || !cJSON_AddArrayToObject(thermostat, "items")) {
        error = "Недостаточно памяти";
        return SocketResult::StorageError;
    }
    return controllers_backup_prepare(
        extended.get(), socketRevision, lightRevision, meteoRevision, 1, record, error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @return Typed result distinguishing malformed data from resource conflicts.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 * @endcond
 */
ControllerResult controllers_backup_prepare(const cJSON* json,
                                            std::uint32_t socketRevision,
                                            std::uint32_t lightRevision,
                                            SettingsBytes& record,
                                            std::string& error)
{
    if (settings_json_fields(json, {"sockets", "lights", "meteo"})
        || settings_json_fields(json, {"sockets", "lights", "meteo", "thermostats"})
        || settings_json_fields(json, {"sockets", "lights", "meteo", "thermostats", "security"}))
        return controllers_backup_prepare(json, socketRevision, lightRevision, 1, record, error);
    if (!settings_json_fields(json, {"sockets", "lights"})) {
        error = "Неизвестный или отсутствующий контроллер в резервной копии";
        return SocketResult::InvalidInput;
    }
    Json extended(cJSON_Duplicate(json, true), cJSON_Delete);
    auto* meteo = extended ? cJSON_AddObjectToObject(extended.get(), "meteo") : nullptr;
    if (!meteo || !cJSON_AddBoolToObject(meteo, "enabled", false)
        || !cJSON_AddArrayToObject(meteo, "items")) {
        error = "Недостаточно памяти";
        return SocketResult::StorageError;
    }
    return controllers_backup_prepare(
        extended.get(), socketRevision, lightRevision, 1, record, error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param meteoRevision Target Meteo config revision.
 * @param thermostatRevision Target Thermostats config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @param securityRevision Target Security configuration revision.
 * @param tankRevision Target tank configuration revision.
 * @param irrigationRevision Target irrigation configuration revision.
 * @return True on successful validation/encoding.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 * @endcond
 */
bool controllers_backup_record(const cJSON* json,
                               std::uint32_t socketRevision,
                               std::uint32_t lightRevision,
                               std::uint32_t meteoRevision,
                               std::uint32_t thermostatRevision,
                               SettingsBytes& record,
                               std::string& error,
                               std::uint32_t securityRevision,
                               std::uint32_t tankRevision,
                               std::uint32_t irrigationRevision)
{
    return controllers_backup_prepare(json,
                                      socketRevision,
                                      lightRevision,
                                      meteoRevision,
                                      thermostatRevision,
                                      record,
                                      error,
                                      securityRevision,
                                      tankRevision,
                                      irrigationRevision)
           == SocketResult::Ok;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param meteoRevision Target Meteo config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @return True on successful validation/encoding.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 * @endcond
 */
bool controllers_backup_record(const cJSON* json,
                               std::uint32_t socketRevision,
                               std::uint32_t lightRevision,
                               std::uint32_t meteoRevision,
                               SettingsBytes& record,
                               std::string& error)
{
    return controllers_backup_prepare(
               json, socketRevision, lightRevision, meteoRevision, record, error)
           == SocketResult::Ok;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and encode controller backup JSON without live state or storage changes.
 * @param json Borrowed module-config JSON; not a runtime status snapshot.
 * @param socketRevision Target Sockets config revision.
 * @param lightRevision Target Lights config revision.
 * @param[out] record Encoded current-version Controllers section on success.
 * @param[out] error Failure diagnostic.
 * @return True on successful validation/encoding.
 * @details Pure structural codecs preserve valid dangling Meteo references as
 * fault-OFF configurations. New assignments still require a known source in
 * controller_update(). Missing modules in compatibility overloads are disabled
 * and empty with initial revision 1; unknown fields/modules are rejected.
 * @endcond
 */
bool controllers_backup_record(const cJSON* json,
                               std::uint32_t socketRevision,
                               std::uint32_t lightRevision,
                               SettingsBytes& record,
                               std::string& error)
{
    return controllers_backup_prepare(json, socketRevision, lightRevision, record, error)
           == SocketResult::Ok;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decode module revisions without taking module locks, doing I/O or changing storage.
 * @param record Borrowed durable Controllers section.
 * @param[out] socketRevision Decoded Sockets config revision.
 * @param[out] lightRevision Decoded Lights config revision.
 * @param[out] meteoRevision Decoded Meteo config revision.
 * @param[out] thermostatRevision Decoded Thermostats config revision.
 * @param[out] error Failure diagnostic.
 * @param[out] securityRevision Optional Security revision destination; nullptr skips it.
 * @param[out] tankRevision Optional tank revision destination; nullptr skips it.
 * @param[out] irrigationRevision Optional irrigation revision destination; nullptr skips it.
 * @return True for a valid record.
 * @details Missing modules in historical records have initial revision 1.
 * @endcond
 */
bool controllers_record_revisions(const SettingsBytes& record,
                                  std::uint32_t& socketRevision,
                                  std::uint32_t& lightRevision,
                                  std::uint32_t& meteoRevision,
                                  std::uint32_t& thermostatRevision,
                                  std::string& error,
                                  std::uint32_t* securityRevision,
                                  std::uint32_t* tankRevision,
                                  std::uint32_t* irrigationRevision)
{
    Configurations parsed;
    if (decode_record(record, parsed) != ESP_OK) {
        error = "Повреждены сохранённые контроллеры";
        return false;
    }
    socketRevision = parsed[0].revision;
    lightRevision = parsed[1].revision;
    meteoRevision = parsed[2].revision;
    thermostatRevision = parsed[3].revision;
    if (securityRevision)
        *securityRevision = parsed[4].revision;
    if (irrigationRevision)
        *irrigationRevision = parsed[6].revision;
    if (tankRevision)
        *tankRevision = parsed[5].revision;
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decode module revisions without taking module locks, doing I/O or changing storage.
 * @param record Borrowed durable Controllers section.
 * @param[out] socketRevision Decoded Sockets config revision.
 * @param[out] lightRevision Decoded Lights config revision.
 * @param[out] meteoRevision Decoded Meteo config revision.
 * @param[out] error Failure diagnostic.
 * @return True for a valid record.
 * @details Missing modules in historical records have initial revision 1.
 * @endcond
 */
bool controllers_record_revisions(const SettingsBytes& record,
                                  std::uint32_t& socketRevision,
                                  std::uint32_t& lightRevision,
                                  std::uint32_t& meteoRevision,
                                  std::string& error)
{
    std::uint32_t ignored;
    return controllers_record_revisions(
        record, socketRevision, lightRevision, meteoRevision, ignored, error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decode module revisions without taking module locks, doing I/O or changing storage.
 * @param record Borrowed durable Controllers section.
 * @param[out] socketRevision Decoded Sockets config revision.
 * @param[out] lightRevision Decoded Lights config revision.
 * @param[out] error Failure diagnostic.
 * @return True for a valid record.
 * @details Missing modules in historical records have initial revision 1.
 * @endcond
 */
bool controllers_record_revisions(const SettingsBytes& record,
                                  std::uint32_t& socketRevision,
                                  std::uint32_t& lightRevision,
                                  std::string& error)
{
    std::uint32_t ignored;
    return controllers_record_revisions(record, socketRevision, lightRevision, ignored, error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Extract only the Sockets backup section from any supported controller record.
 * @param record Borrowed durable record.
 * @param[out] error Failure diagnostic.
 * @return Owned Sockets config JSON, or nullptr on failure.
 * @endcond
 */
cJSON* socket_backup_json(const SettingsBytes& record, std::string& error)
{
    Json combined(controllers_backup_json(record, error), cJSON_Delete);
    return combined ? cJSON_DetachItemFromObjectCaseSensitive(combined.get(), "sockets") : nullptr;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Encode legacy-style Sockets backup JSON with other modules disabled/empty.
 * @param json Borrowed Sockets config JSON.
 * @param revision Target Sockets config revision.
 * @param[out] record Encoded current-version Controllers section.
 * @param[out] error Failure diagnostic.
 * @return True on successful structural/resource validation and encoding.
 * @endcond
 */
bool socket_backup_record(const cJSON* json,
                          std::uint32_t revision,
                          SettingsBytes& record,
                          std::string& error)
{
    Configurations parsed = defaults();
    if (!parse_backup_module(json, revision, parsed[0], error))
        return false;
    if (resource_conflict(parsed, true)) {
        error = "Конфликт назначений реле или входов";
        return false;
    }
    record = encode_record(parsed);
    return !record.empty();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Decode only the Sockets revision without touching live state or storage.
 * @param record Borrowed controller record.
 * @param[out] revision Decoded revision.
 * @param[out] error Failure diagnostic.
 * @return True when the record is valid.
 * @endcond
 */
bool socket_record_revision(const SettingsBytes& record,
                            std::uint32_t& revision,
                            std::string& error)
{
    std::uint32_t ignored;
    return controllers_record_revisions(record, revision, ignored, error);
}
