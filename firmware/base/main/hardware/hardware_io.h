/**
 * @file hardware_io.h
 * @brief Profile-based GPIO, MCP23017 and shared I2C services for FCPLCn.
 * @details Public calls serialize access internally. A controller may hold its
 * controller mutex before calling this module; this module never calls back into
 * an owner. RAM recovery intent, confirmed latch and electrical readback are
 * distinct. Only successful write/readback confirms ON; a failed OFF still
 * revokes recovery ON. Recovery policy does not change command deadline meaning.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

#include "esp_err.h"

struct cJSON;

/** @brief One cached channel observation; unavailable data is never assumed OFF. */
struct HardwareIoChannelState {
    bool valid = false;  ///< Configuration and readback passed verification.
    bool fresh = false;  ///< Valid observation is at most 300 ms old.
    bool value = false;  ///< Logical relay ON, or raw input HIGH.
    bool level = false;  ///< Raw electrical GPIO level, before polarity mapping.
    std::int64_t updatedAtUs = -1;  ///< Monotonic sample time in microseconds; -1 if unknown.
    std::uint32_t generation = 0;  ///< Epoch for loss, recovery and transparent repairs.
    esp_err_t error = ESP_ERR_INVALID_STATE;  ///< Driver, freshness or verification error.
};

/**
 * @brief Read a relay cache without an I2C transaction or JSON allocation.
 * @param id Profile relay name, for example rly-0/1.
 * @param[out] state Observation; inspect valid/fresh even when ESP_OK is returned.
 * @return ESP_OK for a known channel, or ESP_ERR_NOT_FOUND for an unknown name.
 */
esp_err_t hardware_io_read_relay(std::string_view id, HardwareIoChannelState& state);

/**
 * @brief Read an input cache and expire stale observations.
 * @param id Profile input name, for example in-0/1.
 * @param[out] state Raw HIGH/LOW observation with validity, age and generation.
 * @return ESP_OK for a known channel, or ESP_ERR_NOT_FOUND for an unknown name.
 */
esp_err_t hardware_io_read_input(std::string_view id, HardwareIoChannelState& state);

/**
 * @brief Initialize profile buses, safe pins, expanders and the sampling worker once.
 * @details Call after board activation/safe boot setup and before RTC services.
 * Missing peripherals remain invalid and are retried independently; cold boot
 * starts all relay intents OFF. The active hardware profile must remain immutable.
 * A RESET GPIO of -1 skips only the physical reset pulse; all MCP register and
 * profile pull-up checks still run before any relay/input is declared valid.
 */
void hardware_io_init();

/**
 * @brief Copy hardware diagnostics and serialize them outside the I2C mutex.
 * @return Owned cJSON object, or nullptr on allocation failure. Delete with cJSON_Delete.
 * @details Stale/invalid channel values are JSON null. Timestamps retain the last
 * successful observation; generation prevents repair from creating button edges.
 */
cJSON* hardware_io_status_json();

/**
 * @brief Request a logical relay state and verify physical write/readback.
 * @param id Profile relay name.
 * @param on Desired logical ON/OFF; electrical polarity comes from the profile.
 * @return ESP_OK only after confirmation; driver/verification error otherwise.
 * @details OFF revokes buffered ON even when I2C fails. Failed ON never queues a
 * later recovery command. Static intent survives MCP repair, not an ESP reboot.
 */
esp_err_t hardware_io_set_relay(std::string_view id, bool on);

/**
 * @brief Set a relay only within an absolute monotonic delivery window.
 * @param id Profile relay name.
 * @param on Desired logical state.
 * @param expiresAtUs Deadline in microseconds, checked under the hardware mutex
 * after the prerequisite read and immediately before OLAT is written.
 * @return ESP_OK on confirmation, ESP_ERR_TIMEOUT on expiry, or an I/O error.
 * @details This is command acceptance, not a lease. A rejected expired command
 * does not become recovery intent. I/O-failed OFF still cancels buffered ON.
 */
esp_err_t hardware_io_set_relay_until(std::string_view id, bool on, std::int64_t expiresAtUs);

/** @brief Permission to restore an ON intent after uncertainty or MCP repair. */
enum class HardwareRelayRecovery {
    Buffered,  ///< Restore the last confirmed RAM command, for static switches/manual outputs.
    Controller  ///< Revoke ON on fault/stale; an autonomous owner must validate a new ON.
};

/**
 * @brief Register recovery ownership without actuating the output.
 * @param id Profile relay name.
 * @param policy Buffered intent or fresh-controller-decision recovery.
 * @return ESP_OK, an unknown-name/argument error, or ESP_ERR_INVALID_STATE before initialization.
 * @details Register autonomous owners before they can energize outputs. An OFF
 * must precede release/reassignment. No owner callback is made under the I/O lock.
 */
