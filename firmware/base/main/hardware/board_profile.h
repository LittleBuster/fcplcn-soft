/**
 * @file board_profile.h
 * @brief Immutable board wiring registry and single-assignment boot activation.
 * @details Pointers and string views refer to static registry data. Profile tables describe
 * electrical wiring and capabilities; configuration selects a registered ID, never raw pins.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>

struct cJSON;

/// Fixed canonical identity of the current-generation F-RAM board.
inline constexpr const char* kCurrentBoardProfileId = "fcplcn-161608-1v0";
/// Only the explicitly registered historical alias is accepted during migration.
inline constexpr const char* kLegacyBoardProfileId = "wifi-relay-16-r2-stack";
/// Previous-generation test board with EEPROM state storage.
inline constexpr const char* kFcplc080806BoardProfileId = "fcplc-080806-3v1";

#ifndef FCPLCN_BOOT_BOARD_ID
/// Default boot profile for standalone builds that omit the CMake definition.
#define FCPLCN_BOOT_BOARD_ID "fcplcn-161608-1v0"
#endif
/// First-boot default only; a valid persisted profile always takes precedence.
inline constexpr const char* kDefaultBoardProfileId = FCPLCN_BOOT_BOARD_ID;
static_assert(std::string_view(kDefaultBoardProfileId) == kCurrentBoardProfileId
                  || std::string_view(kDefaultBoardProfileId) == kFcplc080806BoardProfileId,
              "FCPLCN_BOOT_BOARD_ID must select a registered physical board");

/** @brief Hardware SPI controller selection, independent of the PCB signal pins. */
enum class BoardSpiBus {
    Spi2,  ///< ESP32 SPI2 peripheral.
    Spi3  ///< ESP32 SPI3 peripheral.
};

/** @brief W5500 wiring and SPI/reset timing policy. */
struct BoardW5500 {
    bool present;  ///< Whether this peripheral is fitted.
    BoardSpiBus spiBus;  ///< Hardware SPI bus selection.
    int csGpio;  ///< Active-low chip-select GPIO.
    int clockGpio;  ///< SPI clock GPIO.
    int mosiGpio;  ///< SPI controller-to-peripheral GPIO.
    int misoGpio;  ///< SPI peripheral-to-controller GPIO.
    int interruptGpio;  ///< Interrupt GPIO, or -1 when not connected.
    int resetGpio;  ///< Reset GPIO, or -1 when not connected.
    std::uint32_t spiClockHz;  ///< SPI clock frequency in hertz.
    std::uint8_t spiMode;  ///< SPI mode number.
    std::uint32_t resetAssertMs;  ///< Minimum reset assertion time in milliseconds.
    std::uint32_t resetRecoverMs;  ///< Delay after releasing reset, in milliseconds.
};

/** @brief Physical gesture that requests network recovery without erasing the account. */
struct BoardRecoveryButton {
    int gpio;  ///< ESP32 GPIO number.
    bool activeLow;  ///< True when the asserted electrical level is LOW.
    bool pullUp;  ///< Enable the GPIO internal pull-up for this button.
    std::uint32_t holdMs;  ///< Continuous press time required for recovery, in milliseconds.
};

// Write levelHigh before switching the corresponding pin to output mode.
/** @brief GPIO preload applied before enabling output direction during startup. */
struct BoardSafeBootGpio {
    int gpio;  ///< ESP32 GPIO number.
    bool levelHigh;  ///< Preloaded output level before direction changes.
    const char* signal;  ///< Static schematic signal name.
};

/** @brief Named shared I2C bus and its initialization policy. */
struct BoardI2cBus {
    const char* id;  ///< Stable canonical or bus identifier.
    int sdaGpio;  ///< I2C data GPIO.
    int sclGpio;  ///< I2C clock GPIO.
    bool isolated;  ///< Whether this port/bus is electrically isolated.
    // Zero means the schematic does not prescribe the driver's clock policy.
    std::uint32_t
        initialClockHz;  ///< Initial I2C frequency; zero leaves clock policy to the driver.
    bool driverImplemented;  ///< Whether the corresponding firmware driver exists.
};

