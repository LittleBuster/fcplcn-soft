/**
 * @file model.h
 * @brief Portable persisted device settings and pure validation helpers.
 * @details Strings are owned. Settings include secrets; only explicit public serializers
 * redact them. Per-controller settings and runtime demands live in their own module.
 */
#pragma once
#include <cstdint>
#include <string>
#include <string_view>
#include "hardware/board_profile.h"

/** @brief Boot-selected hardware identity; GPIO editing is not a public setting. */
struct HardwareConfig {
    std::string boardId = kDefaultBoardProfileId;  ///< Registered canonical profile ID.
};

/** @brief User-visible identity, independent of MAC and technical device_id(). */
struct DeviceIdentityConfig {
    std::string name = "FCPLCn";  ///< Visible UTF-8 name, 1..64 bytes.
};

/** @brief Local Wi-Fi access-point settings. */
struct ApConfig {
    bool enabled = true;  ///< Effective only when WifiConfig::enabled is true.
    std::string ssid;  ///< SSID bytes, 1..32 when this interface is enabled.
    std::string password;  ///< Secret; empty means open AP, otherwise 8..63 bytes.
    int channel = 1;  ///< AP channel in 1..11.
    std::string ip = "192.168.4.1";  ///< Local IPv4 address and DHCP gateway.
    std::string netmask = "255.255.255.0";  ///< Contiguous subnet mask with usable host addresses.
};

/** @brief Optional upstream Wi-Fi station settings; address acquisition uses DHCP. */
struct StaConfig {
    bool enabled = false;  ///< Effective only when Wi-Fi is enabled.
    std::string ssid;  ///< Target network SSID, at most 32 bytes.
    std::string password;  ///< Secret; empty for open networks or 8..63 bytes.
};

/** @brief Independent AP and STA roles on the same Wi-Fi radio. */
struct WifiConfig {
    bool enabled = true;  ///< Master radio flag.
    ApConfig ap;  ///< Local service access point.
    StaConfig sta;  ///< Optional router connection.
};

/** @brief W5500 interface settings with DHCP or a complete static IPv4 configuration. */
struct EthernetConfig {
    bool enabled = true;  ///< Physical interface enabled flag.
    bool dhcp = true;  ///< Static fields are retained but ignored while DHCP is enabled.
    std::string ip = "192.168.1.50";  ///< Static host IPv4 address.
    std::string netmask = "255.255.255.0";  ///< Static contiguous IPv4 mask.
    std::string gateway = "192.168.1.1";  ///< Same-subnet gateway; 0.0.0.0 means none.
    std::string dns = "192.168.1.1";  ///< Static IPv4 resolver address.
};

/** @brief Local Linux MQTT broker credentials; PLCs have no cloud endpoint here. */
struct LinuxConfig {
    std::string host;  ///< Plain DNS name/IPv4 host; empty disables MQTT.
    int port = 1883;  ///< TCP port in 1..65535.
    std::string username;  ///< Optional broker username, at most 128 bytes.
    std::string password;  ///< Optional secret broker password, at most 128 bytes.
};

/** @brief Wall-clock timezone and optional network time synchronization. */
struct TimeConfig {
    std::string timezone = "UTC-7";  ///< POSIX TZ string, not an IANA zone database key.
    bool ntpEnabled = true;  ///< Enables the NTP worker's configured server.
    std::string ntpServer = "pool.ntp.org";  ///< Plain DNS name/IPv4 server, required when enabled.
};

/** @brief Owned device-settings snapshot copied under config's mutex. */
struct DeviceConfig {
    std::uint32_t revision = 1;  ///< Nonzero optimistic-concurrency token; never wraps.
    DeviceIdentityConfig device;  ///< User-visible identity.
    HardwareConfig hardware;  ///< Board profile activated only at boot.
    WifiConfig wifi;  ///< AP/STA configuration.
    EthernetConfig ethernet;  ///< W5500 configuration.
    LinuxConfig linux;  ///< Local MQTT connection and secrets.
    TimeConfig time;  ///< System time policy, not autonomous-loop monotonic time.
};

/** @brief Validate a complete settings value, including interface/subnet constraints.
 * @param[in] config Borrowed candidate; not modified.
 * @param[out] error Human-readable failure reason, cleared on success.
 * @return True if the complete configuration is supported. Pure and thread-safe.
 */
bool validate_config(const DeviceConfig& config, std::string& error);

/** @brief Validate a nonblank UTF-8 display name without ASCII control bytes.
 * @param[in] text Borrowed byte string; overlong encodings/surrogates are rejected.
 * @param[in] maximum Maximum allowed encoded UTF-8 byte length.
 * @return True for a supported nonempty name. Pure and allocation-free.
 */
bool valid_utf8_name(std::string_view text, std::size_t maximum);

/** @brief Reject unsupported NUL representations and excessive JSON container depth.
 * @param[in] text Borrowed complete raw JSON text before cJSON parsing.
 * @return False for raw/decoded NUL or container depth above 16; true still requires parsing.
 * @note Pure and allocation-free. Literal escaped backslashes are not decoded twice.
 */
bool supported_json_text(std::string_view text);
