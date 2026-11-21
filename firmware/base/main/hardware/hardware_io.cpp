/**
 * @file hardware_io.cpp
 * @brief Verified MCP23017 I/O, bounded repair and profile GPIO/I2C services.
 * @details Desired recovery intent is distinct from the confirmed output latch
 * and GPIO readback. Responsive register drift is repaired once immediately;
 * absent/failing devices retry independently on a bounded cadence. Controller
 * ownership revokes ON before any fault repair, while Buffered outputs retain
 * their last confirmed RAM intent. No owner callback runs under the I/O mutex.
 */
#include "hardware/hardware_io.h"
#include "util/operation_context.h"

#include <array>
#include <memory>
#include <mutex>
#include <vector>

#include "hardware/board_profile.h"
#include "system/runtime_supervisor.h"
#include "cJSON.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {
constexpr char kTag[] = "fcplcn_io";
constexpr int kTransactionTimeoutMs = 20;
// Sample momentary buttons every 20 ms; the worker itself wakes every 10 ms.
constexpr std::int64_t kSampleIntervalUs = 20'000;
constexpr std::int64_t kRecoveryIntervalUs = 1'000'000;
constexpr std::int64_t kFreshnessUs = 300'000;
constexpr std::int64_t kScanLimitUs = 15'000'000;
constexpr std::size_t kMaxTransfer = 128;
constexpr std::size_t kMaxMemoryTransfer = 32;
constexpr std::uint8_t kFirstScanAddress = 0x08;
constexpr std::uint8_t kLastScanAddress = 0x77;
// MCP23017 DS20001952E, BANK=0 sequential register map.
constexpr std::uint8_t kIodir = 0x00;
constexpr std::uint8_t kIpol = 0x02;
constexpr std::uint8_t kGpinten = 0x04;
constexpr std::uint8_t kDefval = 0x06;
constexpr std::uint8_t kIntcon = 0x08;
constexpr std::uint8_t kIocon = 0x0a;
constexpr std::uint8_t kGppu = 0x0c;
constexpr std::uint8_t kGpio = 0x12;
constexpr std::uint8_t kOlat = 0x14;

struct BusState {
    const BoardI2cBus* profile = nullptr;
    i2c_master_bus_handle_t handle = nullptr;
    std::array<i2c_master_dev_handle_t, 128> devices{};
    bool ready = false;
    bool scanning = false;
    std::uint8_t nextAddress = kFirstScanAddress;
    std::int64_t deadlineUs = 0;
    std::int64_t updatedUs = -1;
    esp_err_t error = ESP_ERR_INVALID_STATE;
    std::vector<std::uint8_t> addresses;
};

/**
 * @brief Independent MCP cache, recovery intent and uncertainty epoch.
 * @details desired is the last accepted RAM target, latch is confirmed OLAT and
 * gpio is readback. Invalid reads never replace desired. controllerMask identifies
 * outputs whose ON must be revoked before repair; safeOff handles profile polarity.
 */
struct ExpanderState {
    const BoardMcp23017* profile = nullptr;
    bool valid = false;
    std::uint16_t latch = 0;
    std::uint16_t desired = 0;
    std::uint16_t safeOff = 0;
    std::uint16_t controllerMask = 0;
    std::uint16_t gpio = 0;
    std::int64_t updatedUs = -1;
    std::int64_t lastAttemptUs = -1;
    esp_err_t error = ESP_ERR_INVALID_STATE;
    std::uint32_t generation = 0;
    bool repairNow = false;
};

struct GpioState {
    bool ready = false;
    bool on = false;
    esp_err_t error = ESP_ERR_INVALID_STATE;
};

std::mutex state_mutex;
bool initialized = false;
bool reset_ready = false;
esp_err_t worker_error = ESP_OK;
std::vector<BusState> buses;
std::vector<ExpanderState> expanders;
std::vector<GpioState> leds;
std::vector<GpioState> sensors;
std::size_t scan_bus = 0;

using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

/**
 * @brief Find the initialized bus state corresponding to a profile bus name.
 * @param[in] id Borrowed semantic I2C bus identifier.
 * @return Borrowed bus entry, or nullptr when no profile bus matches.
 * @pre Hold state_mutex when bus state may be accessed concurrently.
 */
BusState* find_bus(std::string_view id)
{
    for (auto& bus : buses)
        if (id == bus.profile->id)
            return &bus;
    return nullptr;
}

/**
 * @brief Check address, buffer and register-window bounds before an I2C transfer.
 * @param[in] address Seven-bit nonreserved slave address.
 * @param[in] reg Starting register within the one-byte register space.
 * @param[in] data Borrowed buffer address; this check never dereferences it.
 * @param[in] length Requested byte count, limited to kMaxTransfer.
 * @return True for a nonnull, nonempty transfer that cannot wrap the register index.
 */
bool valid_transfer(std::uint8_t address, std::uint8_t reg, const void* data, std::size_t length)
{
    return address >= kFirstScanAddress && address <= kLastScanAddress && data != nullptr
           && length != 0 && length <= kMaxTransfer && length <= 256U - reg;
}

/**
 * @brief Reject malformed or wrapping 16-bit memory transactions before touching the bus.
 * @param address Seven-bit nonreserved slave address.
 * @param offset First memory byte address.
 * @param data Borrowed buffer address; not dereferenced during validation.
 * @param length Requested byte count, limited to kMaxMemoryTransfer.
 * @return True for a nonempty bounded transfer within the 16-bit address space.
 */
bool valid_memory_transfer(std::uint8_t address,
                           std::uint16_t offset,
                           const void* data,
                           std::size_t length)
{
    return address >= kFirstScanAddress && address <= kLastScanAddress && data != nullptr
           && length != 0 && length <= kMaxMemoryTransfer && length <= 65536U - offset;
}

/**
 * @brief Reuse or lazily register a device handle on a ready profile I2C bus.
 * @param[in,out] bus Bus state whose per-address handle cache may be extended.
 * @param[in] address Validated seven-bit address and cache index.
 * @param[out] device Borrowed cached/new handle on success.
 * @return ESP_OK, INVALID_STATE for an unavailable bus, or an IDF allocation/configuration error.
 * @pre Hold state_mutex; address must index the 128-entry device cache.
 */
esp_err_t device_for(BusState& bus, std::uint8_t address, i2c_master_dev_handle_t& device)
{
    if (!bus.ready || bus.handle == nullptr)
        return ESP_ERR_INVALID_STATE;
    device = bus.devices[address];
    if (device != nullptr)
        return ESP_OK;
    i2c_device_config_t config{};
    config.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    config.device_address = address;
    config.scl_speed_hz = bus.profile->initialClockHz != 0 ? bus.profile->initialClockHz : 100000;
    const esp_err_t error = i2c_master_bus_add_device(bus.handle, &config, &device);
    if (error == ESP_OK)
        bus.devices[address] = device;
    return error;
}