/** @brief MCP23017 address and mutually exclusive relay/input bit masks. */
struct BoardMcp23017 {
    const char* reference;  ///< Static schematic component reference.
    const char* i2cBusId;  ///< Identifier of the owning profile I2C bus.
    std::uint8_t address;  ///< Seven-bit I2C slave address.
    std::uint16_t relayMask;  ///< MCP pins assigned as relay outputs.
    std::uint16_t inputMask;  ///< Pins receiving external input levels.
    std::uint16_t inputPullupMask = 0;  ///< Internal pull-ups required by open-collector inputs.
};

// MCP bit numbering: GPA0..7 = 0..7, GPB0..7 = 8..15.
/** @brief Stable channel name mapped to one MCP pin and logical polarity. */
struct BoardExpanderChannel {
    std::uint8_t expanderIndex;  ///< Index into BoardProfile::expanders.
    std::uint8_t pin;  ///< MCP bit index: GPA0..7=0..7, GPB0..7=8..15.
    bool activeHigh;  ///< True when HIGH means logically active.
    const char* name;  ///< Static user-facing/profile channel name.
};

/** @brief Named local LED with its electrical polarity. */
struct BoardLed {
    const char* name;  ///< Static user-facing/profile channel name.
    int gpio;  ///< ESP32 GPIO number.
    bool activeLow;  ///< True when the asserted electrical level is LOW.
};

/** @brief Named isolated sensor channel and electrical open-drain requirement. */
struct BoardSensorPort {
    const char* name;  ///< Static user-facing/profile channel name.
    int gpio;  ///< ESP32 GPIO number.
    bool isolated;  ///< Whether this port/bus is electrically isolated.
    bool openDrainRequired;  ///< Firmware must release HIGH rather than drive a push-pull HIGH.
    bool driverImplemented;  ///< Whether the corresponding firmware driver exists.
};

/** @brief RS485 UART/transceiver wiring; metadata does not initialize a fieldbus protocol. */
struct BoardRs485 {
    int uart;  ///< UART controller number.
    int txGpio;  ///< UART transmit GPIO.
    int rxGpio;  ///< UART receive GPIO.
    int directionGpio;  ///< Shared transceiver transmit-enable GPIO.
    bool isolated;  ///< Whether this port/bus is electrically isolated.
    bool driverImplemented;  ///< Whether the corresponding firmware driver exists.
};

/** @brief Read-only semantic GPIO entry for API/UI diagnostics. */
struct BoardNamedGpio {
    const char* name;  ///< Static user-facing/profile channel name.
    int gpio;  ///< ESP32 GPIO number.
    const char* direction;  ///< Static UI direction/electrical-role description.
};

/** @brief Optional RTC wiring; negative auxiliary GPIOs mean no connection. */
struct BoardRtc {
    const char* model;  ///< Static RTC component model.
    const char* i2cBusId;  ///< Identifier of the owning profile I2C bus.
    std::uint8_t address;  ///< Seven-bit I2C slave address.
    // -1 means the RTC pin is not connected to the ESP32.
    int interruptGpio;  ///< Interrupt GPIO, or -1 when not connected.
    int resetGpio;  ///< Reset GPIO, or -1 when not connected.
};

/** @brief Profile-selected nonvolatile memory technology. */
enum class BoardMemoryKind {
    Fram,  ///< Byte-writable F-RAM without a programming delay.
    Eeprom24lc512  ///< 24LC512 EEPROM with page writes and a bounded programming cycle.
};

/** @brief Optional byte-addressed I2C state memory fitted to the controller board. */
struct BoardStateMemory {
    BoardMemoryKind kind;  ///< Backend selected by the immutable board profile.
    const char* model;  ///< Static nonvolatile memory component model.
    const char* i2cBusId;  ///< Identifier of the owning profile I2C bus.
    std::uint8_t address;  ///< Seven-bit I2C slave address.
    std::size_t capacityBytes;  ///< Accessible byte count; transfers may not wrap.
    std::size_t pageSizeBytes;  ///< EEPROM write-page size; zero for F-RAM.
    std::uint32_t writeCycleTimeoutMs;  ///< EEPROM readiness deadline; zero for F-RAM.
};

