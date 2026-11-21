/**
 * @file board_profile.cpp
 * @brief Immutable board wiring tables and canonical/legacy identity lookup.
 * @details Registry pointers have process lifetime. Atomic single-assignment activation prevents
 * a live driver from observing another pin map; UI selection only persists a future boot ID.
 */
#include "hardware/board_profile.h"

#include <atomic>
#include <memory>

#include "cJSON.h"

namespace {
// Wiring sources in the sibling fcplcn-boards repository:
// FCPLCN-161608-1v0/{FCPLCN-CPU-08-1v0,FCPLCN-RLY-1616-1v0}/*.xml netlists.
// Startup levels/delays and isolated sensor constraints: ASSEMBLY.md.
constexpr BoardSafeBootGpio kSafeBootGpios[] = {
    {9, true, "ETH_CS_N"},
    {14, false, "ETH_RST_N"},
    {6, false, "MCP_RESET_N"},
    {7, true, "NET_LED"},
    {15, true, "STATUS_LED"},
    {16, true, "ALARM_LED"},
    {8, true, "RS485_TX_CPU"},
    {48, false, "RS485_DIR_CPU"},
};

constexpr BoardI2cBus kI2cBuses[] = {
    {"io-expanders", 4, 5, false, 100000, true},
    {"isolated-sensors", 41, 42, true, 100000, true},
};

// U5 A2/A1/A0 = 000; U6 = 001. GPA1..7 and GPB7 drive relays;
// GPB0..6 and GPA0 receive optocoupler inputs. INTA/INTB are unconnected.
constexpr BoardMcp23017 kExpanders[] = {
    {"U5", "io-expanders", 0x20, 0x80fe, 0x7f01},
    {"U6", "io-expanders", 0x21, 0x80fe, 0x7f01},
};

constexpr BoardExpanderChannel kRelays[] = {
    {0, 1, true, "rly-0/1"},
    {0, 2, true, "rly-0/2"},
    {0, 3, true, "rly-0/3"},
    {0, 4, true, "rly-0/4"},
    {0, 5, true, "rly-0/5"},
    {0, 6, true, "rly-0/6"},
    {0, 7, true, "rly-0/7"},
    {0, 15, true, "rly-0/8"},
    {1, 1, true, "rly-0/9"},
    {1, 2, true, "rly-0/10"},
    {1, 3, true, "rly-0/11"},
    {1, 4, true, "rly-0/12"},
    {1, 5, true, "rly-0/13"},
    {1, 6, true, "rly-0/14"},
    {1, 7, true, "rly-0/15"},
    {1, 15, true, "rly-0/16"},
};

constexpr BoardExpanderChannel kInputs[] = {
    {0, 8, false, "in-0/1"},
    {0, 9, false, "in-0/2"},
    {0, 10, false, "in-0/3"},
    {0, 11, false, "in-0/4"},
    {0, 12, false, "in-0/5"},
    {0, 13, false, "in-0/6"},
    {0, 14, false, "in-0/7"},
    {0, 0, false, "in-0/8"},
    {1, 8, false, "in-0/9"},
    {1, 9, false, "in-0/10"},
    {1, 10, false, "in-0/11"},
    {1, 11, false, "in-0/12"},
    {1, 12, false, "in-0/13"},
    {1, 13, false, "in-0/14"},
    {1, 14, false, "in-0/15"},
    {1, 0, false, "in-0/16"},
};

constexpr BoardLed kLeds[] = {
    {"led-net", 7, true},
    {"led-status", 15, true},
    {"led-alarm", 16, true},
};

constexpr BoardSensorPort kSensorPorts[] = {
    {"sens-0/1", 39, true, true, true},
    {"sens-0/2", 40, true, true, true},
    {"sens-0/3", 17, true, true, true},
    {"sens-0/4", 18, true, true, true},
    {"sens-0/5", 1, true, true, true},
    {"sens-0/6", 2, true, true, true},
    {"sens-0/7", 38, true, true, true},
    {"sens-0/8", 44, true, true, true},
};

// All connected ESP GPIOs, with shared-bus aliases for the on-board RTC.
// Relay and input names live in the expander channel tables above.
constexpr BoardNamedGpio kNamedGpios[] = {
    {"boot", 0, "input"},           {"i2c-sda", 4, "i2c"},          {"i2c-scl", 5, "i2c"},
    {"i2c-ext-sda", 41, "i2c"},     {"i2c-ext-scl", 42, "i2c"},     {"rtc-sda", 4, "i2c"},
    {"rtc-scl", 5, "i2c"},          {"mcp-reset", 6, "output"},     {"rs485-tx", 8, "uart"},
    {"rs485-rx", 47, "input"},      {"rs485-dir", 48, "output"},    {"eth-cs", 9, "output"},
    {"eth-sck", 10, "spi"},         {"eth-mosi", 11, "spi"},        {"eth-miso", 12, "spi"},
    {"eth-int", 13, "input"},       {"eth-reset", 14, "output"},    {"led-net", 7, "output"},
    {"led-status", 15, "output"},   {"led-alarm", 16, "output"},    {"sens-0/1", 39, "open-drain"},
    {"sens-0/2", 40, "open-drain"}, {"sens-0/3", 17, "open-drain"}, {"sens-0/4", 18, "open-drain"},
    {"sens-0/5", 1, "open-drain"},  {"sens-0/6", 2, "open-drain"},  {"sens-0/7", 38, "open-drain"},
    {"sens-0/8", 44, "open-drain"}, {"usb-dm", 19, "usb"},          {"usb-dp", 20, "usb"},
    {"usb-vbus", 21, "input"},
};

/**
 * @brief Obtain a wiring-table extent without decaying its array type.
 * @tparam T Element type of the immutable board table.
 * @tparam N Number of array elements deduced by the compiler.
 * @return Compile-time element count; the unnamed array argument is not read.
 */
template <typename T, std::size_t N> constexpr std::size_t count(const T (&)[N])
{
    return N;
}

const BoardProfile kCurrentBoard = [] {
    BoardProfile board{};
    board.id = kDefaultBoardProfileId;
    board.name = "FCPLCN-161608-1v0";
    board.mcu = "esp32s3";
    board.flashBytes = 16U * 1024U * 1024U;
    board.psramBytes = 8U * 1024U * 1024U;
    // SPI2 is the existing firmware's bus selection, not a PCB pin constraint.
    // Keep the already-used 2/3 ms reset margins above the documented 1/2 ms minima.
    board.w5500 = {true, BoardSpiBus::Spi2, 9, 10, 11, 12, 13, 14, 10000000, 0, 2, 3};
    // BOOT input and five-second recovery gesture preserve existing behavior.
    board.recoveryButton = {0, true, true, 5000};
    board.safeBootGpios = kSafeBootGpios;
    board.safeBootGpioCount = count(kSafeBootGpios);
    board.i2cBuses = kI2cBuses;
    board.i2cBusCount = count(kI2cBuses);
    board.expanders = kExpanders;
    board.expanderCount = count(kExpanders);
    board.expanderResetGpio = 6;
    board.expanderResetMinUs = 100;
    board.expanderDriverImplemented = true;
    board.relays = kRelays;
    board.relayCount = count(kRelays);
    board.inputs = kInputs;
    board.inputCount = count(kInputs);
    board.leds = kLeds;
    board.ledCount = count(kLeds);
    board.ledDriverImplemented = true;
    board.sensorPorts = kSensorPorts;
    board.sensorPortCount = count(kSensorPorts);
    // ADM2687E half duplex; buffered logic, DE and /RE share direction GPIO.
    // Register the wiring only: the RS485 protocol driver is not implemented.
    board.rs485 = BoardRs485{1, 8, 47, 48, true, false};
    board.usbVbusSenseGpio = 21;
    board.namedGpios = kNamedGpios;
    board.namedGpioCount = count(kNamedGpios);
    board.rtc = BoardRtc{"DS3231MZ+", "io-expanders", 0x68, -1, -1};
    // Lower U9: A0/A1/A2 and WP are grounded; SDA/SCL share the internal bus.
    board.fram = BoardFram{"FM24CL64B-GTR", "io-expanders", 0x50, 8192};
    return board;
}();

const BoardProfile* const kProfiles[] = {&kCurrentBoard};
std::atomic<const BoardProfile*> selected{nullptr};
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Resolve a registered canonical board ID or explicitly listed legacy alias.
 * @param[in] id Borrowed requested identity.
 * @return Canonical process-lifetime view, or an empty view for an unknown identity.
 * @note Thread-safe, allocation-free and independent of activation.
 * @endcond
 */
std::string_view board_profile_canonical_id(std::string_view id)
{
    if (id == kLegacyBoardProfileId)
        id = kDefaultBoardProfileId;
    for (const auto* profile : kProfiles) {
        if (id == profile->id)
            return profile->id;
    }
    return {};
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Find immutable registry data for a canonical ID or known alias.
 * @param[in] id Borrowed requested identity.
 * @return Borrowed process-lifetime profile pointer, or nullptr. Thread-safe.
 * @endcond
 */
const BoardProfile* board_profile_find(std::string_view id)
{
    id = board_profile_canonical_id(id);
    if (id.empty())
        return nullptr;
    for (const auto* profile : kProfiles) {
        if (id == profile->id)
            return profile;
    }
    return nullptr;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Obtain the boot-active board, falling back to the default before activation.
 * @return Borrowed immutable process-lifetime profile reference. Thread-safe.
 * @endcond
 */
const BoardProfile& board_profile_active()
{
    const auto* profile = selected.load(std::memory_order_acquire);
    return profile != nullptr ? *profile : kCurrentBoard;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Select a board once before initializing profile-bound hardware.
 * @param[in] id Registered canonical ID or known legacy alias.
 * @return True for the first valid activation or the already-active profile; false otherwise.
 * @pre Startup call precedes all profile-bound drivers. Persisted changes take effect at reboot.
 * @note Atomic single assignment; a concurrent caller cannot switch the winning profile.
 * @endcond
 */
bool board_profile_activate(std::string_view id)
{
    const auto* profile = board_profile_find(id);
    if (profile == nullptr)
        return false;
    const BoardProfile* expected = nullptr;
    if (selected.compare_exchange_strong(expected, profile, std::memory_order_acq_rel))
        return true;
    return expected == profile;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Build read-only identity, capability, driver and pin-map metadata.
 * @param[in] profile Borrowed immutable registered board descriptor.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on allocation failure.
 * @note Thread-safe; the profile and its referenced arrays must remain alive.
 * @endcond
 */
cJSON* board_profile_json(const BoardProfile& profile)
{
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddStringToObject(root.get(), "boardId", profile.id)
        || !cJSON_AddStringToObject(root.get(), "boardName", profile.name)
        || !cJSON_AddStringToObject(root.get(), "mcu", profile.mcu)
        || !cJSON_AddNumberToObject(root.get(), "flashBytes", profile.flashBytes)
        || !cJSON_AddNumberToObject(root.get(), "psramBytes", profile.psramBytes))
        return nullptr;

    auto* legacy_ids = cJSON_AddArrayToObject(root.get(), "legacyIds");
    if (legacy_ids == nullptr)
        return nullptr;
    if (std::string_view(profile.id) == kDefaultBoardProfileId) {
        Json legacy_id(cJSON_CreateString(kLegacyBoardProfileId), cJSON_Delete);
        if (!legacy_id || !cJSON_AddItemToArray(legacy_ids, legacy_id.get()))
            return nullptr;
        legacy_id.release();
    }

    auto* capabilities = cJSON_AddObjectToObject(root.get(), "capabilities");
    if (capabilities == nullptr
        || !cJSON_AddBoolToObject(capabilities, "ethernet", profile.w5500.present)
        || !cJSON_AddNumberToObject(capabilities, "relays", profile.relayCount)
        || !cJSON_AddNumberToObject(capabilities, "inputs", profile.inputCount)
        || !cJSON_AddNumberToObject(capabilities, "i2cBuses", profile.i2cBusCount)
        || !cJSON_AddNumberToObject(capabilities, "sensorPorts", profile.sensorPortCount)
        || !cJSON_AddBoolToObject(capabilities, "rs485", profile.rs485.has_value()))
        return nullptr;
    cJSON_AddBoolToObject(capabilities, "rtc", profile.rtc.has_value());
    if (!cJSON_AddBoolToObject(capabilities, "fram", profile.fram.has_value()))
        return nullptr;
    if (profile.fram) {
        auto* fram = cJSON_AddObjectToObject(root.get(), "fram");
        if (fram == nullptr || !cJSON_AddStringToObject(fram, "model", profile.fram->model)
            || !cJSON_AddStringToObject(fram, "i2cBus", profile.fram->i2cBusId)
            || !cJSON_AddNumberToObject(fram, "address", profile.fram->address)
            || !cJSON_AddNumberToObject(fram, "capacityBytes", profile.fram->capacityBytes))
            return nullptr;
    }
    cJSON_AddItemToObject(root.get(), "pinMap", board_profile_pin_map_json(profile));

    bool sensors_implemented = profile.sensorPortCount != 0;
    for (std::size_t i = 0; i < profile.sensorPortCount; ++i) {
        sensors_implemented = sensors_implemented && profile.sensorPorts[i].driverImplemented;
    }
    auto* drivers = cJSON_AddObjectToObject(root.get(), "driversImplemented");
    if (drivers == nullptr || !cJSON_AddBoolToObject(drivers, "ethernet", profile.w5500.present)
        || !cJSON_AddBoolToObject(drivers, "relays", profile.expanderDriverImplemented)
        || !cJSON_AddBoolToObject(drivers, "inputs", profile.expanderDriverImplemented)
        || !cJSON_AddBoolToObject(drivers, "leds", profile.ledDriverImplemented)
        || !cJSON_AddBoolToObject(drivers, "sensorPorts", sensors_implemented)
        || !cJSON_AddBoolToObject(drivers, "fram", profile.fram.has_value())
        || !cJSON_AddBoolToObject(
            drivers, "rs485", profile.rs485.has_value() && profile.rs485->driverImplemented))
        return nullptr;
    return root.release();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Build metadata for the active boot profile.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr. Thread-safe.
 * @endcond
 */
cJSON* board_profile_status_json()
{
    return board_profile_json(board_profile_active());
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Build the diagnostic semantic GPIO table.
 * @param[in] profile Borrowed immutable board descriptor.
 * @return Caller-owned JSON array for cJSON_Delete(), or nullptr. Thread-safe.
 * @endcond
 */
cJSON* board_profile_pin_map_json(const BoardProfile& profile)
{
    auto* array = cJSON_CreateArray();
    if (array == nullptr)
        return nullptr;
    for (std::size_t i = 0; i < profile.namedGpioCount; ++i) {
        const auto& pin = profile.namedGpios[i];
        auto* item = cJSON_CreateObject();
        if (item == nullptr) {
            cJSON_Delete(array);
            return nullptr;
        }
        cJSON_AddStringToObject(item, "name", pin.name);
        cJSON_AddNumberToObject(item, "gpio", pin.gpio);
        cJSON_AddStringToObject(item, "direction", pin.direction);
        cJSON_AddItemToArray(array, item);
    }
    return array;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief List registered board metadata, including known legacy IDs.
 * @return Caller-owned JSON array for cJSON_Delete(), or nullptr. Thread-safe.
 * @endcond
 */
cJSON* board_profiles_json()
{
    Json profiles(cJSON_CreateArray(), cJSON_Delete);
    if (!profiles)
        return nullptr;
    for (const auto* profile : kProfiles) {
        Json item(board_profile_json(*profile), cJSON_Delete);
        if (!item || !cJSON_AddItemToArray(profiles.get(), item.get()))
            return nullptr;
        item.release();
    }
    return profiles.release();
}