/**
 * @brief Perform one bounded combined register-address write and I2C read.
 * @param[in,out] bus Ready bus and its lazily populated device cache.
 * @param[in] address Validated seven-bit slave address.
 * @param[in] reg First register to read.
 * @param[out] data Borrowed writable buffer of at least length bytes.
 * @param[in] length Validated byte count.
 * @return ESP_OK or the device-registration/transaction error.
 * @pre Hold state_mutex and validate transfer bounds before calling.
 */
esp_err_t read_locked(
    BusState& bus, std::uint8_t address, std::uint8_t reg, std::uint8_t* data, std::size_t length)
{
    i2c_master_dev_handle_t device = nullptr;
    const esp_err_t error = device_for(bus, address, device);
    if (error != ESP_OK)
        return error;
    return i2c_master_transmit_receive(device, &reg, 1, data, length, kTransactionTimeoutMs);
}

/**
 * @brief Prefix a bounded payload with its register address and transmit it.
 * @param[in,out] bus Ready bus and its device-handle cache.
 * @param[in] address Validated seven-bit slave address.
 * @param[in] reg First register to write.
 * @param[in] data Borrowed readable payload of at least length bytes.
 * @param[in] length Validated byte count no larger than kMaxTransfer.
 * @return ESP_OK or the device-registration/transaction error.
 * @pre Hold state_mutex and validate transfer bounds before calling.
 */
esp_err_t write_locked(BusState& bus,
                       std::uint8_t address,
                       std::uint8_t reg,
                       const std::uint8_t* data,
                       std::size_t length)
{
    i2c_master_dev_handle_t device = nullptr;
    const esp_err_t error = device_for(bus, address, device);
    if (error != ESP_OK)
        return error;
    std::array<std::uint8_t, kMaxTransfer + 1> bytes{};
    bytes[0] = reg;
    for (std::size_t i = 0; i < length; ++i)
        bytes[i + 1] = data[i];
    return i2c_master_transmit(device, bytes.data(), length + 1, kTransactionTimeoutMs);
}

/**
 * @brief Write a little-endian MCP23017 register pair in BANK=0 sequential mode.
 * @param[in,out] bus Serialized profile bus and handle cache.
 * @param[in] address Expander slave address.
 * @param[in] reg Low-byte register address followed by its high-byte register.
 * @param[in] word Complete A/B register value.
 * @return ESP_OK or the bounded I2C transaction error.
 * @pre Hold state_mutex; BANK/SEQOP normalization has already been verified.
 */
esp_err_t write_word(BusState& bus, std::uint8_t address, std::uint8_t reg, std::uint16_t word)
{
    const std::uint8_t bytes[] = {static_cast<std::uint8_t>(word),
                                  static_cast<std::uint8_t>(word >> 8)};
    return write_locked(bus, address, reg, bytes, sizeof(bytes));
}

/**
 * @brief Decode one little-endian A/B pair from the MCP23017 register image.
 * @param[in] bytes Complete sequential BANK=0 image through OLATB.
 * @param[in] reg Low-byte offset; reg + 1 must be inside bytes.
 * @return Combined sixteen-bit register value.
 */
std::uint16_t word_at(const std::array<std::uint8_t, 22>& bytes, std::uint8_t reg)
{
    return static_cast<std::uint16_t>(bytes[reg]
                                      | (static_cast<std::uint16_t>(bytes[reg + 1]) << 8));
}

/**
 * @brief Derive the electrical relay-OFF latch from the active board polarity map.
 * @param[in] expander_index Index of the expander in the active profile.
 * @return Bitmask with active-low relay bits HIGH and all other bits LOW.
 * @note Pure profile lookup; it neither changes RAM intent nor writes hardware.
 */
std::uint16_t off_latch(std::size_t expander_index)
{
    const auto& board = board_profile_active();
    std::uint16_t off = 0;
    for (std::size_t i = 0; i < board.relayCount; ++i) {
        const auto& relay = board.relays[i];
        if (relay.expanderIndex == expander_index && !relay.activeHigh && relay.pin < 16) {
            off |= static_cast<std::uint16_t>(1U << relay.pin);
        }
    }
    return off;
}

/**
 * @brief Mark observations unknown and revoke protected ON intent before any repair.
 * @param[in,out] expander Observation, recovery target and uncertainty generation to invalidate.
 * @param[in] error Transport/verification/freshness error retained for diagnostics.
 * @pre Hold state_mutex.
 * @details This operation is RAM-only. Static Buffered intent survives; Controller
 * bits become profile OFF even when a later I2C write cannot yet reach the chip.
 * Epoch changes make a transparent repair visible to input/button consumers.
 */
void invalidate(ExpanderState& expander, esp_err_t error)
{
    if (expander.valid)
        ++expander.generation;
    expander.desired = static_cast<std::uint16_t>((expander.desired & ~expander.controllerMask)
                                                  | (expander.safeOff & expander.controllerMask));
    expander.valid = false;
    expander.error = error;
    expander.lastAttemptUs = esp_timer_get_time();
}

/**
 * @brief Invalidate stale or time-inconsistent observations and request immediate repair.
 * @param[in,out] expander Cached observation and protected recovery intent.
 * @param[in] now Current monotonic ESP timer value in microseconds.
 * @pre Hold state_mutex. Invalidating also revokes Controller-owned ON intent.
 */
void expire_cached(ExpanderState& expander, std::int64_t now)
{
    if (expander.valid
        && (expander.updatedUs < 0 || now < expander.updatedUs
            || now - expander.updatedUs > kFreshnessUs)) {
        invalidate(expander, ESP_ERR_TIMEOUT);
        expander.repairNow = true;
    }
}

// Read GPIO, OLAT and configuration together. A reset/configuration drift must
// invalidate even an all-OFF expander: merely reading GPIO cannot detect this.
/**
 * @brief Verify directions, polarity, interrupts, pull-ups, OLAT and output GPIO together.
 * @param[in,out] expander Profile binding and confirmed cache updated only after complete
 * verification.
 * @param[in] expected_latch Previously accepted OFF/desired latch; never inferred from the chip.
 * @return ESP_OK for a verified image, INVALID_RESPONSE for drift, or an I2C/state error.
 * @pre Hold state_mutex.
 * @details GPIO alone cannot prove the profile survived a reset. A complete,
 * consistent BANK=0 register image is required before publishing any fresh input
 * or confirmed relay value. The expected latch is never learned from corrupt I/O.
 */
