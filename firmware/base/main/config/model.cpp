/**
 * @file model.cpp
 * @brief Pure validation of device settings and supported raw JSON boundaries.
 * @details Network validation checks usable host addresses, contiguous masks and static AP/LAN
 * overlap. The raw-text guard handles escaped strings before cJSON parsing so decoded
 * NUL cannot truncate identifiers or secrets and nesting remains bounded.
 */
#include "config/model.h"

#include <algorithm>
#include <array>
#include <cctype>

namespace {
/**
 * @brief Parse exactly four decimal IPv4 octets without suffixes.
 * @param[in] text Borrowed dotted-decimal address; empty octets and values above 255 are rejected.
 * @param[out] value Packed address in network-significant order; may be partial on failure.
 * @return True only when the complete string is a supported IPv4 address.
 * @note Pure; performs no DNS lookup and does not change network state.
 */
bool ipv4(const std::string& text, std::uint32_t& value)
{
    if (text.empty())
        return false;
    value = 0;
    std::size_t pos = 0;
    for (int octet = 0; octet < 4; ++octet) {
        unsigned number = 0;
        unsigned digits = 0;
        while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') {
            number = number * 10 + static_cast<unsigned>(text[pos++] - '0');
            if (++digits > 3 || number > 255)
                return false;
        }
        if (digits == 0)
            return false;
        value = (value << 8) | number;
        if (octet < 3 && (pos >= text.size() || text[pos++] != '.'))
            return false;
    }
    return pos == text.size();
}

/**
 * @brief Validate a unicast host address and contiguous IPv4 subnet mask.
 * @param[in] address Dotted-decimal host address.
 * @param[in] mask Dotted-decimal mask with at least two host bits.
 * @param[out] ip Parsed host address; may be assigned before a later validation failure.
 * @param[out] bits Parsed mask; may be assigned before a later validation failure.
 * @return True for a supported unicast host that is neither its network nor broadcast address.
 * @note Pure; a valid address still requires separate gateway and subnet-overlap checks.
 */
bool subnet(const std::string& address,
            const std::string& mask,
            std::uint32_t& ip,
            std::uint32_t& bits)
{
    if (!ipv4(address, ip) || !ipv4(mask, bits))
        return false;
    const std::uint32_t inverted = ~bits;
    if (bits == 0 || inverted < 3 || (inverted & (inverted + 1)) != 0)
        return false;
    const std::uint32_t host = ip & inverted;
    return (ip >> 24) != 0 && (ip >> 24) < 224 && host != 0 && host != inverted;
}

/**
 * @brief Check the restricted DNS-name or IPv4 text accepted by server settings.
 * @param[in] value Candidate host text, without a scheme or port.
 * @param[in] optional Whether the empty string is accepted.
 * @return True for the accepted length and character set; this does not resolve the name.
 * @note Leading/trailing dots are rejected; only alphanumeric bytes, hyphens and dots pass.
 */
bool hostname(const std::string& value, bool optional)
{
    if (value.empty())
        return optional;
    if (value.size() > 253 || value.front() == '.' || value.back() == '.')
        return false;
    for (unsigned char ch : value) {
        if (!(std::isalnum(ch) || ch == '-' || ch == '.'))
            return false;
    }
    return true;
}

/**
 * @brief Check the supported open-network or WPA password length.
 * @param[in] value Candidate password bytes.
 * @return True for an empty password or 8 through 63 bytes.
 * @note Pure length check; it does not select an authentication mode or persist a credential.
 */
bool wifi_password(const std::string& value)
{
    return value.empty() || (value.size() >= 8 && value.size() <= 63);
}

/**
 * @brief Bound a settings text field and reject ASCII control bytes.
 * @param[in] value Candidate bytes, including an allowed empty string.
 * @param[in] maximum Maximum accepted byte count.
 * @return True when the field fits and contains neither C0 controls nor DEL.
 * @note This byte-level check does not replace UTF-8 validation where it is required.
 */
