// Cached sensor boundary only. Production sensor timing/CRC/RMT has its own suite.
#include "meteo_fake.h"
#include <map>
#include <mutex>

namespace {
std::mutex mutex;
bool active = false;
unsigned configurations = 0, scans = 0;
std::vector<MeteoSensorConfig> ports;
std::map<std::string, MeteoPortReading> values;
std::map<std::string, MeteoScanSnapshot> searches;
}  // namespace

namespace meteo_fake {
void reset()
{
    std::lock_guard<std::mutex> lock(mutex);
    active = false;
    configurations = scans = 0;
    ports.clear();
    values.clear();
    searches.clear();
}

void reading(std::string_view port, const MeteoPortReading& value)
{
    std::lock_guard<std::mutex> lock(mutex);
    values[std::string(port)] = value;
}

void scan(std::string_view port, const MeteoScanSnapshot& value)
{
    std::lock_guard<std::mutex> lock(mutex);
    searches[std::string(port)] = value;
}

std::vector<MeteoSensorConfig> configured()
{
    std::lock_guard<std::mutex> lock(mutex);
    return ports;
}

bool enabled()
{
    std::lock_guard<std::mutex> lock(mutex);
    return active;
}

unsigned configure_calls()
{
    std::lock_guard<std::mutex> lock(mutex);
    return configurations;
}

unsigned scan_calls()
{
    std::lock_guard<std::mutex> lock(mutex);
    return scans;
}
}  // namespace meteo_fake

esp_err_t meteo_sensors_init()
{
    return ESP_OK;
}

void meteo_sensors_configure(bool enabled, const std::vector<MeteoSensorConfig>& requested)
{
    std::lock_guard<std::mutex> lock(mutex);
    active = enabled;
    ports = requested;
    ++configurations;
}

MeteoPortReading meteo_sensors_read(std::string_view port)
{
    std::lock_guard<std::mutex> lock(mutex);
    const auto found = values.find(std::string(port));
    if (found != values.end())
        return found->second;
    MeteoPortReading result;
    result.error = "No cached reading";
    return result;
}

esp_err_t meteo_sensors_request_scan(std::string_view port, bool refresh, MeteoScanSnapshot& result)
{
    std::lock_guard<std::mutex> lock(mutex);
    ++scans;
    auto& scan = searches[std::string(port)];
    if (refresh || (!scan.busy && !scan.complete)) {
        scan.busy = true;
        scan.complete = false;
        scan.error.clear();
    }
    result = scan;
    return ESP_OK;
}
