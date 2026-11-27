/**
 * @file sensor_ports.h
 * @brief Electrical access to DHT22, DS18B20 and iButton on isolated PLC ports.
 */
#pragma once

#include <cstdint>
#include <string>
#include <vector>

/** @brief A completed DHT22 transaction. */
struct Dht22Sample {
    double temperatureC = 0;  ///< Temperature in degrees Celsius.
    double humidityPct = 0;  ///< Relative humidity in percent.
    std::int64_t sampledAtMs = -1;  ///< Monotonic sample time; -1 on failure.
    std::string error;  ///< Diagnostic when no measurement was obtained.
};

/** @brief A completed DS18B20 transaction addressed by a canonical wire-order ROM. */
struct Ds18b20Sample {
    std::string address;  ///< Hexadecimal ROM in wire order.
    double temperatureC = 0;  ///< Temperature in degrees Celsius.
    std::int64_t sampledAtMs = -1;  ///< Monotonic sample time; -1 on failure.
    std::string error;  ///< Diagnostic for this individual device.
};

/** @brief Temperature results and the outcome of optional bus discovery. */
struct Ds18b20Poll {
    std::vector<Ds18b20Sample> samples;  ///< One result per known or discovered ROM.
    bool discoveryComplete = false;  ///< The search can replace the previous ROM list.
    std::string discoveryError;  ///< Diagnostic for a failed or truncated search.
    std::string error;  ///< Diagnostic for a port-wide failure.
};

/** @brief Physical presence and CRC-checked identities from an iButton search. */
struct IbuttonObservation {
    bool available = false;  ///< The observation distinguishes presence from an empty port.
    bool present = false;  ///< The bus reported an attached device.
    std::vector<std::string> addresses;  ///< Valid iButton ROMs found during the search.
    std::string error;  ///< Diagnostic for a failed or incomplete observation.
};

/**
 * @brief Release an isolated sensor GPIO as floating open-drain HIGH.
 * @param gpio Profile GPIO number.
 */
void sensor_port_release(int gpio);

/**
 * @brief Acquire and validate one DHT22/AM2301 sample.
 * @param gpio Exclusively owned sensor GPIO.
 * @return Owned measurement or driver error.
 */
Dht22Sample sensor_port_read_dht22(int gpio);

/**
 * @brief Optionally discover DS18B20 ROMs, then convert and read sensors on a single pin.
 * @param gpio Exclusively owned sensor GPIO.
 * @param discover Whether to replace known ROMs after a completed search.
 * @param addresses Owned list of previously discovered ROMs used if a new search is unsuccessful.
 * @param waitForConversion Scheduler callback that waits for the given milliseconds.
 * @return Owned measurements and bus/search diagnostics.
 * @note The driver closes the transient RMT bus before invoking the callback,
 * which may service a different sensor port during conversion.
 */
Ds18b20Poll sensor_port_poll_ds18b20(int gpio,
                                     bool discover,
                                     std::vector<std::string> addresses,
                                     void (*waitForConversion)(std::int64_t));

/**
 * @brief Observe physical device presence and valid iButton ROMs.
 * @param gpio Exclusively owned sensor GPIO.
 * @return Owned search result. A healthy empty port is distinct from a transport fault.
 */
IbuttonObservation sensor_port_observe_ibutton(int gpio);
