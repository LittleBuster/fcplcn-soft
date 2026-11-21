/**
 * @file meteo_sensors.h
 * @brief Asynchronous DHT22 and multi-device DS18B20 acquisition for FCPLCn.
 * @details The worker releases the cache mutex before conversion/search I/O and
 * never calls controller APIs. Controllers may therefore hold their mutex before
 * using this service. Only one short-lived OneWire/RMT bus is open at a time.
 */
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "esp_err.h"

/** @brief Electrical protocol selected for one physical sensor port. */
enum class MeteoSensorType {
    Dht22,  ///< One DHT22/AM2301 temperature/humidity device.
    OneWire  ///< Externally powered DS18B20 devices sharing one bus.
};

/** @brief One physical bus configuration; controllers deduplicate shared OneWire rows. */
struct MeteoSensorConfig {
    std::string portId;  ///< Profile name such as sens-0/1.
    MeteoSensorType type = MeteoSensorType::Dht22;  ///< Protocol to poll on this port.
};

/** @brief Cached measurement for one discovered DS18B20 ROM. */
struct MeteoDeviceReading {
    std::string address;  ///< Canonical sixteen-character wire-order ROM.
    bool available = false;  ///< Acquisition succeeded; read APIs additionally enforce age.
    double temperatureC = 0;  ///< Celsius value; usable only when available is true.
    std::int64_t lastSuccessMs = -1;  ///< Monotonic acquisition time; -1 before any success.
    std::string error;  ///< Per-device error; one bad device does not hide healthy peers.
};

/** @brief Cached DHT22 result or OneWire bus/device results. */
struct MeteoPortReading {
    bool available = false;  ///< DHT valid, or at least one fresh OneWire device.
    double temperatureC = 0;  ///< DHT22 Celsius value; OneWire uses devices instead.
    double humidityPct = 0;  ///< DHT22 relative humidity; unused for OneWire.
    std::int64_t lastSuccessMs = -1;  ///< DHT22 success time; per-ROM times live in devices.
    std::string error;  ///< Bus/protocol diagnostic.
    std::vector<MeteoDeviceReading> devices;  ///< Up to sixteen discovered DS18B20 ROMs.
};

/** @brief Snapshot of the current/last queued OneWire discovery job. */
struct MeteoScanSnapshot {
    bool busy = false;  ///< A discovery is queued or executing.
    bool complete = false;  ///< The current discovery attempt has finished, possibly with error.
    std::string error;  ///< Search error or device-cap warning.
    std::vector<MeteoDeviceReading>
        devices;  ///< Cached ROMs retained while a new search is pending.
};

/**
 * @brief Initialize released sensor pins and start the acquisition worker once.
 * @return ESP_OK or the worker-allocation error; repeated calls return the initial result.
 * @details Call after board activation and before controller configuration is pushed.
 */
esp_err_t meteo_sensors_init();

/**
 * @brief Replace the worker's physical-port polling configuration without waiting for I/O.
 * @param active Module master flag; explicit discovery remains available while polling is off.
 * @param configurations Borrowed, deduplicated profile ports with their selected protocols.
 * @details Binding/master changes increment a generation. Results from an older
 * in-flight job are discarded; unchanged ports keep their cached measurements.
 */
void meteo_sensors_configure(bool active, const std::vector<MeteoSensorConfig>& configurations);

/**
 * @brief Copy a port cache and mask failed, disabled or older-than-15-second data.
 * @param portId Profile sensor-port name.
 * @return Owned value snapshot; unknown ports and driver failure have available=false and an error.
 */
MeteoPortReading meteo_sensors_read(std::string_view portId);

/**
 * @brief Queue or poll a bounded OneWire discovery; this call performs no bus I/O.
 * @param portId Profile sensor-port name.
 * @param refresh Request a new search, subject to the two-second refresh limit.
 * @param[out] snapshot Current job state and retained discoveries.
 * @return ESP_OK, ESP_ERR_NOT_FOUND, or the sensor worker startup error.
 * @details With refresh=false, the first request queues work and later requests
 * poll it. Owner/port compatibility authorization belongs to the controller API.
 */
esp_err_t
meteo_sensors_request_scan(std::string_view portId, bool refresh, MeteoScanSnapshot& snapshot);

#ifdef FCPLCN_METEO_SENSORS_TESTING
/** @brief Execute one scheduled host-test job; @return true if a job was run. */
bool meteo_sensors_test_step();
#endif
