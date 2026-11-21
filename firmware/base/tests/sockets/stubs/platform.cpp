#include "test_platform.h"
#include "hardware/hardware_io.h"
#include "hardware/board_profile.h"
#include "hardware/fram.h"
#include "nvs.h"
#include "freertos/task.h"
#include <array>
#include <cstring>
#include <map>
#include <mutex>
#include <vector>

namespace {
std::mutex mutex;
std::int64_t now = 1'000'000;
std::int64_t relay_read_advance = 0, relay_write_advance = 0, commit_advance = 0;
std::array<HardwareIoChannelState, 16> relays, inputs;
std::array<HardwareRelayRecovery, 16> recovery_policies{};
unsigned recovery_policy_call_count = 0;
using Bytes = std::vector<unsigned char>;
using Values = std::map<std::string, Bytes>;

struct Handle {
    std::string ns;
    nvs_open_mode_t mode;
    Values pending;
};

std::map<std::string, Values> storage;
std::map<nvs_handle_t, Handle> handles;
nvs_handle_t next_handle = 1;
bool commit_error = false, write_error = false, write_after_apply_error = false;
unsigned commit_count = 0, fram_commit_count = 0;
std::array<std::uint8_t, 8192> fram_bytes{};
bool fram_present = true, fram_commit_error = false;
constexpr std::array<std::uint8_t, 8> fram_commit_marker = {
    0x46, 0x43, 0x43, 0x4d, 0x54, 0x30, 0x31, 0xa5};
std::vector<std::string> event_log;

int index(std::string_view id, bool relay)
{
    const auto& p = board_profile_active();
    const auto* ports = relay ? p.relays : p.inputs;
    const auto count = relay ? p.relayCount : p.inputCount;
    for (std::size_t i = 0; i < count; ++i)
        if (id == ports[i].name)
            return static_cast<int>(i);
    return -1;
}

void initialize_channels()
{
    for (auto* group : {&relays, &inputs})
        for (auto& c : *group) {
            const auto generation = c.generation + 1;
            c = {};
            c.valid = true;
            c.fresh = true;
            c.updatedAtUs = now;
            c.generation = generation;
            c.error = ESP_OK;
        }
    for (auto& c : inputs)
        c.value = c.level = true;
}

esp_err_t read_channel(std::string_view id, HardwareIoChannelState& output, bool relay)
{
    std::lock_guard<std::mutex> lock(mutex);
    const int i = index(id, relay);
    if (i < 0)
        return ESP_ERR_NOT_FOUND;
    if (relay && relay_read_advance) {
        now += relay_read_advance;
        relay_read_advance = 0;
        for (auto& c : relays)
            if (c.valid)
                c.updatedAtUs = now;
    }
    output = (relay ? relays : inputs)[i];
    output.fresh = output.valid && now - output.updatedAtUs <= 300'000;
    return ESP_OK;
}
}  // namespace

