// Cached iButton boundary only. Production CRC/RMT/touch timing has its own sensor suite.
#include "ibutton_fake.h"

#include <algorithm>
#include <mutex>

#include "esp_timer.h"
#include "hardware/board_profile.h"
#include "platform/checksum.h"

namespace {
std::mutex mutex;
std::string port;
IbuttonReading current;
IbuttonScanSnapshot discovery;
bool physical_present = false;
bool auto_fresh = true;
bool ready = true;
unsigned scans = 0;

std::int64_t now_ms()
{
    return esp_timer_get_time() / 1000;
}

bool known_port(std::string_view id)
{
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.sensorPortCount; ++i)
        if (id == board.sensorPorts[i].name)
            return true;
    return false;
}
}  // namespace

namespace ibutton_fake {
void reset()
{
    std::lock_guard<std::mutex> lock(mutex);
    port.clear();
    current = {};
    current.available = true;
    current.updatedAtMs = now_ms();
    discovery = {};
    physical_present = false;
    auto_fresh = ready = true;
    scans = 0;
}

void key(std::string_view address)
{
    std::lock_guard<std::mutex> lock(mutex);
    std::array<std::uint8_t, 8> bytes{};
    if (!ibutton_parse_address(address, bytes)) {
        current.available = false;
        current.error = "Invalid test iButton ROM";
        ready = false;
        return;
    }
    std::string canonical(address);
    std::transform(canonical.begin(), canonical.end(), canonical.begin(), [](char c) {
        return c >= 'A' && c <= 'F' ? static_cast<char>(c - 'A' + 'a') : c;
    });
    current.available = true;
    current.error.clear();
    current.present = true;
    current.addresses = {canonical};
    current.updatedAtMs = now_ms();
    if (!physical_present && ready) {
        ++current.eventSequence;
        current.eventAddress = canonical;
        current.eventAtMs = now_ms();
    }
    physical_present = true;
    ready = false;
    auto_fresh = true;
}

void candidate(std::string_view address)
{
    std::lock_guard<std::mutex> lock(mutex);
    std::array<std::uint8_t, 8> bytes{};
    if (!ibutton_parse_address(address, bytes))
        return;
    current.available = true;
    current.present = true;
    current.addresses = {std::string(address)};
    current.updatedAtMs = now_ms();
    current.error.clear();
    physical_present = false;
    ready = auto_fresh = true;
}

void release()
{
    std::lock_guard<std::mutex> lock(mutex);
    physical_present = false;
    current.available = true;
    current.present = false;
    current.addresses.clear();
    current.error.clear();
    current.updatedAtMs = now_ms();
    ready = auto_fresh = true;
}

void fail(std::string_view error)
{
    std::lock_guard<std::mutex> lock(mutex);
    current.available = false;
    current.error = error;
    current.updatedAtMs = now_ms();
    ready = false;
    auto_fresh = true;
}

void reading(const IbuttonReading& value)
{
    std::lock_guard<std::mutex> lock(mutex);
    current = value;
    physical_present = value.present;
    ready = !value.present;
    auto_fresh = false;
}

void scan(const std::vector<std::string>& addresses)
{
    std::lock_guard<std::mutex> lock(mutex);
    discovery = {};
    discovery.complete = true;
    discovery.addresses = addresses;
    discovery.updatedAtMs = now_ms();
}

void scan(const IbuttonScanSnapshot& value)
{
    std::lock_guard<std::mutex> lock(mutex);
    discovery = value;
}

std::string configured()
{
    std::lock_guard<std::mutex> lock(mutex);
    return port;
}

unsigned scan_calls()
{
    std::lock_guard<std::mutex> lock(mutex);
    return scans;
}
}  // namespace ibutton_fake

esp_err_t ibutton_init()
{
    return ESP_OK;
}

esp_err_t ibutton_configure(std::string_view requested)
{
    if (!requested.empty() && !known_port(requested))
        return ESP_ERR_NOT_FOUND;
    std::lock_guard<std::mutex> lock(mutex);
    if (port == requested)
        return ESP_OK;
    port = requested;
    ++current.generation;
    current.available = true;
    current.present = physical_present;
    current.updatedAtMs = now_ms();
    current.eventAddress.clear();
    current.eventAtMs = -1;
    current.error.clear();
    ready = !physical_present;
    return ESP_OK;
}

IbuttonReading ibutton_read()
{
    std::lock_guard<std::mutex> lock(mutex);
    auto result = current;
    if (auto_fresh)
        result.updatedAtMs = now_ms();
    if (port.empty()) {
        result.available = false;
        result.error = "iButton reader not assigned";
    } else if (result.updatedAtMs < 0 || now_ms() < result.updatedAtMs
               || now_ms() - result.updatedAtMs > 1500) {
        result.available = false;
        result.error = "Stale iButton reader";
    }
    return result;
}

esp_err_t ibutton_request_scan(std::string_view requested, bool, IbuttonScanSnapshot& snapshot)
{
    if (!known_port(requested))
        return ESP_ERR_NOT_FOUND;
    std::lock_guard<std::mutex> lock(mutex);
    ++scans;
    snapshot = discovery;
    if (!snapshot.complete && !snapshot.busy) {
        snapshot.complete = true;
        snapshot.updatedAtMs = now_ms();
    }
    return ESP_OK;
}

bool ibutton_parse_address(std::string_view text, std::array<std::uint8_t, 8>& bytes)
{
    if (text.size() != 16)
        return false;
    std::array<std::uint8_t, 8> parsed{};
    for (std::size_t i = 0; i < text.size(); ++i) {
        const char c = text[i];
        const int nibble = c >= '0' && c <= '9'   ? c - '0'
                           : c >= 'a' && c <= 'f' ? c - 'a' + 10
                           : c >= 'A' && c <= 'F' ? c - 'A' + 10
                                                  : -1;
        if (nibble < 0)
            return false;
        parsed[i / 2] = static_cast<std::uint8_t>((parsed[i / 2] << 4) | nibble);
    }
    if (parsed[0] != 1 || fcplcn::util::crc8_dallas(parsed.data(), parsed.size()) != 0)
        return false;
    bytes = parsed;
    return true;
}

bool ibutton_worker_step()
{
    return false;
}

void ibutton_cancel_scans()
{
    std::lock_guard<std::mutex> lock(mutex);
    discovery = {};
}

void ibutton_require_release()
{
    std::lock_guard<std::mutex> lock(mutex);
    ++current.generation;
    current.eventAddress.clear();
    current.eventAtMs = -1;
    ready = false;
}