bool text_field(const std::string& value, std::size_t maximum)
{
    return value.size() <= maximum && std::none_of(value.begin(), value.end(), [](unsigned char c) {
               return c < 0x20 || c == 0x7f;
           });
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Reject unsupported NUL representations and excessive JSON container depth.
 * @param[in] text Borrowed complete raw JSON text before cJSON parsing.
 * @return False for raw/decoded NUL or container depth above 16; true still requires parsing.
 * @note Pure and allocation-free. Literal escaped backslashes are not decoded twice.
 * @endcond
 */
bool supported_json_text(std::string_view text)
{
    bool in_string = false;
    unsigned depth = 0;
    for (std::size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '\0')
            return false;
        if (in_string) {
            if (text[i] == '\\' && i + 1 < text.size()) {
                ++i;  // Consume escapes, so \\u0000 stays literal text.
                if (text[i] == 'u' && i + 4 < text.size() && text.substr(i + 1, 4) == "0000")
                    return false;
                if (text[i] == 'u' && i + 4 < text.size())
                    i += 4;
            } else if (text[i] == '"')
                in_string = false;
        } else if (text[i] == '"')
            in_string = true;
        else if (text[i] == '{' || text[i] == '[') {
            if (++depth > 16)
                return false;
        } else if ((text[i] == '}' || text[i] == ']') && depth > 0)
            --depth;
    }
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate a complete settings value, including interface/subnet constraints.
 * @param[in] c Borrowed candidate; not modified.
 * @param[out] error Human-readable failure reason, cleared on success.
 * @return True if the complete configuration is supported. Pure and thread-safe.
 * @endcond
 */
bool validate_config(const DeviceConfig& c, std::string& error)
{
    const auto fail = [&](const char* why) {
        error = why;
        return false;
    };
    if (!valid_utf8_name(c.device.name, 64))
        return fail("Имя устройства: от 1 до 64 байт UTF-8 без управляющих символов");
    if (board_profile_find(c.hardware.boardId) == nullptr)
        return fail("Неизвестный аппаратный профиль платы");
    const bool ap = c.wifi.enabled && c.wifi.ap.enabled;
    const bool sta = c.wifi.enabled && c.wifi.sta.enabled;
    if (!c.ethernet.enabled && !ap && !sta)
        return fail("Нужно оставить хотя бы один сетевой интерфейс");
    if ((ap && c.wifi.ap.ssid.empty()) || !text_field(c.wifi.ap.ssid, 32))
        return fail("SSID точки доступа: от 1 до 32 байт");
    if ((sta && c.wifi.sta.ssid.empty()) || !text_field(c.wifi.sta.ssid, 32))
        return fail("Укажите SSID Wi-Fi сети, не более 32 байт");
    if (!wifi_password(c.wifi.ap.password) || !wifi_password(c.wifi.sta.password))
        return fail("Пароль Wi-Fi должен быть пустым или от 8 до 63 байт");
    if (c.wifi.ap.channel < 1 || c.wifi.ap.channel > 11)
        return fail("Канал AP должен быть от 1 до 11");
    std::uint32_t ap_ip = 0, ap_mask = 0;
    if (!subnet(c.wifi.ap.ip, c.wifi.ap.netmask, ap_ip, ap_mask))
        return fail("Некорректный IP или маска точки доступа");
    if (c.ethernet.enabled && !c.ethernet.dhcp) {
        std::uint32_t eth_ip = 0, eth_mask = 0, gateway = 0, dns = 0;
        if (!subnet(c.ethernet.ip, c.ethernet.netmask, eth_ip, eth_mask))
            return fail("Некорректный статический IP или маска Ethernet");
        if (!ipv4(c.ethernet.gateway, gateway) || !ipv4(c.ethernet.dns, dns))
            return fail("Некорректный шлюз или DNS Ethernet");
        if (gateway != 0 && (gateway & eth_mask) != (eth_ip & eth_mask))
            return fail("Шлюз Ethernet должен быть в той же подсети");
        if (ap && (ap_ip & (ap_mask & eth_mask)) == (eth_ip & (ap_mask & eth_mask)))
            return fail("Подсети AP и Ethernet не должны пересекаться");
    }
    if (!hostname(c.linux.host, true))
        return fail("Адрес Linux: IP или DNS-имя без протокола и порта");
    if (c.linux.port < 1 || c.linux.port > 65535)
        return fail("Порт MQTT должен быть от 1 до 65535");
    if (!text_field(c.linux.username, 128) || !text_field(c.linux.password, 128))
        return fail("Параметры авторизации MQTT слишком длинные или содержат управляющие символы");
    if (c.time.timezone.empty() || !text_field(c.time.timezone, 96))
        return fail("Укажите часовой пояс POSIX");
    if (!hostname(c.time.ntpServer, !c.time.ntpEnabled))
        return fail("Укажите корректный адрес NTP-сервера");
    error.clear();
    return true;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate a nonblank UTF-8 display name without ASCII control bytes.
 * @param[in] text Borrowed byte string; overlong encodings/surrogates are rejected.
 * @param[in] maximum Maximum allowed encoded UTF-8 byte length.
 * @return True for a supported nonempty name. Pure and allocation-free.
 * @endcond
 */
bool valid_utf8_name(std::string_view text, std::size_t maximum)
{
    if (text.empty() || text.size() > maximum)
        return false;
    bool visible = false;
    for (std::size_t i = 0; i < text.size();) {
        const auto first = static_cast<unsigned char>(text[i++]);
        if (first < 0x80) {
            if (first < 0x20 || first == 0x7f)
                return false;
            visible = visible || first != ' ';
            continue;
        }
        unsigned count;
        std::uint32_t point;
        if (first >= 0xc2 && first <= 0xdf) {
            count = 1;
            point = first & 0x1f;
        } else if (first >= 0xe0 && first <= 0xef) {
            count = 2;
            point = first & 0x0f;
        } else if (first >= 0xf0 && first <= 0xf4) {
            count = 3;
            point = first & 7;
        } else
            return false;
        if (i + count > text.size())
            return false;
        for (unsigned j = 0; j < count; ++j) {
            const auto next = static_cast<unsigned char>(text[i++]);
            if ((next & 0xc0) != 0x80)
                return false;
            point = (point << 6) | (next & 0x3f);
        }
        if ((count == 1 && point < 0x80) || (count == 2 && point < 0x800)
            || (count == 3 && point < 0x10000) || point > 0x10ffff
            || (point >= 0xd800 && point <= 0xdfff))
            return false;
        visible = true;
    }
    return visible;
}