esp_err_t read_expander(ExpanderState& expander, std::uint16_t expected_latch)
{
    auto* bus = find_bus(expander.profile->i2cBusId);
    if (bus == nullptr)
        return ESP_ERR_INVALID_STATE;
    std::array<std::uint8_t, 22> bytes{};
    const auto& profile = *expander.profile;
    esp_err_t error = read_locked(*bus, profile.address, 0, bytes.data(), bytes.size());
    if (error != ESP_OK)
        return error;
    const auto expected_direction = static_cast<std::uint16_t>(~profile.relayMask);
    const auto gpio = word_at(bytes, kGpio);
    if (word_at(bytes, kIodir) != expected_direction || word_at(bytes, kIpol) != 0
        || word_at(bytes, kGpinten) != 0 || word_at(bytes, kDefval) != 0
        || word_at(bytes, kIntcon) != 0 || bytes[kIocon] != 0 || bytes[kIocon + 1] != 0
        || word_at(bytes, kGppu) != profile.inputPullupMask
        || word_at(bytes, kOlat) != expected_latch
        || (gpio & profile.relayMask) != (expected_latch & profile.relayMask)) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    if (!expander.valid)
        ++expander.generation;
    expander.gpio = gpio;
    expander.latch = expected_latch;
    expander.valid = true;
    expander.error = ESP_OK;
    expander.updatedUs = esp_timer_get_time();
    return ESP_OK;
}

/**
 * @brief Perform one bounded profile repair before restoring permitted RAM intent.
 * @param[in] index Valid entry index in the initialized expanders vector.
 * @return ESP_OK after profile/intent readback, or the first state/I2C/verification error.
 * @pre Hold state_mutex; a fitted shared reset must have been successfully released.
 * @details Single-byte BANK/SEQOP normalization is verified before paired writes.
 * OLAT is OFF before output direction is restored; the OFF profile is read back
 * before Buffered desired bits are applied. Controller ON has already been revoked.
 * No temporary all-input IODIR stage is used because the board uses GPA7/GPB7.
 */
esp_err_t initialize_expander(std::size_t index)
{
    auto& expander = expanders[index];
    if (expander.valid)
        invalidate(expander, ESP_ERR_INVALID_STATE);
    if (!reset_ready)
        return ESP_ERR_INVALID_STATE;
    if ((expander.profile->inputPullupMask & ~expander.profile->inputMask) != 0
        || (expander.profile->inputMask & expander.profile->relayMask) != 0)
        return ESP_ERR_INVALID_ARG;
    auto* bus = find_bus(expander.profile->i2cBusId);
    if (bus == nullptr)
        return ESP_ERR_INVALID_STATE;
    const auto address = expander.profile->address;
    // Address 0x05 is IOCON in BANK=1 or GPINTENB in BANK=0. Writing zero
    // safely establishes BANK=0 even after unexpected register corruption.
    const std::uint8_t zero = 0;
    esp_err_t error = write_locked(*bus, address, 0x05, &zero, 1);
    if (error != ESP_OK)
        return error;
    if ((error = write_locked(*bus, address, kIocon, &zero, 1)) != ESP_OK)
        return error;
    // Single-byte probes do not depend on SEQOP. At BANK=1, address 0x05 is
    // IOCON and cannot read zero while BANK remains set; 0x0A alone is OLATA.
    for (const auto reg : {std::uint8_t{0x05}, kIocon, std::uint8_t{kIocon + 1}}) {
        std::uint8_t value = 0xff;
        if ((error = read_locked(*bus, address, reg, &value, 1)) != ESP_OK)
            return error;
        if (value != 0)
            return ESP_ERR_INVALID_RESPONSE;
    }
    const auto off = expander.safeOff;
    // Keep relay latches OFF before enabling any output direction.
    if ((error = write_word(*bus, address, kOlat, off)) != ESP_OK)
        return error;
    if ((error = write_word(*bus, address, kIpol, 0)) != ESP_OK)
        return error;
    if ((error = write_word(*bus, address, kGpinten, 0)) != ESP_OK)
        return error;
    if ((error = write_word(*bus, address, kDefval, 0)) != ESP_OK)
        return error;
    if ((error = write_word(*bus, address, kIntcon, 0)) != ESP_OK)
        return error;
    // Modern TLP2363 inputs use external pull-ups; legacy open collectors require
    // the profile's internal pull-ups. Neither policy may enable pulls on relays.
    if ((error = write_word(*bus, address, kGppu, expander.profile->inputPullupMask)) != ESP_OK)
        return error;
    if ((error = write_word(
             *bus, address, kIodir, static_cast<std::uint16_t>(~expander.profile->relayMask)))
        != ESP_OK)
        return error;
    if ((error = read_expander(expander, off)) != ESP_OK)
        return error;
    // Never adopt a reset/corrupt latch as the new desired buffer. Static relay
    // commands survive MCP resets; autonomous owners have revoked ON above.
    if (expander.desired == off)
        return ESP_OK;
    if ((error = write_word(*bus, address, kOlat, expander.desired)) != ESP_OK)
        return error;
    return read_expander(expander, expander.desired);
}

/**
 * @brief Preload a safe output level before enabling the requested GPIO direction.
 * @param[in] gpio ESP GPIO number in the supported bitmask range.
 * @param[in] mode Required input/output/open-drain mode.
 * @param[in] high Initial electrical level, written before the direction changes.
 * @return ESP_OK, INVALID_ARG for an invalid number, or a GPIO driver error.
 * @note Internal pulls and GPIO interrupts are disabled.
 */
esp_err_t configure_gpio(int gpio, gpio_mode_t mode, bool high)
{
    if (gpio < 0 || gpio >= 64)
        return ESP_ERR_INVALID_ARG;
    esp_err_t error = gpio_set_level(static_cast<gpio_num_t>(gpio), high);
    if (error != ESP_OK)
        return error;
    gpio_config_t config{};
    config.pin_bit_mask = 1ULL << gpio;
    config.mode = mode;
    config.pull_up_en = GPIO_PULLUP_DISABLE;
    config.pull_down_en = GPIO_PULLDOWN_DISABLE;
    config.intr_type = GPIO_INTR_DISABLE;
    return gpio_config(&config);
}

/**
 * @brief Probe at most one queued I2C address while rotating fairly across buses.
 * @param[in] now Monotonic microseconds used to enforce each scan deadline.
 * @note Acquires state_mutex for one bounded probe only; callers must not hold it.
 */
void scan_step(std::int64_t now)
{
    // At most one address per iteration, with the shared lock released between
    // addresses. Relay writes, RTC accesses and sampling can interleave freely.
    std::lock_guard<std::mutex> lock(state_mutex);
    for (std::size_t count = 0; count < buses.size(); ++count) {
        const std::size_t index = scan_bus++ % buses.size();
        auto& bus = buses[index];
        if (!bus.scanning)
            continue;
        if (!bus.ready || now >= bus.deadlineUs) {
            bus.error = bus.ready ? ESP_ERR_TIMEOUT : ESP_ERR_INVALID_STATE;
            bus.scanning = false;
            bus.updatedUs = now;
            return;
        }
        const std::uint8_t address = bus.nextAddress++;
        const esp_err_t error = i2c_master_probe(bus.handle, address, kTransactionTimeoutMs);
        if (error == ESP_OK)
            bus.addresses.push_back(address);
        else if (error != ESP_ERR_NOT_FOUND)
            bus.error = error;
        if (address == kLastScanAddress) {
            bus.scanning = false;
            bus.updatedUs = esp_timer_get_time();
        }
        return;
    }
}