namespace socket_test {
void reset()
{
    std::lock_guard<std::mutex> lock(mutex);
    storage.clear();
    handles.clear();
    next_handle = 1;
    commit_error = write_error = write_after_apply_error = false;
    relay_read_advance = relay_write_advance = commit_advance = 0;
    commit_count = fram_commit_count = 0;
    fram_bytes.fill(0xff);
    fram_present = true;
    fram_commit_error = false;
    recovery_policy_call_count = 0;
    recovery_policies.fill(HardwareRelayRecovery::Buffered);
    event_log.clear();
    now = 1'000'000;
    initialize_channels();
}

void reboot_hardware()
{
    std::lock_guard<std::mutex> lock(mutex);
    initialize_channels();
}

void advance(std::int64_t us, bool sample)
{
    std::lock_guard<std::mutex> lock(mutex);
    now += us;
    if (sample)
        for (auto* group : {&relays, &inputs})
            for (auto& c : *group)
                if (c.valid)
                    c.updatedAtUs = now;
}

void input(unsigned i, bool value, bool valid)
{
    std::lock_guard<std::mutex> lock(mutex);
    auto& c = inputs.at(i);
    if (c.valid != valid)
        ++c.generation;
    c.valid = valid;
    c.value = c.level = value;
    c.updatedAtUs = now;
    c.error = valid ? ESP_OK : ESP_FAIL;
}

void relay_valid(unsigned i, bool valid)
{
    std::lock_guard<std::mutex> lock(mutex);
    auto& c = relays.at(i);
    if (c.valid != valid)
        ++c.generation;
    c.valid = valid;
    c.updatedAtUs = now;
    c.error = valid ? ESP_OK : ESP_FAIL;
}

void fail_commit()
{
    std::lock_guard<std::mutex> lock(mutex);
    commit_error = true;
}

void fail_write()
{
    std::lock_guard<std::mutex> lock(mutex);
    write_error = true;
}

void fail_write_after_apply()
{
    std::lock_guard<std::mutex> lock(mutex);
    write_after_apply_error = true;
}

void physical_relay(unsigned i, bool value)
{
    std::lock_guard<std::mutex> lock(mutex);
    relays.at(i).value = relays.at(i).level = value;
    relays.at(i).updatedAtUs = now;
}

void advance_on_relay_read(std::int64_t us)
{
    std::lock_guard<std::mutex> lock(mutex);
    relay_read_advance = us;
}

void advance_on_relay_write(std::int64_t us)
{
    std::lock_guard<std::mutex> lock(mutex);
    relay_write_advance = us;
}

void advance_on_commit(std::int64_t us)
{
    std::lock_guard<std::mutex> lock(mutex);
    commit_advance = us;
}

void corrupt_storage()
{
    std::lock_guard<std::mutex> lock(mutex);
    for (auto& ns : storage)
        for (auto& value : ns.second)
            value.second = {'b', 'a', 'd'};
}

bool relay(unsigned i)
{
    std::lock_guard<std::mutex> lock(mutex);
    return relays.at(i).value;
}

HardwareRelayRecovery recovery_policy(unsigned i)
{
    std::lock_guard<std::mutex> lock(mutex);
    return recovery_policies.at(i);
}

unsigned recovery_policy_calls()
{
    std::lock_guard<std::mutex> lock(mutex);
    return recovery_policy_call_count;
}

unsigned commits()
{
    std::lock_guard<std::mutex> lock(mutex);
    return commit_count + fram_commit_count;
}

unsigned nvs_commits()
{
    std::lock_guard<std::mutex> lock(mutex);
    return commit_count;
}

unsigned fram_commits()
{
    std::lock_guard<std::mutex> lock(mutex);
    return fram_commit_count;
}

void fail_fram_commit()
{
    std::lock_guard<std::mutex> lock(mutex);
    fram_commit_error = true;
}

void set_fram_present(bool value)
{
    std::lock_guard<std::mutex> lock(mutex);
    fram_present = value;
}

void corrupt_fram()
{
    std::lock_guard<std::mutex> lock(mutex);
    fram_bytes.fill(0x55);
}

void erase_fram()
{
    std::lock_guard<std::mutex> lock(mutex);
    fram_bytes.fill(0xff);
}

std::vector<std::string> events()
{
    std::lock_guard<std::mutex> lock(mutex);
    return event_log;
}
}  // namespace socket_test

std::int64_t esp_timer_get_time()
{
    std::lock_guard<std::mutex> lock(mutex);
    return now;
}

BaseType_t
xTaskCreate(TaskFunction_t, const char*, std::uint32_t, void*, UBaseType_t, TaskHandle_t*)
{
    return pdPASS;
}

void vTaskDelay(TickType_t)
{
}

const char* esp_err_to_name(esp_err_t e)
{
    return e == ESP_OK ? "ESP_OK" : "TEST_ERROR";
}

esp_err_t hardware_io_read_relay(std::string_view id, HardwareIoChannelState& c)
{
    return read_channel(id, c, true);
}

esp_err_t hardware_io_read_input(std::string_view id, HardwareIoChannelState& c)
{
    return read_channel(id, c, false);
}

esp_err_t hardware_io_set_relay_recovery(std::string_view id, HardwareRelayRecovery policy)
{
    std::lock_guard<std::mutex> lock(mutex);
    const int i = index(id, true);
    if (i < 0)
        return ESP_ERR_NOT_FOUND;
    if (policy != HardwareRelayRecovery::Buffered && policy != HardwareRelayRecovery::Controller)
        return ESP_ERR_INVALID_ARG;
    ++recovery_policy_call_count;
    if (recovery_policies[i] != policy)
        event_log.push_back(
            std::string("policy:") + std::string(id)
            + (policy == HardwareRelayRecovery::Controller ? ":controller" : ":buffered"));
    recovery_policies[i] = policy;
    return ESP_OK;
}

esp_err_t hardware_io_set_relay(std::string_view id, bool on)
{
    std::lock_guard<std::mutex> lock(mutex);
    const int i = index(id, true);
    if (i < 0)
        return ESP_ERR_NOT_FOUND;
    if (relay_write_advance) {
        now += relay_write_advance;
        relay_write_advance = 0;
        for (auto& c : relays)
            if (c.valid)
                c.updatedAtUs = now;
    }
    if (write_error) {
        write_error = false;
        return ESP_FAIL;
    }
    if (!relays[i].valid)
        return ESP_ERR_INVALID_STATE;
    event_log.push_back(std::string("relay:") + std::string(id) + (on ? ":on" : ":off"));
    relays[i].value = relays[i].level = on;
    relays[i].updatedAtUs = now;
    if (write_after_apply_error) {
        write_after_apply_error = false;
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t hardware_io_set_relay_until(std::string_view id, bool on, std::int64_t deadlineUs)
{
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (relay_write_advance) {
            now += relay_write_advance;
            relay_write_advance = 0;
            for (auto& c : relays)
                if (c.valid)
                    c.updatedAtUs = now;
        }
        if (now >= deadlineUs)
            return ESP_ERR_TIMEOUT;
    }
    return hardware_io_set_relay(id, on);
}

esp_err_t nvs_open(const char* ns, nvs_open_mode_t mode, nvs_handle_t* out)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (mode == NVS_READONLY && !storage.count(ns))
        return ESP_ERR_NVS_NOT_FOUND;
    *out = next_handle++;
    handles.emplace(*out, Handle{ns, mode, {}});
    return ESP_OK;
}

