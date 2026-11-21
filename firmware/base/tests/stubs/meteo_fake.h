#pragma once
#include "sensors/meteo_sensors.h"

namespace meteo_fake {
void reset();
void reading(std::string_view port, const MeteoPortReading& value);
void scan(std::string_view port, const MeteoScanSnapshot& value);
std::vector<MeteoSensorConfig> configured();
bool enabled();
unsigned configure_calls();
unsigned scan_calls();
}  // namespace meteo_fake