/**
 * @brief Sample independent expanders and interleave a bounded asynchronous scan.
 * @details Responsive register drift gets one immediate repair attempt; failed
 * repairs fall back to one-second retries. Locks are released between expanders
 * and scan addresses, preserving relay/RTC access without owner callbacks.
 */
void worker_step()
{
    for (std::size_t i = 0; i < expanders.size(); ++i) {
        std::lock_guard<std::mutex> lock(state_mutex);
        auto& expander = expanders[i];
        const auto now = esp_timer_get_time();
        expire_cached(expander, now);
        const auto interval = expander.valid ? kSampleIntervalUs : kRecoveryIntervalUs;
        if (!expander.repairNow && expander.lastAttemptUs >= 0
            && now - expander.lastAttemptUs < interval)
            continue;
        expander.lastAttemptUs = now;
        expander.repairNow = false;
        const bool was_valid = expander.valid;
        const esp_err_t error =
            was_valid ? read_expander(expander, expander.latch) : initialize_expander(i);
        if (error != ESP_OK) {
            invalidate(expander, error);
            if (was_valid && error == ESP_ERR_INVALID_RESPONSE) {
                // Responsive chip with changed registers: one immediate bounded
                // repair. Failed repairs fall back to the one-second cadence.
                const auto repair = initialize_expander(i);
                if (repair != ESP_OK)
                    invalidate(expander, repair);
            }
            expander.repairNow = false;
        }
    }
    scan_step(esp_timer_get_time());
}

/**
 * @brief Run expander health/recovery and scan work from the dedicated I/O task.
 * @note The unused FreeRTOS argument is ignored; this task never returns and yields every 10 ms.
 */