/** @brief Complete immutable wiring/capability descriptor; all arrays have static lifetime. */
struct BoardProfile {
    const char* id;  ///< Stable canonical or bus identifier.
    const char* name;  ///< Static user-facing/profile channel name.
    const char* mcu;  ///< ESP-IDF target identifier.
    std::uint32_t flashBytes;  ///< Fitted flash capacity in bytes.
    std::uint32_t psramBytes;  ///< Fitted PSRAM capacity in bytes.
    BoardW5500 w5500;  ///< Ethernet wiring/timing descriptor.
    BoardRecoveryButton recoveryButton;  ///< Network-recovery input gesture.
    const BoardSafeBootGpio* safeBootGpios;  ///< Borrowed safe-start GPIO table.
    std::size_t safeBootGpioCount;  ///< Number of safe-start GPIO entries.
    const BoardI2cBus* i2cBuses;  ///< Borrowed named I2C bus table.
    std::size_t i2cBusCount;  ///< Number of I2C bus entries.
    const BoardMcp23017* expanders;  ///< Borrowed MCP23017 table.
    std::size_t expanderCount;  ///< Number of MCP23017 entries.
    int expanderResetGpio;  ///< Shared MCP reset GPIO, or -1 when reset is tied HIGH.
    std::uint32_t expanderResetMinUs;  ///< Minimum MCP reset assertion time in microseconds.
    bool expanderDriverImplemented;  ///< Whether MCP relay/input drivers are implemented.
    const BoardExpanderChannel* relays;  ///< Borrowed stable relay channel table.
    std::size_t relayCount;  ///< Number of relay channels.
    const BoardExpanderChannel* inputs;  ///< Borrowed stable input channel table.
    std::size_t inputCount;  ///< Number of input channels.
    const BoardLed* leds;  ///< Borrowed local LED table.
    std::size_t ledCount;  ///< Number of LED channels.
    bool ledDriverImplemented;  ///< Whether local LED control is implemented.
    const BoardSensorPort* sensorPorts;  ///< Borrowed local sensor-port table.
    std::size_t sensorPortCount;  ///< Number of sensor ports.
    std::optional<BoardRs485> rs485;  ///< Optional transceiver wiring.
    int usbVbusSenseGpio;  ///< USB service-port VBUS-sense input GPIO.
    const BoardNamedGpio* namedGpios;  ///< Borrowed diagnostic semantic-pin table.
    std::size_t namedGpioCount;  ///< Number of semantic-pin entries.
    std::optional<BoardRtc> rtc;  ///< Optional external RTC descriptor.
    std::optional<BoardStateMemory> stateMemory;  ///< Optional profile-selected state memory.
};

/** @brief Resolve a registered canonical board ID or explicitly listed legacy alias.
 * @param[in] id Borrowed requested identity.
 * @return Canonical process-lifetime view, or an empty view for an unknown identity.
 * @note Thread-safe, allocation-free and independent of activation.
 */
std::string_view board_profile_canonical_id(std::string_view id);

/** @brief Find immutable registry data for a canonical ID or known alias.
 * @param[in] id Borrowed requested identity.
 * @return Borrowed process-lifetime profile pointer, or nullptr. Thread-safe.
 */
const BoardProfile* board_profile_find(std::string_view id);

/** @brief Obtain the boot-active board, falling back to the default before activation.
 * @return Borrowed immutable process-lifetime profile reference. Thread-safe.
 */
const BoardProfile& board_profile_active();

/** @brief Select a board once before initializing profile-bound hardware.
 * @param[in] id Registered canonical ID or known legacy alias.
 * @return True for the first valid activation or the already-active profile; false otherwise.
 * @pre Startup call precedes all profile-bound drivers. Persisted changes take effect at reboot.
 * @note Atomic single assignment; a concurrent caller cannot switch the winning profile.
 */
bool board_profile_activate(std::string_view id);

/** @brief Build read-only identity, capability, driver and pin-map metadata.
 * @param[in] profile Borrowed immutable registered board descriptor.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on allocation failure.
 * @note Thread-safe; the profile and its referenced arrays must remain alive.
 */
cJSON* board_profile_json(const BoardProfile& profile);

/** @brief Build metadata for the active boot profile.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr. Thread-safe.
 */
cJSON* board_profile_status_json();

/** @brief List registered board metadata, including known legacy IDs.
 * @return Caller-owned JSON array for cJSON_Delete(), or nullptr. Thread-safe.
 */
cJSON* board_profiles_json();

/** @brief Build the diagnostic semantic GPIO table.
 * @param[in] profile Borrowed immutable board descriptor.
 * @return Caller-owned JSON array for cJSON_Delete(), or nullptr. Thread-safe.
 */
cJSON* board_profile_pin_map_json(const BoardProfile& profile);