esp_err_t hardware_io_set_relay_recovery(std::string_view id, HardwareRelayRecovery policy);

/**
 * @brief Set and read back a profile status LED.
 * @param id Profile LED name.
 * @param on Logical state, independent of active-low wiring.
 * @return ESP_OK on confirmation, or an unknown-name/GPIO error.
 */
esp_err_t hardware_io_set_led(std::string_view id, bool on);

/**
 * @brief Queue a bounded asynchronous scan of addresses 0x08..0x77 on all profile buses.
 * @details A running scan is not restarted. Work is interleaved with ordinary I/O,
 * and HTTP callers never wait for the full scan. Read results in the status JSON.
 */
void hardware_io_request_scan();

/**
 * @brief Read a peripheral register range using the shared serialized I2C bus.
 * @param busId Profile bus identifier.
 * @param address Seven-bit address 0x08..0x77.
 * @param reg First register; the transfer must not wrap past register 255.
 * @param[out] data Caller-owned buffer of at least length bytes.
 * @param length Transfer size, 1..128 bytes.
 * @return ESP_OK, argument/state error, or the bounded I2C transaction error.
 * @details No retries or owner callbacks occur here. RTC/peripheral services use
 * this adapter; callers must respect the target's register and ownership contracts.
 */
esp_err_t hardware_i2c_read(std::string_view busId,
                            std::uint8_t address,
                            std::uint8_t reg,
                            std::uint8_t* data,
                            std::size_t length);

/**
 * @brief Write a peripheral register range using the shared serialized I2C bus.
 * @param busId Profile bus identifier.
 * @param address Seven-bit address 0x08..0x77.
 * @param reg First register; the transfer must not wrap past register 255.
 * @param data Borrowed source buffer, retained only for this call.
 * @param length Transfer size, 1..128 bytes.
 * @return ESP_OK, argument/state error, or the bounded I2C transaction error.
 */
esp_err_t hardware_i2c_write(std::string_view busId,
                             std::uint8_t address,
                             std::uint8_t reg,
                             const std::uint8_t* data,
                             std::size_t length);

/**
 * @brief Send an address-only write-direction probe on a profile I2C bus.
 * @param busId Profile bus identifier.
 * @param address Seven-bit slave address 0x08..0x77.
 * @param timeoutMs Requested individual probe wait, 1..20 milliseconds.
 * @return ESP_OK for ACK, ESP_ERR_NOT_FOUND for NACK, or an argument/state/bus error.
 * @details The ESP-IDF wait is rounded up to at least one RTOS tick. Tick periods
 * above 20 ms are unsupported. Acquires the shared mutex for this transaction only. EEPROM
 * ACK polling must release it between probes; no retry is performed here.
 */
esp_err_t
hardware_i2c_probe(std::string_view busId, std::uint8_t address, std::uint32_t timeoutMs = 1);

/**
 * @brief Read one bounded transfer with a 16-bit big-endian memory address.
 * @param busId Profile bus identifier.
 * @param address Seven-bit slave address 0x08..0x77.
 * @param offset First byte address; the transfer cannot wrap past 65535.
 * @param[out] data Caller-owned destination of at least length bytes.
 * @param length Transfer size, 1..32 bytes.
 * @return ESP_OK, argument/state error, or a bounded I2C transaction error.
 * @details Uses the same hardware mutex as MCP/RTC operations; no retries occur.
 */
esp_err_t hardware_i2c_memory_read(std::string_view busId,
                                   std::uint8_t address,
                                   std::uint16_t offset,
                                   std::uint8_t* data,
                                   std::size_t length);

/**
 * @brief Write one bounded transfer with a 16-bit big-endian memory address.
 * @param busId Profile bus identifier.
 * @param address Seven-bit slave address 0x08..0x77.
 * @param offset First byte address; the transfer cannot wrap past 65535.
 * @param data Borrowed payload, retained only during this call.
 * @param length Transfer size, 1..32 bytes.
 * @return ESP_OK, argument/state error, or a bounded I2C transaction error.
 * @details Uses the shared hardware mutex. Success does not imply record atomicity.
 */
esp_err_t hardware_i2c_memory_write(std::string_view busId,
                                    std::uint8_t address,
                                    std::uint16_t offset,
                                    const std::uint8_t* data,
                                    std::size_t length);

#ifdef FCPLCN_HARDWARE_IO_TESTING
/** @brief Drive one worker iteration with host fake clock/bus adapters. */
void hardware_io_test_step();
#endif