void worker(void*)
{
    const auto watchdog = runtime_task_start(RuntimeTask::Io);
    if (watchdog != ESP_OK)
        ESP_LOGW(kTag,
                 "I/O task watchdog unavailable: %s; progress monitor retained",
                 esp_err_to_name(watchdog));
    while (true) {
        worker_step();
        runtime_task_heartbeat();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

/**
 * @brief Add a nullable hardware diagnostic without exposing a false success string.
 * @param[in,out] object Borrowed JSON object receiving the error field.
 * @param[in] error ESP_OK emits null; other codes emit their IDF symbolic name.
 * @return True when cJSON allocated and attached the field.
 */
bool add_error(cJSON* object, esp_err_t error)
{
    return error == ESP_OK
               ? cJSON_AddNullToObject(object, "error") != nullptr
               : cJSON_AddStringToObject(object, "error", esp_err_to_name(error)) != nullptr;
}

/**
 * @brief Add a sample timestamp in milliseconds or null when no sample exists.
 * @param[in,out] object Borrowed JSON object receiving updatedAtMs.
 * @param[in] updated Monotonic sample time in microseconds; negative means unknown.
 * @return True when the JSON field was allocated and attached.
 */
bool add_time(cJSON* object, std::int64_t updated)
{
    return updated < 0
               ? cJSON_AddNullToObject(object, "updatedAtMs") != nullptr
               : cJSON_AddNumberToObject(object, "updatedAtMs", updated / 1000.0) != nullptr;
}

/**
 * @brief Serialize a boolean observation as null whenever its hardware state is unknown.
 * @param[in,out] object Borrowed JSON object receiving the field.
 * @param[in] name Borrowed null-terminated JSON field name.
 * @param[in] valid Whether the supplied observation is trustworthy.
 * @param[in] value Boolean observation used only when valid.
 * @return True when the JSON field was allocated and attached.
 */
bool add_value(cJSON* object, const char* name, bool valid, bool value)
{
    return valid ? cJSON_AddBoolToObject(object, name, value) != nullptr
                 : cJSON_AddNullToObject(object, name) != nullptr;
}

/**
 * @brief Serialize relay/input channels from one coherent expander snapshot.
 * @param[in,out] root Borrowed JSON root receiving the named channel array.
 * @param[in] name Borrowed array-field name.
 * @param[in] channels Profile descriptors with stable names, polarity and expander bindings.
 * @param[in] count Number of descriptors readable from channels.
 * @param[in] relay True emits logical relay values; false emits raw digital input levels.
 * @param[in] snapshot Owned expander snapshot, read without the hardware mutex.
 * @return True for a complete array; false for allocation failure or invalid profile indices.
 * @note Unknown observations are null, while their diagnostics and polarity remain visible.
 */
bool add_channels(cJSON* root,
                  const char* name,
                  const BoardExpanderChannel* channels,
                  std::size_t count,
                  bool relay,
                  const std::vector<ExpanderState>& snapshot)
{
    auto* array = cJSON_AddArrayToObject(root, name);
    if (array == nullptr)
        return false;
    for (std::size_t i = 0; i < count; ++i) {
        const auto& channel = channels[i];
        Json item(cJSON_CreateObject(), cJSON_Delete);
        if (!item || channel.expanderIndex >= snapshot.size() || channel.pin >= 16)
            return false;
        const auto& state = snapshot[channel.expanderIndex];
        const bool level = (state.gpio & (1U << channel.pin)) != 0;
        const bool active = level == channel.activeHigh;
        if (!cJSON_AddStringToObject(item.get(), "id", channel.name)
            || !cJSON_AddBoolToObject(item.get(), "valid", state.valid)
            || !cJSON_AddBoolToObject(item.get(), "activeHigh", channel.activeHigh)
            || !add_value(item.get(), "value", state.valid, relay ? active : level)
            || !add_value(item.get(), "level", state.valid, level)
            || !add_value(item.get(), "active", state.valid, active)
            || !cJSON_AddStringToObject(item.get(), "expander", state.profile->reference)
            || !cJSON_AddNumberToObject(item.get(), "address", state.profile->address)
            || !cJSON_AddNumberToObject(item.get(), "pin", channel.pin)
            || !add_error(item.get(), state.error) || !add_time(item.get(), state.updatedUs)
            || !cJSON_AddItemToArray(array, item.get()))
            return false;
        item.release();
    }
    return true;
}

/**
 * @brief Copy a named input/relay observation after expiring stale cache state.
 * @param[in] id Borrowed semantic channel identifier.
 * @param[in] relay Select relay descriptors rather than input descriptors.
 * @param[out] result Reset and populated observation with validity, freshness and generation.
 * @return ESP_OK for a known channel even if unavailable, or ESP_ERR_NOT_FOUND.
 * @note Acquires state_mutex; no I2C transaction or flash write is performed.
 */
esp_err_t read_channel(std::string_view id, bool relay, HardwareIoChannelState& result)
{
    result = HardwareIoChannelState{};
    std::lock_guard<std::mutex> lock(state_mutex);
    const auto& board = board_profile_active();
    const auto* channels = relay ? board.relays : board.inputs;
    const auto count = relay ? board.relayCount : board.inputCount;
    for (std::size_t i = 0; i < count; ++i) {
        const auto& channel = channels[i];
        if (id != channel.name)
            continue;
        if (!initialized || channel.expanderIndex >= expanders.size() || channel.pin >= 16)
            return ESP_OK;
        auto& expander = expanders[channel.expanderIndex];
        const auto now = esp_timer_get_time();
        expire_cached(expander, now);
        result.valid = expander.valid && worker_error == ESP_OK;
        result.updatedAtUs = expander.updatedUs;
        result.generation = expander.generation;
        result.fresh = result.valid && result.updatedAtUs >= 0 && now >= result.updatedAtUs
                       && now - result.updatedAtUs <= kFreshnessUs;
        result.level = (expander.gpio & (1U << channel.pin)) != 0;
        result.value = relay ? result.level == channel.activeHigh : result.level;
        result.error = worker_error != ESP_OK ? worker_error
                       : !result.valid        ? expander.error
                       : !result.fresh        ? ESP_ERR_TIMEOUT
                                              : ESP_OK;
        return ESP_OK;
    }
    result.error = ESP_ERR_NOT_FOUND;
    return ESP_ERR_NOT_FOUND;
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read a relay cache without an I2C transaction or JSON allocation.
 * @param id Profile relay name, for example rly-0/1.
 * @param[out] state Observation; inspect valid/fresh even when ESP_OK is returned.
 * @return ESP_OK for a known channel, or ESP_ERR_NOT_FOUND for an unknown name.
 * @endcond
 */
esp_err_t hardware_io_read_relay(std::string_view id, HardwareIoChannelState& state)
{
    return read_channel(id, true, state);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read an input cache and expire stale observations.
 * @param id Profile input name, for example in-0/1.
 * @param[out] state Raw HIGH/LOW observation with validity, age and generation.
 * @return ESP_OK for a known channel, or ESP_ERR_NOT_FOUND for an unknown name.
 * @endcond
 */
esp_err_t hardware_io_read_input(std::string_view id, HardwareIoChannelState& state)
{
    return read_channel(id, false, state);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Initialize profile buses, safe pins, expanders and the sampling worker once.
 * @details Call after board activation/safe boot setup and before RTC services.
 * Missing peripherals remain invalid and are retried independently; cold boot
 * starts all relay intents OFF. The active hardware profile must remain immutable.
 * @endcond
 */
void hardware_io_init()
{
    {
        std::lock_guard<std::mutex> lock(state_mutex);
        if (initialized)
            return;
        initialized = true;
        const auto& board = board_profile_active();
        buses.resize(board.i2cBusCount);
        expanders.resize(board.expanderCount);
        leds.resize(board.ledCount);
        sensors.resize(board.sensorPortCount);
        for (std::size_t i = 0; i < board.i2cBusCount; ++i) {
            auto& bus = buses[i];
            bus.profile = &board.i2cBuses[i];
            bus.addresses.reserve(kLastScanAddress - kFirstScanAddress + 1);
            i2c_master_bus_config_t config{};
            config.i2c_port = -1;
            config.sda_io_num = static_cast<gpio_num_t>(bus.profile->sdaGpio);
            config.scl_io_num = static_cast<gpio_num_t>(bus.profile->sclGpio);
            config.clk_source = I2C_CLK_SRC_DEFAULT;
            config.glitch_ignore_cnt = 7;
            config.flags.enable_internal_pullup = false;  // Both PCB buses have external pull-ups.
            bus.error = i2c_new_master_bus(&config, &bus.handle);
            if (bus.error == ESP_OK) {
                // One bounded driver recovery after CPU reset, not a scan/retry loop.
                bus.error = i2c_master_bus_reset(bus.handle);
                bus.ready = bus.error == ESP_OK;
            }
            if (!bus.ready)
                ESP_LOGW(kTag, "I2C %s: %s", bus.profile->id, esp_err_to_name(bus.error));
        }
        // -1 means RESET is held HIGH by the PCB, not an ESP-controlled signal.
        // Skip only its electrical pulse: full register normalization, safe OFF,
        // pull-up policy and readback are still mandatory for every MCP below.
        esp_err_t reset_error = ESP_OK;
        if (board.expanderResetGpio != -1) {
            const auto reset_gpio = static_cast<gpio_num_t>(board.expanderResetGpio);
            reset_error = configure_gpio(board.expanderResetGpio, GPIO_MODE_OUTPUT, false);
            if (reset_error == ESP_OK) {
                esp_rom_delay_us(board.expanderResetMinUs < 100 ? 100 : board.expanderResetMinUs);
                reset_error = gpio_set_level(reset_gpio, 1);
                if (reset_error == ESP_OK)
                    esp_rom_delay_us(1);
            }
        }
        reset_ready = reset_error == ESP_OK;
        for (std::size_t i = 0; i < board.expanderCount; ++i) {
            auto& expander = expanders[i];
            expander.profile = &board.expanders[i];
            expander.safeOff = off_latch(i);
            expander.desired = expander.safeOff;
            expander.lastAttemptUs = esp_timer_get_time();
            const esp_err_t error = reset_ready ? initialize_expander(i) : reset_error;
            if (error != ESP_OK) {
                invalidate(expander, error);
                ESP_LOGW(kTag,
                         "MCP %s 0x%02x: %s",
                         expander.profile->reference,
                         expander.profile->address,
                         esp_err_to_name(error));
            }
        }
        for (std::size_t i = 0; i < board.ledCount; ++i) {
            auto& state = leds[i];
            state.error =
                configure_gpio(board.leds[i].gpio, GPIO_MODE_INPUT_OUTPUT, board.leds[i].activeLow);
            state.ready = state.error == ESP_OK;
        }
        for (std::size_t i = 0; i < board.sensorPortCount; ++i) {
            auto& state = sensors[i];
            const auto mode = board.sensorPorts[i].openDrainRequired ? GPIO_MODE_INPUT_OUTPUT_OD
                                                                     : GPIO_MODE_INPUT;
            state.error = configure_gpio(board.sensorPorts[i].gpio, mode, true);
            state.ready = state.error == ESP_OK;
        }
        if (board.rs485.has_value()) {
            // Safe electrical idle only; no UART/fieldbus protocol is started.
            const auto& rs485 = *board.rs485;
            esp_err_t error = configure_gpio(rs485.directionGpio, GPIO_MODE_OUTPUT, false);
            if (error == ESP_OK)
                error = configure_gpio(rs485.txGpio, GPIO_MODE_OUTPUT, true);
            if (error == ESP_OK)
                error = configure_gpio(rs485.rxGpio, GPIO_MODE_INPUT, false);
            if (error != ESP_OK)
                ESP_LOGW(kTag, "RS485 safe idle: %s", esp_err_to_name(error));
        }
    }
    if (xTaskCreate(worker, "fcplcn_io", 4096, nullptr, 4, nullptr) != pdPASS) {
        std::lock_guard<std::mutex> lock(state_mutex);
        worker_error = ESP_ERR_NO_MEM;
        // Without sampling, previously read inputs must not be presented as live.
        for (auto& expander : expanders)
            invalidate(expander, worker_error);
        ESP_LOGE(kTag, "Cannot start hardware I/O worker");
    }
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read a peripheral register range using the shared serialized I2C bus.
 * @param busId Profile bus identifier.
 * @param address Seven-bit address 0x08..0x77.
 * @param reg First register; the transfer must not wrap past register 255.
 * @param[out] data Caller-owned buffer of at least length bytes.
 * @param length Transfer size, 1..128 bytes.
 * @return ESP_OK, argument/state error, or the bounded I2C transaction error.
 * @details No retries or owner callbacks occur here. RTC/peripheral services use
 * this adapter; callers must respect the target's register and ownership contracts.
 * @endcond
 */
esp_err_t hardware_i2c_read(std::string_view busId,
                            std::uint8_t address,
                            std::uint8_t reg,
                            std::uint8_t* data,
                            std::size_t length)
{
    if (!valid_transfer(address, reg, data, length))
        return ESP_ERR_INVALID_ARG;
    std::lock_guard<std::mutex> lock(state_mutex);
    auto* bus = find_bus(busId);
    if (bus == nullptr)
        return ESP_ERR_INVALID_STATE;
    return read_locked(*bus, address, reg, data, length);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Write a peripheral register range using the shared serialized I2C bus.
 * @param busId Profile bus identifier.
 * @param address Seven-bit address 0x08..0x77.
 * @param reg First register; the transfer must not wrap past register 255.
 * @param data Borrowed source buffer, retained only for this call.
 * @param length Transfer size, 1..128 bytes.
 * @return ESP_OK, argument/state error, or the bounded I2C transaction error.
 * @endcond
 */
esp_err_t hardware_i2c_write(std::string_view busId,
                             std::uint8_t address,
                             std::uint8_t reg,
                             const std::uint8_t* data,
                             std::size_t length)
{
    if (!valid_transfer(address, reg, data, length))
        return ESP_ERR_INVALID_ARG;
    std::lock_guard<std::mutex> lock(state_mutex);
    auto* bus = find_bus(busId);
    if (bus == nullptr)
        return ESP_ERR_INVALID_STATE;
    return write_locked(*bus, address, reg, data, length);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Send one address-only write-direction probe under the shared hardware lock.
 * @param busId Profile bus identifier.
 * @param address Seven-bit slave address 0x08..0x77.
 * @param timeoutMs Requested individual transaction wait, 1..20 milliseconds.
 * @return ESP_OK for ACK, ESP_ERR_NOT_FOUND for NACK, or an argument/state/bus error.
 * @endcond
 */
esp_err_t hardware_i2c_probe(std::string_view busId, std::uint8_t address, std::uint32_t timeoutMs)
{
    if (address < kFirstScanAddress || address > kLastScanAddress || timeoutMs == 0
        || timeoutMs > static_cast<std::uint32_t>(kTransactionTimeoutMs))
        return ESP_ERR_INVALID_ARG;
    // ESP-IDF converts this wait with pdMS_TO_TICKS before awaiting the ISR.
    // A sub-tick wait becomes zero and can report timeout before an ordinary ACK.
    auto effective_timeout = timeoutMs;
    while (pdMS_TO_TICKS(effective_timeout) == 0
           && effective_timeout < static_cast<std::uint32_t>(kTransactionTimeoutMs))
        ++effective_timeout;
    if (pdMS_TO_TICKS(effective_timeout) == 0)
        return ESP_ERR_NOT_SUPPORTED;
    std::lock_guard<std::mutex> lock(state_mutex);
    auto* bus = find_bus(busId);
    if (bus == nullptr || !bus->ready)
        return ESP_ERR_INVALID_STATE;
    return i2c_master_probe(bus->handle, address, static_cast<int>(effective_timeout));
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read one bounded transfer with a 16-bit big-endian memory address.
 * @param busId Profile bus identifier.
 * @param address Seven-bit slave address 0x08..0x77.
 * @param offset First byte address; the transfer cannot wrap past 65535.
 * @param[out] data Caller-owned destination of at least length bytes.
 * @param length Transfer size, 1..32 bytes.
 * @return ESP_OK, argument/state error, or a bounded I2C transaction error.
 * @endcond
 */
esp_err_t hardware_i2c_memory_read(std::string_view busId,
                                   std::uint8_t address,
                                   std::uint16_t offset,
                                   std::uint8_t* data,
                                   std::size_t length)
{
    if (!valid_memory_transfer(address, offset, data, length))
        return ESP_ERR_INVALID_ARG;
    std::lock_guard<std::mutex> lock(state_mutex);
    auto* bus = find_bus(busId);
    if (bus == nullptr)
        return ESP_ERR_INVALID_STATE;
    i2c_master_dev_handle_t device = nullptr;
    const auto error = device_for(*bus, address, device);
    if (error != ESP_OK)
        return error;
    const std::array<std::uint8_t, 2> prefix{static_cast<std::uint8_t>(offset >> 8),
                                             static_cast<std::uint8_t>(offset)};
    return i2c_master_transmit_receive(
        device, prefix.data(), prefix.size(), data, length, kTransactionTimeoutMs);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Write one bounded transfer with a 16-bit big-endian memory address.
 * @param busId Profile bus identifier.
 * @param address Seven-bit slave address 0x08..0x77.
 * @param offset First byte address; the transfer cannot wrap past 65535.
 * @param data Borrowed payload, retained only during this call.
 * @param length Transfer size, 1..32 bytes.
 * @return ESP_OK, argument/state error, or a bounded I2C transaction error.
 * @endcond
 */
esp_err_t hardware_i2c_memory_write(std::string_view busId,
                                    std::uint8_t address,
                                    std::uint16_t offset,
                                    const std::uint8_t* data,
                                    std::size_t length)
{
    if (!valid_memory_transfer(address, offset, data, length))
        return ESP_ERR_INVALID_ARG;
    std::lock_guard<std::mutex> lock(state_mutex);
    auto* bus = find_bus(busId);
    if (bus == nullptr)
        return ESP_ERR_INVALID_STATE;
    i2c_master_dev_handle_t device = nullptr;
    const auto error = device_for(*bus, address, device);
    if (error != ESP_OK)
        return error;
    std::array<std::uint8_t, kMaxMemoryTransfer + 2> bytes{};
    bytes[0] = static_cast<std::uint8_t>(offset >> 8);
    bytes[1] = static_cast<std::uint8_t>(offset);
    for (std::size_t i = 0; i < length; ++i)
        bytes[i + 2] = data[i];
    return i2c_master_transmit(device, bytes.data(), length + 2, kTransactionTimeoutMs);
}

namespace {
/**
 * @brief Apply one relay command while preserving intent/confirmation separation.
 * @param[in] id Borrowed semantic relay identifier from the active profile.
 * @param[in] on Requested logical relay state, independent of electrical polarity.
 * @param[in] deadlineUs Monotonic acceptance deadline in microseconds; zero disables expiry.
 * @return ESP_OK only for confirmed write/readback, or a name/state/expiry/I2C error.
 * @note Acquires state_mutex across validation and the bounded prerequisite/write/readback
 * sequence.
 * @details A failed OFF revokes recovery ON before validity or bus checks. ON is
 * adopted as desired only after confirmed write/readback. Expiry is checked after
 * the lock and prerequisite read, immediately before OLAT; it is acceptance-only,
 * not a lease attached to future Buffered recovery. No failed ON is deferred.
 */
esp_err_t set_relay_impl(std::string_view id, bool on, std::int64_t deadlineUs)
{
    std::lock_guard<std::mutex> lock(state_mutex);
    if (!operation_permitted() || (deadlineUs != 0 && esp_timer_get_time() >= deadlineUs))
        return ESP_ERR_TIMEOUT;
    if (!initialized || worker_error != ESP_OK)
        return ESP_ERR_INVALID_STATE;
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.relayCount; ++i) {
        const auto& relay = board.relays[i];
        if (id != relay.name)
            continue;
        if (relay.expanderIndex >= expanders.size() || relay.pin >= 16)
            return ESP_ERR_INVALID_ARG;
        auto& expander = expanders[relay.expanderIndex];
        const auto bit = static_cast<std::uint16_t>(1U << relay.pin);
        const auto previous_desired = expander.desired;
        // A failed OFF must still cancel a pending recovery ON. A failed or
        // expired ON, in contrast, must never become a deferred command.
        if (!on)
            expander.desired = static_cast<std::uint16_t>(
                relay.activeHigh ? expander.desired & ~bit : expander.desired | bit);
        expire_cached(expander, esp_timer_get_time());
        if (!expander.valid)
            return ESP_ERR_INVALID_STATE;
        // Read actual device state before RMW, so a hardware reset cannot turn an
        // old RAM latch into a command that re-enables unrelated relay outputs.
        esp_err_t error = read_expander(expander, expander.latch);
        if (error != ESP_OK) {
            invalidate(expander, error);
            expander.repairNow = error == ESP_ERR_INVALID_RESPONSE;
            return error;
        }
        const auto next = static_cast<std::uint16_t>(
            on == relay.activeHigh ? expander.desired | bit : expander.desired & ~bit);
        auto* bus = find_bus(expander.profile->i2cBusId);
        if (bus == nullptr) {
            invalidate(expander, ESP_ERR_INVALID_STATE);
            return ESP_ERR_INVALID_STATE;
        }
        // Waiting for the mutex or the prerequisite I2C read may have consumed
        // the entire delivery window. Do not emit a late latch write.
        if (!operation_permitted() || (deadlineUs != 0 && esp_timer_get_time() >= deadlineUs)) {
            // The healthy pre-read consumed the delivery window; no command
            // was accepted. In particular, do not defer an expired OFF into a
            // later repair. I/O failures above still retain the OFF revocation.
            if (!on)
                expander.desired = previous_desired;
            return ESP_ERR_TIMEOUT;
        }
        error = write_word(*bus, expander.profile->address, kOlat, next);
        if (error == ESP_OK)
            error = read_expander(expander, next);
        if (error != ESP_OK)
            invalidate(expander, error);
        else
            expander.desired = next;
        return error;
    }
    return ESP_ERR_NOT_FOUND;
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Request a logical relay state and verify physical write/readback.
 * @param id Profile relay name.
 * @param on Desired logical ON/OFF; electrical polarity comes from the profile.
 * @return ESP_OK only after confirmation; driver/verification error otherwise.
 * @details OFF revokes buffered ON even when I2C fails. Failed ON never queues a
 * later recovery command. Static intent survives MCP repair, not an ESP reboot.
 * @endcond
 */
esp_err_t hardware_io_set_relay(std::string_view id, bool on)
{
    return set_relay_impl(id, on, 0);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Set a relay only within an absolute monotonic delivery window.
 * @param id Profile relay name.
 * @param on Desired logical state.
 * @param expiresAtUs Deadline in microseconds, checked under the hardware mutex
 * after the prerequisite read and immediately before OLAT is written.
 * @return ESP_OK on confirmation, ESP_ERR_TIMEOUT on expiry, or an I/O error.
 * @details This is command acceptance, not a lease. A rejected expired command
 * does not become recovery intent. I/O-failed OFF still cancels buffered ON.
 * @endcond
 */
esp_err_t hardware_io_set_relay_until(std::string_view id, bool on, std::int64_t expiresAtUs)
{
    if (expiresAtUs <= 0)
        return ESP_ERR_TIMEOUT;
    return set_relay_impl(id, on, expiresAtUs);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Register recovery ownership without actuating the output.
 * @param id Profile relay name.
 * @param policy Buffered intent or fresh-controller-decision recovery.
 * @return ESP_OK, an unknown-name/argument error, or ESP_ERR_INVALID_STATE before initialization.
 * @details Register autonomous owners before they can energize outputs. An OFF
 * must precede release/reassignment. No owner callback is made under the I/O lock.
 * @endcond
 */
esp_err_t hardware_io_set_relay_recovery(std::string_view id, HardwareRelayRecovery policy)
{
    if (policy != HardwareRelayRecovery::Buffered && policy != HardwareRelayRecovery::Controller)
        return ESP_ERR_INVALID_ARG;
    std::lock_guard<std::mutex> lock(state_mutex);
    if (!initialized || worker_error != ESP_OK)
        return ESP_ERR_INVALID_STATE;
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.relayCount; ++i) {
        const auto& relay = board.relays[i];
        if (id != relay.name)
            continue;
        if (relay.expanderIndex >= expanders.size() || relay.pin >= 16)
            return ESP_ERR_INVALID_ARG;
        auto& expander = expanders[relay.expanderIndex];
        const auto bit = static_cast<std::uint16_t>(1U << relay.pin);
        if (policy == HardwareRelayRecovery::Controller) {
            expander.controllerMask |= bit;
            if (!expander.valid)
                expander.desired = static_cast<std::uint16_t>((expander.desired & ~bit)
                                                              | (expander.safeOff & bit));
        } else
            expander.controllerMask &= static_cast<std::uint16_t>(~bit);
        return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Set and read back a profile status LED.
 * @param id Profile LED name.
 * @param on Logical state, independent of active-low wiring.
 * @return ESP_OK on confirmation, or an unknown-name/GPIO error.
 * @endcond
 */
esp_err_t hardware_io_set_led(std::string_view id, bool on)
{
    std::lock_guard<std::mutex> lock(state_mutex);
    if (!initialized)
        return ESP_ERR_INVALID_STATE;
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.ledCount; ++i) {
        const auto& led = board.leds[i];
        if (id != led.name)
            continue;
        auto& state = leds[i];
        if (!state.ready)
            return ESP_ERR_INVALID_STATE;
        const bool level = on != led.activeLow;
        state.error = gpio_set_level(static_cast<gpio_num_t>(led.gpio), level);
        if (state.error == ESP_OK
            && (gpio_get_level(static_cast<gpio_num_t>(led.gpio)) != 0) != level) {
            state.error = ESP_ERR_INVALID_RESPONSE;
        }
        if (state.error == ESP_OK)
            state.on = on;
        else
            state.ready = false;
        return state.error;
    }
    return ESP_ERR_NOT_FOUND;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Queue a bounded asynchronous scan of addresses 0x08..0x77 on all profile buses.
 * @details A running scan is not restarted. Work is interleaved with ordinary I/O,
 * and HTTP callers never wait for the full scan. Read results in the status JSON.
 * @endcond
 */
void hardware_io_request_scan()
{
    std::lock_guard<std::mutex> lock(state_mutex);
    if (!initialized || worker_error != ESP_OK)
        return;
    const auto now = esp_timer_get_time();
    for (auto& bus : buses) {
        if (bus.scanning)
            continue;
        bus.addresses.clear();
        bus.nextAddress = kFirstScanAddress;
        bus.deadlineUs = now + kScanLimitUs;
        bus.error = bus.ready ? ESP_OK : ESP_ERR_INVALID_STATE;
        bus.scanning = bus.ready;
        if (!bus.ready)
            bus.updatedUs = now;
    }
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy hardware diagnostics and serialize them outside the I2C mutex.
 * @return Owned cJSON object, or nullptr on allocation failure. Delete with cJSON_Delete.
 * @details Stale/invalid channel values are JSON null. Timestamps retain the last
 * successful observation; generation prevents repair from creating button edges.
 * @endcond
 */
cJSON* hardware_io_status_json()
{
    // JSON allocations/serialization do not hold the bus lock.
    std::vector<BusState> bus_snapshot;
    std::vector<ExpanderState> expander_snapshot;
    std::vector<GpioState> led_snapshot;
    std::vector<GpioState> sensor_snapshot;
    esp_err_t error;
    bool started;
    {
        std::lock_guard<std::mutex> lock(state_mutex);
        const auto now = esp_timer_get_time();
        for (auto& expander : expanders)
            expire_cached(expander, now);
        bus_snapshot = buses;
        expander_snapshot = expanders;
        led_snapshot = leds;
        sensor_snapshot = sensors;
        error = worker_error;
        started = initialized;
    }
    const auto& board = board_profile_active();
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddBoolToObject(root.get(), "initialized", started)
        || !add_error(root.get(), error))
        return nullptr;
    if (!add_channels(root.get(),
                      "relays",
                      board.relays,
                      started ? board.relayCount : 0,
                      true,
                      expander_snapshot)
        || !add_channels(root.get(),
                         "inputs",
                         board.inputs,
                         started ? board.inputCount : 0,
                         false,
                         expander_snapshot))
        return nullptr;
    auto* bus_array = cJSON_AddArrayToObject(root.get(), "i2c");
    auto* led_array = cJSON_AddArrayToObject(root.get(), "leds");
    auto* sensor_array = cJSON_AddArrayToObject(root.get(), "sensors");
    if (!bus_array || !led_array || !sensor_array)
        return nullptr;
    for (const auto& bus : bus_snapshot) {
        Json item(cJSON_CreateObject(), cJSON_Delete);
        if (!item || !cJSON_AddStringToObject(item.get(), "id", bus.profile->id)
            || !cJSON_AddNumberToObject(item.get(), "sdaGpio", bus.profile->sdaGpio)
            || !cJSON_AddNumberToObject(item.get(), "sclGpio", bus.profile->sclGpio)
            || !cJSON_AddBoolToObject(item.get(), "ready", bus.ready)
            || !cJSON_AddBoolToObject(item.get(), "scanning", bus.scanning)
            || !add_error(item.get(), bus.error) || !add_time(item.get(), bus.updatedUs))
            return nullptr;
        auto* addresses = cJSON_AddArrayToObject(item.get(), "addresses");
        if (addresses == nullptr)
            return nullptr;
        for (auto address : bus.addresses) {
            Json number(cJSON_CreateNumber(address), cJSON_Delete);
            if (!number || !cJSON_AddItemToArray(addresses, number.get()))
                return nullptr;
            number.release();
        }
        if (!cJSON_AddItemToArray(bus_array, item.get()))
            return nullptr;
        item.release();
    }
    for (std::size_t i = 0; i < led_snapshot.size(); ++i) {
        Json item(cJSON_CreateObject(), cJSON_Delete);
        const auto& state = led_snapshot[i];
        if (!item || !cJSON_AddStringToObject(item.get(), "id", board.leds[i].name)
            || !cJSON_AddNumberToObject(item.get(), "gpio", board.leds[i].gpio)
            || !cJSON_AddBoolToObject(item.get(), "valid", state.ready)
            || !add_value(item.get(), "value", state.ready, state.on)
            || !add_error(item.get(), state.error) || !cJSON_AddItemToArray(led_array, item.get()))
            return nullptr;
        item.release();
    }
    for (std::size_t i = 0; i < sensor_snapshot.size(); ++i) {
        Json item(cJSON_CreateObject(), cJSON_Delete);
        const auto& state = sensor_snapshot[i];
        if (!item || !cJSON_AddStringToObject(item.get(), "id", board.sensorPorts[i].name)
            || !cJSON_AddNumberToObject(item.get(), "gpio", board.sensorPorts[i].gpio)
            || !cJSON_AddBoolToObject(item.get(), "ready", state.ready)
            || !cJSON_AddStringToObject(
                item.get(),
                "mode",
                board.sensorPorts[i].openDrainRequired ? "open-drain-released" : "input")
            || !add_error(item.get(), state.error)
            || !cJSON_AddItemToArray(sensor_array, item.get()))
            return nullptr;
        item.release();
    }
    return root.release();
}

#ifdef FCPLCN_HARDWARE_IO_TESTING
/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Drive one worker iteration with host fake clock/bus adapters.
 * @endcond
 */
void hardware_io_test_step()
{
    worker_step();
}
#endif