esp_err_t nvs_get_blob(nvs_handle_t id, const char* key, void* out, std::size_t* len)
{
    std::lock_guard<std::mutex> lock(mutex);
    auto h = handles.find(id);
    if (h == handles.end())
        return ESP_ERR_INVALID_ARG;
    auto ns = storage.find(h->second.ns);
    if (ns == storage.end() || !ns->second.count(key))
        return ESP_ERR_NVS_NOT_FOUND;
    const auto& b = ns->second.at(key);
    if (!out) {
        *len = b.size();
        return ESP_OK;
    }
    if (*len < b.size()) {
        *len = b.size();
        return ESP_ERR_NVS_INVALID_LENGTH;
    }
    std::memcpy(out, b.data(), b.size());
    *len = b.size();
    return ESP_OK;
}

esp_err_t nvs_set_blob(nvs_handle_t id, const char* key, const void* in, std::size_t len)
{
    std::lock_guard<std::mutex> lock(mutex);
    auto h = handles.find(id);
    if (h == handles.end())
        return ESP_ERR_INVALID_ARG;
    const auto* p = static_cast<const unsigned char*>(in);
    h->second.pending[key] = Bytes(p, p + len);
    return ESP_OK;
}

esp_err_t nvs_get_str(nvs_handle_t id, const char* key, char* out, std::size_t* len)
{
    return nvs_get_blob(id, key, out, len);
}

esp_err_t nvs_set_str(nvs_handle_t id, const char* key, const char* value)
{
    return nvs_set_blob(id, key, value, std::strlen(value) + 1);
}

esp_err_t nvs_commit(nvs_handle_t id)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (commit_advance) {
        now += commit_advance;
        commit_advance = 0;
        for (auto& c : relays)
            if (c.valid)
                c.updatedAtUs = now;
    }
    if (commit_error) {
        commit_error = false;
        return ESP_FAIL;
    }
    auto& h = handles.at(id);
    for (auto& pair : h.pending)
        storage[h.ns][pair.first] = pair.second;
    h.pending.clear();
    ++commit_count;
    event_log.push_back("commit");
    return ESP_OK;
}

void nvs_close(nvs_handle_t id)
{
    std::lock_guard<std::mutex> lock(mutex);
    handles.erase(id);
}

esp_err_t fram_read(std::uint16_t offset, std::uint8_t* data, std::size_t length)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (!fram_present)
        return ESP_ERR_NOT_FOUND;
    if (!data || offset > fram_bytes.size() || length > fram_bytes.size() - offset)
        return ESP_ERR_INVALID_ARG;
    std::memcpy(data, fram_bytes.data() + offset, length);
    return ESP_OK;
}

esp_err_t fram_write(std::uint16_t offset, const std::uint8_t* data, std::size_t length)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (!fram_present)
        return ESP_ERR_NOT_FOUND;
    if (!data || offset > fram_bytes.size() || length > fram_bytes.size() - offset)
        return ESP_ERR_INVALID_ARG;
    const bool commit = offset % 256 == 248 && length == fram_commit_marker.size()
                        && std::memcmp(data, fram_commit_marker.data(), length) == 0;
    if (commit && commit_advance) {
        now += commit_advance;
        commit_advance = 0;
        for (auto& channel : relays)
            if (channel.valid)
                channel.updatedAtUs = now;
    }
    if (commit && fram_commit_error) {
        fram_commit_error = false;
        return ESP_FAIL;
    }
    std::memcpy(fram_bytes.data() + offset, data, length);
    if (commit) {
        ++fram_commit_count;
        event_log.push_back("commit");
    }
    return ESP_OK;
}

void esp_fill_random(void* output, std::size_t length)
{
    static std::uint64_t random_state = 0xf123456789abcdefULL;
    auto* bytes = static_cast<unsigned char*>(output);
    std::lock_guard<std::mutex> lock(mutex);
    for (std::size_t i = 0; i < length; ++i) {
        random_state ^= random_state << 13;
        random_state ^= random_state >> 7;
        random_state ^= random_state << 17;
        bytes[i] = static_cast<unsigned char>(random_state >> 24);
    }
}
