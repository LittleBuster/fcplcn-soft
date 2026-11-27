/**
 * @file network.cpp
 * @brief Local interface lifecycle, bounded MQTT traffic and Linux-broker observations.
 * @details Only the network manager starts/stops interfaces or MQTT clients. Callbacks update
 * short-lived observations and signal manager work; lifecycle calls never run while
 * holding the status semaphore. Delayed applies preserve the HTTP response and an
 * unapplied board selection never changes live interface wiring.
 */
#include "network/network.h"
#include "hardware/board_profile.h"
#include "hardware/ethernet_w5500.h"
#include "config/config.h"
#include "system/system_metrics.h"
#include "controllers/socket_controller.h"
#include "network/socket_mqtt.h"
#include "controllers/security_sync.h"
#include "controllers/irrigation_water.h"
#include "network/mqtt_telemetry.h"
#include "network/management_mqtt.h"
#include "network/management_routes.h"
#include "time/time_service.h"
#include "platform/runtime_supervisor.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "esp_eth_netif_glue.h"
#include "esp_app_desc.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "product_identity.h"
#include "esp_netif.h"
#include "esp_netif_defaults.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "esp_wifi_types_native.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "mqtt_client.h"
#include "mqtt5_client.h"

namespace {
constexpr char kTag[] = "FCPLCn.network";
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
constexpr uint32_t kApply = 1U;
constexpr uint32_t kRetrySta = 2U;
constexpr uint32_t kMqttOnline = 4U;
constexpr uint32_t kCheckSubnets = 8U;
constexpr uint32_t kSocketSubscribeFailed = 16U;
constexpr uint32_t kSocketSubscribed = 32U;
constexpr uint32_t kMqttRetry = 64U;
constexpr int64_t kHeartbeatUs = 10'000'000;

SemaphoreHandle_t state_mutex = nullptr;
TaskHandle_t manager_task = nullptr;
esp_netif_t* ap_netif = nullptr;
esp_netif_t* sta_netif = nullptr;
esp_netif_t* eth_netif =
    nullptr;  // Published under state_mutex; never destroyed after publication.
EthernetW5500 eth_driver;  // Only the network manager changes driver/client lifecycle.
bool eth_started = false;
bool wifi_started = false;
std::atomic<bool> wifi_applying{false};
std::atomic<esp_mqtt_client_handle_t> mqtt_client{nullptr};
std::string availability_topic;
std::string heartbeat_topic;
std::string socket_command_topic;
std::string socket_ack_topic;
std::string socket_status_topic;
std::string light_command_topic;
std::string light_ack_topic;
std::string light_status_topic;
std::string meteo_status_topic;
std::string thermostat_status_topic;
std::string thermostat_command_topic;
std::string thermostat_ack_topic;
std::string security_status_topic;
std::string security_command_topic;
std::string security_ack_topic;
std::string security_hub_topic;
std::string security_event_topic;
std::string tank_status_topic;
std::string tank_command_topic;
std::string tank_ack_topic;
std::string irrigation_status_topic;
std::string irrigation_command_topic;
std::string irrigation_ack_topic;
std::string irrigation_water_request_topic;
std::string irrigation_water_reply_topic;
std::string irrigation_water_source_topic;
std::string management_request_topic;
std::string management_reply_topic;
std::string boot_id;
uint32_t heartbeat_sequence = 0;
MqttTelemetryCache telemetry_cache;
std::mutex mqtt_lifecycle_mutex;
std::mutex management_queue_mutex;
std::atomic<std::uint64_t> management_generation{1};
ManagementProtocol management_protocol;
ManagementFragments management_fragments;
std::uint64_t management_fragment_generation = 0;
TaskHandle_t management_task = nullptr;
TaskHandle_t management_restart_task = nullptr;
TaskHandle_t security_event_task = nullptr;
TaskHandle_t irrigation_water_task = nullptr;
std::atomic<bool> management_restart_pending{false};

/** @brief One owned request from exactly one MQTT connection generation. */
struct ManagementJob {
    std::string payload;
    std::uint64_t generation = 0;
};

std::optional<ManagementJob> management_queued;

struct Status {
    bool sta_connected = false;
    bool eth_link = false;
    bool mqtt_connected = false;
    bool irrigation_water_subscribed = false;
    bool socket_commands_ready = false;
    bool socket_subscription_failed = false;
    std::string wifi_error;
    std::string eth_error;
    std::string mqtt_error;
    std::string eth_mac;
    std::uint32_t tx_queued = 0;
    std::uint32_t tx_dropped = 0;
    int last_tx_error = 0;
    int outbox_bytes = 0;
} status;

class StateLock {
public:
    /**
     * @brief Acquire the network-observation mutex for this scope.
     * @pre state_mutex has been created; the calling task does not already hold it.
     * @note Waits without a timeout. Lifecycle operations must remain outside this lock.
     */
    StateLock()
    {
        xSemaphoreTake(state_mutex, portMAX_DELAY);
    }

    /**
     * @brief Release the network-observation mutex acquired by this guard.
     */
    ~StateLock()
    {
        xSemaphoreGive(state_mutex);
    }
};

/**
 * @brief Copy a bounded outgoing message into ESP-MQTT's asynchronous outbox.
 * @param[in] client Live client owned by the network manager or its current SDK callback.
 * @param[in] topic Stable MQTT destination.
 * @param[in] payload Borrowed bytes copied by the SDK before return.
 * @param[in] qos MQTT delivery quality requested for this message.
 * @param[in] retain Whether the broker should retain the latest value.
 * @return True when queued locally; false on invalid size, allocation or outbox pressure.
 * @note Performs no socket write. The 64 KiB outbox is bounded; failure is diagnostic and callers
 * retry current state rather than keeping an unbounded application backlog.
 */
bool enqueue_message(esp_mqtt_client_handle_t client,
                     const std::string& topic,
                     std::string_view payload,
                     int qos,
                     bool retain)
{
    const int result = client != nullptr && payload.size() <= kMqttTelemetryMaxBytes
                           ? esp_mqtt_client_enqueue(client,
                                                     topic.c_str(),
                                                     payload.data(),
                                                     static_cast<int>(payload.size()),
                                                     qos,
                                                     retain,
                                                     true)
                           : -1;
    StateLock lock;
    if (result >= 0) {
        if (status.tx_queued < UINT32_MAX)
            ++status.tx_queued;
        status.last_tx_error = 0;
    } else {
        if (status.tx_dropped < UINT32_MAX)
            ++status.tx_dropped;
        status.last_tx_error = result;
    }
    return result >= 0;
}

/**
 * @brief Coalesce deferred work flags in the network manager task notification.
 * @param[in] bits Bit mask of apply, retry, connection or subscription events.
 * @note Does nothing before manager startup; safe from SDK task callbacks, not an ISR API.
 */
void notify_manager(uint32_t bits)
{
    if (manager_task != nullptr) {
        xTaskNotify(manager_task, bits, eSetBits);
    }
}

/**
 * @brief Store an operation failure in one status field and log the same diagnostic.
 * @param[in] field Pointer to the WiFi, Ethernet or MQTT diagnostic member.
 * @param[in] operation Borrowed operation name used as the diagnostic prefix.
 * @param[in] error ESP-IDF error code converted to its symbolic name.
 * @note Acquires state_mutex only while replacing the field; logs after releasing it.
 */
void set_error(std::string Status::* field, const char* operation, esp_err_t error)
{
    const std::string message = std::string(operation) + ": " + esp_err_to_name(error);
    {
        StateLock lock;
        status.*field = message;
    }
    ESP_LOGW(kTag, "%s", message.c_str());
}

/**
 * @brief Suspend the current task for at least one scheduler tick.
 * @param[in] ms Requested delay in milliseconds, rounded by pdMS_TO_TICKS.
 */
void pause_ms(uint32_t ms)
{
    vTaskDelay(std::max<TickType_t>(1, pdMS_TO_TICKS(ms)));
}

/**
 * @brief Compare saved WiFi settings that require applying the radio configuration.
 * @param[in] a First settings snapshot.
 * @param[in] b Second settings snapshot.
 * @return True when radio, AP and STA fields are equal; unrelated device settings are ignored.
 */
bool same_wifi(const WifiConfig& a, const WifiConfig& b)
{
    return a.enabled == b.enabled && a.ap.enabled == b.ap.enabled && a.ap.ssid == b.ap.ssid
           && a.ap.password == b.ap.password && a.ap.channel == b.ap.channel && a.ap.ip == b.ap.ip
           && a.ap.netmask == b.ap.netmask && a.sta.enabled == b.sta.enabled
           && a.sta.ssid == b.sta.ssid && a.sta.password == b.sta.password;
}

/**
 * @brief Compare saved Ethernet addressing and enable settings.
 * @param[in] a First settings snapshot.
 * @param[in] b Second settings snapshot.
 * @return True when enabled, DHCP, address, mask, gateway and DNS fields are equal.
 */
bool same_eth(const EthernetConfig& a, const EthernetConfig& b)
{
    return a.enabled == b.enabled && a.dhcp == b.dhcp && a.ip == b.ip && a.netmask == b.netmask
           && a.gateway == b.gateway && a.dns == b.dns;
}

/**
 * @brief Compare the local Linux MQTT endpoint and its credentials.
 * @param[in] a First settings snapshot.
 * @param[in] b Second settings snapshot.
 * @return True when host, port, user and password are equal.
 */
bool same_linux(const LinuxConfig& a, const LinuxConfig& b)
{
    return a.host == b.host && a.port == b.port && a.username == b.username
           && a.password == b.password;
}

/**
 * @brief Parse an IPv4 literal into the ESP network byte-order address.
 * @param[in] value Borrowed dotted-decimal address; DNS names are not resolved.
 * @param[out] result Parsed address when conversion succeeds.
 * @return True on successful inet_pton conversion; false for invalid IPv4 text.
 */
bool parse_ip(const std::string& value, esp_ip4_addr_t& result)
{
    return inet_pton(AF_INET, value.c_str(), &result.addr) == 1;
}

/**
 * @brief Format a nonzero ESP IPv4 address for status JSON.
 * @param[in] address Address in ESP network representation.
 * @return Dotted-decimal text, or an empty string for an unassigned zero address.
 */
std::string ip_string(const esp_ip4_addr_t& address)
{
    if (address.addr == 0)
        return "";
    char buffer[16];
    std::snprintf(buffer, sizeof(buffer), IPSTR, IP2STR(&address));
    return buffer;
}

/**
 * @brief Accept both a successful DHCP stop and its already-stopped status.
 * @param[in] result Return code from the DHCP server or client stop call.
 * @return True for ESP_OK or ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED.
 */
bool dhcp_stopped(esp_err_t result)
{
    return result == ESP_OK || result == ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED;
}

/**
 * @brief Restart WiFi in the requested AP/STA mode and apply its network settings.
 * @param[in] cfg Validated saved radio, AP and STA configuration.
 * @return ESP_OK or the first SDK/addressing error; observations are reset before applying.
 * @pre Only the network manager calls this; AP and STA netifs already exist.
 * @note May block in SDK calls. wifi_applying suppresses reconnect work during an intentional stop.
 */
esp_err_t apply_wifi(const WifiConfig& cfg)
{
    wifi_applying.store(true);
    if (wifi_started) {
        const esp_err_t error = esp_wifi_stop();
        if (error != ESP_OK) {
            wifi_applying.store(false);
            return error;
        }
        wifi_started = false;
    }
    {
        StateLock lock;
        status.sta_connected = false;
        status.wifi_error.clear();
    }
    const bool ap_enabled = cfg.enabled && cfg.ap.enabled;
    const bool sta_enabled = cfg.enabled && cfg.sta.enabled && !cfg.sta.ssid.empty();
    const wifi_mode_t mode = ap_enabled ? (sta_enabled ? WIFI_MODE_APSTA : WIFI_MODE_AP)
                                        : (sta_enabled ? WIFI_MODE_STA : WIFI_MODE_NULL);
    esp_err_t error = esp_wifi_set_mode(mode);
    if (error == ESP_OK && ap_enabled) {
        wifi_config_t ap{};
        const size_t ssid_size = std::min(cfg.ap.ssid.size(), sizeof(ap.ap.ssid));
        std::memcpy(ap.ap.ssid, cfg.ap.ssid.data(), ssid_size);
        ap.ap.ssid_len = static_cast<uint8_t>(ssid_size);
        std::memcpy(ap.ap.password,
                    cfg.ap.password.data(),
                    std::min(cfg.ap.password.size(), sizeof(ap.ap.password)));
        ap.ap.channel = static_cast<uint8_t>(cfg.ap.channel);
        ap.ap.max_connection = 4;
        ap.ap.authmode = cfg.ap.password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
        ap.ap.pmf_cfg.required = false;
        error = esp_wifi_set_config(WIFI_IF_AP, &ap);
        if (error == ESP_OK) {
            esp_netif_ip_info_t ip{};
            if (!parse_ip(cfg.ap.ip, ip.ip) || !parse_ip(cfg.ap.netmask, ip.netmask)) {
                error = ESP_ERR_INVALID_ARG;
            } else {
                ip.gw = ip.ip;
                const esp_err_t stopped = esp_netif_dhcps_stop(ap_netif);
                error = dhcp_stopped(stopped) ? esp_netif_set_ip_info(ap_netif, &ip) : stopped;
                if (error == ESP_OK) {
                    error = esp_netif_dhcps_start(ap_netif);
                    if (error == ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED)
                        error = ESP_OK;
                }
            }
        }
    }
    if (error == ESP_OK && sta_enabled) {
        wifi_config_t sta{};
        std::memcpy(
            sta.sta.ssid, cfg.sta.ssid.data(), std::min(cfg.sta.ssid.size(), sizeof(sta.sta.ssid)));
        std::memcpy(sta.sta.password,
                    cfg.sta.password.data(),
                    std::min(cfg.sta.password.size(), sizeof(sta.sta.password)));
        sta.sta.pmf_cfg.capable = true;
        sta.sta.pmf_cfg.required = false;
        error = esp_wifi_set_config(WIFI_IF_STA, &sta);
    }
    if (error == ESP_OK && mode != WIFI_MODE_NULL) {
        error = esp_wifi_start();
        wifi_started = error == ESP_OK;
    }
    wifi_applying.store(false);
    if (error == ESP_OK && sta_enabled) {
        error = esp_wifi_connect();
    }
    return error;
}

/**
 * @brief Attach the hardware Ethernet driver to a network interface with the LAN route priority.
 * @return ESP_OK for an existing or newly attached interface; otherwise a profile, memory or SDK
 * error.
 * @pre Only the network manager calls this after board activation and esp_netif initialization.
 * @details On success the netif and glue live until reboot. The netif becomes visible under
 * state_mutex only after attachment succeeds.
 */
esp_err_t initialize_ethernet()
{
    if (eth_netif != nullptr)
        return ESP_OK;
    auto error = eth_driver.initialize(board_profile_active().w5500);
    if (error != ESP_OK)
        return error;

    esp_netif_inherent_config_t inherent = ESP_NETIF_INHERENT_DEFAULT_ETH();
    inherent.route_prio = 150;
    esp_netif_config_t netif_config = ESP_NETIF_DEFAULT_ETH();
    netif_config.base = &inherent;
    auto* netif = esp_netif_new(&netif_config);
    if (netif == nullptr) {
        eth_driver.discard();
        return ESP_ERR_NO_MEM;
    }
    esp_netif_set_hostname(netif, device_id().c_str());
    auto glue = esp_eth_new_netif_glue(eth_driver.handle());
    error = glue != nullptr ? esp_netif_attach(netif, glue) : ESP_ERR_NO_MEM;
    if (error != ESP_OK) {
        if (glue != nullptr)
            esp_eth_del_netif_glue(glue);
        esp_netif_destroy(netif);
        eth_driver.discard();
        return error;
    }

    char formatted_mac[18];
    std::snprintf(formatted_mac, sizeof(formatted_mac), MACSTR, MAC2STR(eth_driver.mac_address()));
    StateLock lock;
    eth_netif = netif;
    status.eth_mac = formatted_mac;
    return ESP_OK;
}

/**
 * @brief Stop the previous Ethernet session, configure addressing and start W5500 if enabled.
 * @param[in] cfg Validated saved Ethernet enable, DHCP or static addressing settings.
 * @return ESP_OK when disabled or applied, otherwise the first initialization or SDK/addressing
 * error.
 * @pre Only the network manager calls this; it owns the Ethernet driver lifecycle.
 * @note Clears old link observations; link/IP callbacks report the eventual connection state.
 */
esp_err_t apply_ethernet(const EthernetConfig& cfg)
{
    if (eth_started) {
        const esp_err_t error = esp_eth_stop(eth_driver.handle());
        if (error != ESP_OK)
            return error;
        eth_started = false;
    }
    {
        StateLock lock;
        status.eth_link = false;
        status.eth_error.clear();
    }
    if (!cfg.enabled)
        return ESP_OK;
    esp_err_t error = initialize_ethernet();
    if (error != ESP_OK)
        return error;
    error = esp_netif_dhcpc_stop(eth_netif);
    if (!dhcp_stopped(error))
        return error;
    esp_netif_ip_info_t ip{};
    if (!cfg.dhcp
        && (!parse_ip(cfg.ip, ip.ip) || !parse_ip(cfg.netmask, ip.netmask)
            || !parse_ip(cfg.gateway, ip.gw)))
        return ESP_ERR_INVALID_ARG;
    error = esp_netif_set_ip_info(eth_netif, &ip);
    if (error != ESP_OK)
        return error;
    if (cfg.dhcp) {
        error = esp_netif_dhcpc_start(eth_netif);
        if (error == ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED)
            error = ESP_OK;
    } else {
        esp_netif_dns_info_t dns{};
        dns.ip.type = ESP_IPADDR_TYPE_V4;
        if (!parse_ip(cfg.dns, dns.ip.u_addr.ip4))
            return ESP_ERR_INVALID_ARG;
        error = esp_netif_set_dns_info(eth_netif, ESP_NETIF_DNS_MAIN, &dns);
    }
    if (error != ESP_OK)
        return error;
    error = esp_eth_start(eth_driver.handle());
    eth_started = error == ESP_OK;
    return error;
}

/**
 * @brief Record WiFi/Ethernet observations and request deferred network recovery work.
 * @param[in] base SDK event family: WiFi, Ethernet or IP.
 * @param[in] id Event identifier within the family.
 * @param[in] data Borrowed SDK payload with the type associated with base and id.
 * @note The unnamed event-handler context is unused. Runs on an SDK task, not in an ISR.
 * @details Briefly takes state_mutex for observations. Reconnect and subnet checks are notified
 * @details to the manager; this callback never starts or stops interface/client lifecycles.
 */
void network_event(void*, esp_event_base_t base, int32_t id, void* data)
{
    if (base == WIFI_EVENT) {
        if (id == WIFI_EVENT_STA_CONNECTED) {
            StateLock lock;
            status.sta_connected = true;
            status.wifi_error.clear();
        } else if (id == WIFI_EVENT_STA_DISCONNECTED || id == WIFI_EVENT_STA_STOP) {
            {
                StateLock lock;
                status.sta_connected = false;
                if (id == WIFI_EVENT_STA_DISCONNECTED && !wifi_applying.load()) {
                    const auto* event = static_cast<wifi_event_sta_disconnected_t*>(data);
                    status.wifi_error =
                        "Wi-Fi disconnected (reason " + std::to_string(event->reason) + ")";
                }
            }
            if (!wifi_applying.load() && id == WIFI_EVENT_STA_DISCONNECTED)
                notify_manager(kRetrySta);
        }
    } else if (base == ETH_EVENT) {
        StateLock lock;
        if (id == ETHERNET_EVENT_CONNECTED) {
            status.eth_link = true;
            status.eth_error.clear();
        } else if (id == ETHERNET_EVENT_DISCONNECTED || id == ETHERNET_EVENT_STOP) {
            status.eth_link = false;
        }
    } else if (base == IP_EVENT) {
        if (id == IP_EVENT_STA_GOT_IP) {
            StateLock lock;
            status.wifi_error.clear();
        }
        if (id == IP_EVENT_STA_GOT_IP || id == IP_EVENT_ETH_GOT_IP) {
            const auto* event = static_cast<ip_event_got_ip_t*>(data);
            ESP_LOGI(kTag,
                     "%s IP: " IPSTR,
                     id == IP_EVENT_ETH_GOT_IP ? "Ethernet" : "Wi-Fi STA",
                     IP2STR(&event->ip_info.ip));
            notify_manager(kCheckSubnets);
        }
    }
    // ESP-MQTT maintains its own reconnection loop after an interface change.
}

/** @brief Cancel partial and queued management work before another MQTT lifecycle can reuse it. */
void cancel_management()
{
    std::lock_guard<std::mutex> lock(management_queue_mutex);
    management_generation.fetch_add(1);
    management_fragments.reset();
    management_queued.reset();
}

/** @brief Wait for an acknowledged management reboot request, then allow one second for delivery.
 */
void management_restart_worker(void*)
{
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
    vTaskDelete(nullptr);
}

/**
 * @brief Reserve an idle reboot task before an atomic restore can freeze settings writes.
 * @return True for an existing worker or successful task allocation.
 */
bool reserve_management_restart()
{
    if (management_restart_task != nullptr)
        return true;
    return xTaskCreate(management_restart_worker,
                       "fcplcn_mgmt_reset",
                       3072,
                       nullptr,
                       3,
                       &management_restart_task)
           == pdPASS;
}

/** @brief Send a private QoS0 reply directly from its worker without an offline outbox.
 * @param[in] job Generation that owns the response.
 * @param[in] payload Bounded serialized private response; never logged or retained.
 * @return True on SDK send success; delivery/application acceptance still belongs to the hub.
 * @note The lifecycle mutex prevents destroy/rebind while the SDK copies/sends the fragments.
 */
bool send_management_reply(const ManagementJob& job, const std::string& payload)
{
    std::lock_guard<std::mutex> lifecycle(mqtt_lifecycle_mutex);
    if (payload.empty() || payload.size() > kManagementMaxReplyBytes
        || job.generation != management_generation.load())
        return false;
    const auto client = mqtt_client.load();
    {
        StateLock state;
        if (!client || !status.mqtt_connected)
            return false;
    }
    // enqueue(..., store=true) would retain QoS0 secrets across reconnect. Direct publish
    // fragments large replies and drops them on disconnect; only this dedicated worker blocks.
    const int result = esp_mqtt_client_publish(client,
                                               management_reply_topic.c_str(),
                                               payload.data(),
                                               static_cast<int>(payload.size()),
                                               0,
                                               false);
    StateLock state;
    if (result >= 0) {
        if (status.tx_queued < UINT32_MAX)
            ++status.tx_queued;
    } else {
        if (status.tx_dropped < UINT32_MAX)
            ++status.tx_dropped;
    }
    status.last_tx_error = result < 0 ? result : 0;
    return result >= 0;
}

/** @brief Execute one private request at a time outside SDK callbacks and autonomous control tasks.
 */
void management_worker(void*)
{
    while (true) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        while (true) {
            std::optional<ManagementJob> job;
            {
                std::lock_guard<std::mutex> lock(management_queue_mutex);
                job = std::move(management_queued);
                management_queued.reset();
            }
            if (!job)
                break;
            if (job->generation != management_generation.load())
                continue;
            const auto result = management_protocol.process(
                job->payload,
                false,
                boot_id,
                esp_timer_get_time() / 1000,
                [](const ManagementRequest& request) {
                    return management_dispatch(request, {reserve_management_restart});
                },
                &management_generation,
                job->generation);
            send_management_reply(*job, result.payload);
            // Persistence has already succeeded. Complete accepted apply/restore work even
            // if its reply was lost; never leave a staged restore frozen without reboot.
            if (result.deferred.timeApply)
                time_service_schedule_apply();
            if (result.deferred.networkApply)
                network_schedule_apply();
            if (result.deferred.reboot && !management_restart_pending.exchange(true))
                xTaskNotifyGive(management_restart_task);
        }
    }
}

/** @brief Copy contiguous private fragments into a one-slot worker queue without service I/O.
 * @param[in] event SDK-owned event, valid only during this callback.
 * @param[in] first True for an exact private-topic first fragment.
 */
void receive_management_fragment(esp_mqtt_event_handle_t event, bool first)
{
    bool queued = false;
    {
        std::lock_guard<std::mutex> lock(management_queue_mutex);
        if (first)
            management_fragment_generation = management_generation.load();
        if (!first && !management_fragments.active())
            return;
        if (event->current_data_offset < 0 || event->total_data_len <= 0 || event->data_len <= 0
            || !event->data) {
            management_fragments.reset();
            return;
        }
        std::string payload;
        if (management_fragments.append(std::string_view(event->data, event->data_len),
                                        static_cast<std::size_t>(event->current_data_offset),
                                        static_cast<std::size_t>(event->total_data_len),
                                        event->retain,
                                        esp_timer_get_time() / 1000,
                                        payload)
            && !management_queued
            && management_fragment_generation == management_generation.load()) {
            management_queued = ManagementJob{std::move(payload), management_fragment_generation};
            queued = true;
        }
    }
    if (queued && management_task)
        xTaskNotifyGive(management_task);
}

/**
 * @brief Observe MQTT lifecycle and route private payloads to their dedicated bounded worker.
 * @param[in] id MQTT event identifier.
 * @param[in] data Borrowed SDK event valid only for this callback.
 */
void mqtt_event(void*, esp_event_base_t, int32_t id, void* data)
{
    const auto event = static_cast<esp_mqtt_event_handle_t>(data);
    if (event->client != mqtt_client.load())
        return;
    if (id == MQTT_EVENT_CONNECTED) {
        cancel_management();
        security_sync_connection(true, boot_id);
        irrigation_water_connection(true);
        {
            StateLock lock;
            status.mqtt_connected = true;
            status.irrigation_water_subscribed = false;
            status.socket_commands_ready = false;
            status.socket_subscription_failed = false;
            status.mqtt_error.clear();
        }
        notify_manager(kMqttOnline);
    } else if (id == MQTT_EVENT_SUBSCRIBED) {
        const bool failed = event->error_handle != nullptr
                            && event->error_handle->error_type == MQTT_ERROR_TYPE_SUBSCRIBE_FAILED;
        // The SDK exposes one return code per filter. The single optional subscription
        // is independent of the multi-filter command subscription and its readiness.
        if (event->data_len == 1) {
            StateLock lock;
            status.irrigation_water_subscribed = !failed;
            return;
        }
        {
            StateLock lock;
            status.socket_commands_ready = !failed;
            status.socket_subscription_failed = failed;
            status.mqtt_error =
                failed ? "Controller command subscription rejected by broker; check MQTT ACL" : "";
        }
        notify_manager(failed ? kSocketSubscribeFailed : kSocketSubscribed);
    } else if (id == MQTT_EVENT_DATA) {
        // The 512-byte command limit fits one MQTT buffer. Never reassemble an
        // arbitrary fragmented message or execute an incomplete JSON command.
        const auto matches = [&](const std::string& topic) {
            return event->topic != nullptr && event->topic_len == static_cast<int>(topic.size())
                   && std::memcmp(event->topic, topic.data(), topic.size()) == 0;
        };
        if (matches(security_hub_topic)) {
            const bool whole = event->current_data_offset == 0 && event->data_len > 0
                               && event->data_len == event->total_data_len && event->data_len <= 512
                               && event->data != nullptr;
            if (whole)
                security_sync_receive(std::string_view(event->data, event->data_len),
                                      event->retain,
                                      boot_id,
                                      esp_timer_get_time() / 1000);
            return;
        }
        if (matches(irrigation_water_reply_topic)) {
            if (event->current_data_offset == 0 && event->data != nullptr && event->data_len > 0
                && event->data_len == event->total_data_len
                && static_cast<std::size_t>(event->data_len) <= kIrrigationWaterReplyMaxBytes)
                irrigation_water_receive(std::string_view(event->data, event->data_len),
                                         event->retain,
                                         device_id(),
                                         boot_id,
                                         esp_timer_get_time());
            return;
        }
        if (matches(management_request_topic)) {
            receive_management_fragment(event, event->current_data_offset == 0);
            return;
        }
        if (event->current_data_offset > 0 && (event->topic == nullptr || event->topic_len == 0)) {
            receive_management_fragment(event, false);
            return;
        }
        if (event->current_data_offset == 0) {
            std::lock_guard<std::mutex> lock(management_queue_mutex);
            management_fragments.reset();
        }
        ControllerKind kind;
        const std::string* acknowledgement;
        if (matches(socket_command_topic)) {
            kind = ControllerKind::Sockets;
            acknowledgement = &socket_ack_topic;
        } else if (matches(light_command_topic)) {
            kind = ControllerKind::Lights;
            acknowledgement = &light_ack_topic;
        } else if (matches(thermostat_command_topic)) {
            kind = ControllerKind::Thermostats;
            acknowledgement = &thermostat_ack_topic;
        } else if (matches(security_command_topic)) {
            kind = ControllerKind::Security;
            acknowledgement = &security_ack_topic;
        } else if (matches(tank_command_topic)) {
            kind = ControllerKind::Tanks;
            acknowledgement = &tank_ack_topic;
        } else if (matches(irrigation_command_topic)) {
            kind = ControllerKind::Irrigation;
            acknowledgement = &irrigation_ack_topic;
        } else
            return;
        const bool whole = event->current_data_offset == 0 && event->data_len > 0
                           && event->data_len == event->total_data_len && event->data_len <= 512
                           && event->data != nullptr;
        Json response(controller_mqtt_command(kind,
                                              whole ? std::string_view(event->data, event->data_len)
                                                    : std::string_view{},
                                              event->retain,
                                              boot_id,
                                              esp_timer_get_time() / 1000),
                      cJSON_Delete);
        char* payload = response ? cJSON_PrintUnformatted(response.get()) : nullptr;
        if (payload != nullptr) {
            enqueue_message(event->client, *acknowledgement, payload, 0, false);
            cJSON_free(payload);
        }
    } else if (id == MQTT_EVENT_DISCONNECTED) {
        cancel_management();
        security_sync_connection(false, boot_id);
        irrigation_water_connection(false);
        notify_manager(kMqttRetry);
        StateLock lock;
        status.mqtt_connected = false;
        status.irrigation_water_subscribed = false;
        status.socket_commands_ready = false;
        status.socket_subscription_failed = false;
    } else if (id == MQTT_EVENT_ERROR) {
        cancel_management();
        security_sync_connection(false, boot_id);
        irrigation_water_connection(false);
        notify_manager(kMqttRetry);
        StateLock lock;
        status.mqtt_connected = false;
        status.irrigation_water_subscribed = false;
        status.socket_commands_ready = false;
        status.socket_subscription_failed = false;
        status.mqtt_error = "Local MQTT connection failed";
        if (event->error_handle != nullptr) {
            status.mqtt_error += " (type " + std::to_string(event->error_handle->error_type) + ")";
        }
    }
}

/**
 * @brief Replace the MQTT client with a connection to the saved local Linux broker.
 * @param[in] cfg Validated local broker endpoint and credentials; empty host disables MQTT.
 * @pre Only the network manager calls this, outside state_mutex and MQTT/HTTP callbacks.
 * @details Requests the broker's retained offline Will when stopping the old MQTT 5 client.
 * Creates bounded MQTT buffers/outbox,
 * @details configures retained Last Will and records initialization/start errors in status.
 */
void apply_mqtt(const LinuxConfig& cfg)
{
    cancel_management();
    security_sync_connection(false, boot_id);
    irrigation_water_connection(false);
    std::lock_guard<std::mutex> lifecycle(mqtt_lifecycle_mutex);
    // Stop/destroy may wait for MQTT's worker: never call them from an MQTT/HTTP callback.
    auto client = mqtt_client.exchange(nullptr);
    if (client != nullptr) {
        // MQTT 5 reason 0x04 makes the broker publish the configured offline Will even on a
        // deliberate shutdown. An asynchronous publish followed by destroy could be lost.
        esp_mqtt5_disconnect_property_config_t disconnect{};
        disconnect.disconnect_reason = MQTT5_DISCONNECT_WITH_WILL;
        esp_mqtt5_client_set_disconnect_property(client, &disconnect);
        esp_mqtt_client_stop(client);
        esp_mqtt_client_destroy(client);
    }
    {
        StateLock lock;
        status.mqtt_connected = false;
        status.irrigation_water_subscribed = false;
        status.socket_commands_ready = false;
        status.socket_subscription_failed = false;
        status.mqtt_error.clear();
    }
    if (cfg.host.empty())
        return;
    esp_mqtt_client_config_t mqtt{};
    mqtt.broker.address.hostname = cfg.host.c_str();
    mqtt.broker.address.port = static_cast<uint32_t>(cfg.port);
    mqtt.broker.address.transport = MQTT_TRANSPORT_OVER_TCP;
    mqtt.credentials.client_id = device_id().c_str();
    mqtt.credentials.username = cfg.username.empty() ? nullptr : cfg.username.c_str();
    mqtt.credentials.authentication.password =
        cfg.password.empty() ? nullptr : cfg.password.c_str();
    mqtt.session.last_will.topic = availability_topic.c_str();
    mqtt.session.last_will.msg = "offline";
    mqtt.session.last_will.qos = 1;
    mqtt.session.last_will.retain = true;
    mqtt.session.keepalive = 30;
    mqtt.session.protocol_ver = MQTT_PROTOCOL_V_5;
    mqtt.network.timeout_ms = 4000;
    mqtt.network.reconnect_timeout_ms = 5000;
    // Recreate in the manager after failure: the retired client's outbox must never replay a touch.
    mqtt.network.disable_auto_reconnect = true;
    mqtt.outbox.limit = 64 * 1024;
    mqtt.buffer.size = 1024;
    mqtt.task.stack_size = 6144;
    client = esp_mqtt_client_init(&mqtt);
    if (client == nullptr) {
        set_error(&Status::mqtt_error, "MQTT initialization", ESP_ERR_NO_MEM);
        notify_manager(kMqttRetry);
        return;
    }
    mqtt_client.store(client);
    esp_err_t error = esp_mqtt_client_register_event(client, MQTT_EVENT_ANY, mqtt_event, nullptr);
    if (error == ESP_OK)
        error = esp_mqtt_client_start(client);
    if (error != ESP_OK) {
        mqtt_client.store(nullptr);
        esp_mqtt_client_destroy(client);
        set_error(&Status::mqtt_error, "MQTT start", error);
        notify_manager(kMqttRetry);
    }
}

/**
 * @brief Publish a bounded retained system heartbeat while the local broker is connected.
 * @pre Only the network manager calls this; heartbeat_sequence belongs to that task.
 * @details Copies observations under state_mutex, then queues diagnostics with QoS 0
 * @details without holding it. Skips disconnected/allocation failures; oversized payloads are
 * logged.
 */
void publish_heartbeat()
{
    const auto client = mqtt_client.load();
    Status current;
    {
        StateLock lock;
        current = status;
    }
    if (client == nullptr || !current.mqtt_connected)
        return;
    Json heartbeat(cJSON_CreateObject(), cJSON_Delete);
    if (!heartbeat)
        return;
    cJSON_AddStringToObject(heartbeat.get(), "deviceId", device_id().c_str());
    cJSON_AddStringToObject(heartbeat.get(), "product", FCPLCN_PRODUCT_NAME);
    cJSON_AddStringToObject(heartbeat.get(), "boardId", board_profile_active().id);
    cJSON_AddStringToObject(heartbeat.get(), "firmwareVersion", esp_app_get_description()->version);
    cJSON_AddStringToObject(heartbeat.get(), "bootId", boot_id.c_str());
    cJSON_AddNumberToObject(heartbeat.get(), "sequence", ++heartbeat_sequence);
    cJSON_AddNumberToObject(heartbeat.get(), "schemaVersion", 1);
    cJSON_AddNumberToObject(heartbeat.get(), "managementVersion", 1);
    cJSON_AddNumberToObject(heartbeat.get(), "managementSequence", management_protocol.sequence());
    cJSON_AddNumberToObject(heartbeat.get(), "uptimeSec", esp_timer_get_time() / 1'000'000);
    cJSON_AddNumberToObject(heartbeat.get(), "configRevision", config_get().revision);
    cJSON_AddNumberToObject(heartbeat.get(), "socketCommandSequence", socket_mqtt_sequence());
    cJSON_AddNumberToObject(
        heartbeat.get(), "lightCommandSequence", controller_mqtt_sequence(ControllerKind::Lights));
    cJSON_AddNumberToObject(heartbeat.get(),
                            "thermostatCommandSequence",
                            controller_mqtt_sequence(ControllerKind::Thermostats));
    cJSON_AddNumberToObject(heartbeat.get(),
                            "securityCommandSequence",
                            controller_mqtt_sequence(ControllerKind::Security));
    cJSON_AddNumberToObject(
        heartbeat.get(), "tankCommandSequence", controller_mqtt_sequence(ControllerKind::Tanks));
    cJSON_AddNumberToObject(heartbeat.get(),
                            "irrigationCommandSequence",
                            controller_mqtt_sequence(ControllerKind::Irrigation));
    cJSON_AddBoolToObject(heartbeat.get(), "wifiConnected", current.sta_connected);
    cJSON_AddBoolToObject(heartbeat.get(), "ethernetLinkUp", current.eth_link);
    cJSON_AddNumberToObject(heartbeat.get(), "freeHeap", esp_get_free_heap_size());
    Json metrics(system_metrics_json(), cJSON_Delete);
    // Detailed per-task diagnostics belong in /api/v1/status; keep the heartbeat bounded.
    if (metrics)
        cJSON_DeleteItemFromObjectCaseSensitive(metrics.get(), "runtime");
    if (!metrics || !cJSON_AddItemToObject(heartbeat.get(), "system", metrics.get()))
        return;
    metrics.release();
    char payload[2048];
    if (cJSON_PrintPreallocated(heartbeat.get(), payload, sizeof(payload), false)) {
        // QoS 0 + connected-only publishing: no unbounded backlog while Linux is unavailable.
        enqueue_message(client, heartbeat_topic, payload, 0, true);
    } else {
        ESP_LOGW(kTag, "System heartbeat exceeds the 2048-byte payload buffer");
    }
}

/**
 * @brief Queue changed retained snapshots and periodic refreshes for all controllers.
 * @pre Only the network manager calls this.
 * @details Ignores continuously changing ages for comparison but retains original sample times
 * and validity. A successful enqueue updates the cache; pressure/allocation failures are retried.
 * Reconnect clears the cache and unchanged topics are refreshed at least every 30 seconds.
 */
void publish_controller_status()
{
    const auto client = mqtt_client.load();
    {
        StateLock lock;
        if (client == nullptr || !status.mqtt_connected)
            return;
    }
    constexpr std::array<ControllerKind, kMqttTelemetryChannelCount> kinds{{
        ControllerKind::Sockets,
        ControllerKind::Lights,
        ControllerKind::Meteo,
        ControllerKind::Thermostats,
        ControllerKind::Security,
        ControllerKind::Tanks,
        ControllerKind::Irrigation,
    }};
    const std::array<const std::string*, kMqttTelemetryChannelCount> topics{{
        &socket_status_topic,
        &light_status_topic,
        &meteo_status_topic,
        &thermostat_status_topic,
        &security_status_topic,
        &tank_status_topic,
        &irrigation_status_topic,
    }};
    for (std::size_t index = 0; index < kinds.size(); ++index) {
        const auto kind = kinds[index];
        Json snapshot(kind == ControllerKind::Meteo ? controller_status_json(kind)
                                                    : controller_mqtt_status_json(kind),
                      cJSON_Delete);
        const auto channel = static_cast<MqttTelemetryChannel>(index);
        mqtt_telemetry_compact(channel, snapshot.get());
        const auto now_ms = esp_timer_get_time() / 1000;
        std::string key;
        if (!snapshot || !mqtt_telemetry_key(snapshot.get(), key)
            || !telemetry_cache.needs_publish(channel, key, now_ms))
            continue;
        if (!cJSON_AddStringToObject(snapshot.get(), "bootId", boot_id.c_str())
            || !cJSON_AddNumberToObject(snapshot.get(), "uptimeMs", esp_timer_get_time() / 1000))
            continue;
        char* payload = cJSON_PrintUnformatted(snapshot.get());
        if (payload != nullptr) {
            const auto& topic = *topics[index];
            if (enqueue_message(client, topic, payload, 0, true))
                telemetry_cache.accepted(channel, std::move(key), now_ms);
            cJSON_free(payload);
        }
    }
}

/**
 * @brief Send ephemeral contacts in a dedicated task without putting them in the SDK outbox.
 * @note Only this small task can wait for a QoS-0 socket write; controller and network-manager
 * loops never perform it. A retired connection never retries this message.
 */
void security_event_worker(void*)
{
    while (true) {
        pause_ms(50);
        bool ready;
        {
            StateLock lock;
            ready = status.mqtt_connected && status.socket_commands_ready;
        }
        if (!ready)
            continue;
        Json event(security_sync_take_event(esp_timer_get_time() / 1000), cJSON_Delete);
        if (!event)
            continue;
        char* raw = cJSON_PrintUnformatted(event.get());
        if (raw == nullptr)
            continue;
        const std::string payload(raw);
        cJSON_free(raw);
        const auto at = static_cast<std::int64_t>(
            cJSON_GetObjectItemCaseSensitive(event.get(), "eventAtUptimeMs")->valuedouble);
        const SecurityCommandFence fence{
            cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(event.get(), "hubEpoch")),
            static_cast<std::uint32_t>(
                cJSON_GetObjectItemCaseSensitive(event.get(), "modeRevision")->valuedouble),
            static_cast<std::uint32_t>(
                cJSON_GetObjectItemCaseSensitive(event.get(), "leaseSequence")->valuedouble)};
        // Lifetime protects the client handle, never controller or synchronization locks.
        std::lock_guard<std::mutex> lifecycle(mqtt_lifecycle_mutex);
        const auto client = mqtt_client.load();
        {
            StateLock lock;
            ready = status.mqtt_connected && status.socket_commands_ready;
        }
        const auto nowMs = esp_timer_get_time() / 1000;
        bool current;
        {
            SecuritySyncGuard sync;
            current = sync.allows_event(fence, at, nowMs);
        }
        if (!ready || client == nullptr || !current || at > nowMs || nowMs - at > 1500)
            continue;
        // Unlike enqueue(store=true), publish QoS0 never retains a packet for later reconnect.
        const int result = esp_mqtt_client_publish(client,
                                                   security_event_topic.c_str(),
                                                   payload.data(),
                                                   static_cast<int>(payload.size()),
                                                   0,
                                                   false);
        StateLock lock;
        if (result >= 0) {
            if (status.tx_queued < UINT32_MAX)
                ++status.tx_queued;
            status.last_tx_error = 0;
        } else {
            if (status.tx_dropped < UINT32_MAX)
                ++status.tx_dropped;
            status.last_tx_error = result;
        }
    }
}

/** @brief Publish one private water packet on the current connection with no offline queue.
 * @param client Stable client handle protected by mqtt_lifecycle_mutex.
 * @param topic Topic owned by this PLC.
 * @param packet Borrowed JSON measurement or request.
 * @return True when the direct QoS-0 publish succeeds.
 */
bool publish_water_packet(esp_mqtt_client_handle_t client,
                          const std::string& topic,
                          const cJSON* packet)
{
    if (!packet)
        return false;
    char* payload = cJSON_PrintUnformatted(packet);
    if (!payload)
        return false;
    const int result = esp_mqtt_client_publish(client, topic.c_str(), payload, 0, 0, false);
    cJSON_free(payload);
    return result >= 0;
}

/** @brief Exchange fresh water observations and catalogue challenges once per second.
 * @note Direct MQTT sends are isolated from autonomous controller and security-event workers.
 */
void irrigation_water_worker(void*)
{
    bool advertised_tanks = false;
    while (true) {
        pause_ms(1000);
        std::lock_guard<std::mutex> lifecycle(mqtt_lifecycle_mutex);
        const auto client = mqtt_client.load();
        bool catalogue_ready;
        {
            StateLock lock;
            if (!client || !status.mqtt_connected || !status.socket_commands_ready)
                continue;
            catalogue_ready = status.irrigation_water_subscribed;
        }
        // Prepare each message immediately before sending. QoS0 publish does not replay a
        // missed source observation or challenge when the broker next becomes available.
        if (catalogue_ready) {
            Json request(irrigation_water_request(boot_id, esp_timer_get_time()), cJSON_Delete);
            publish_water_packet(client, irrigation_water_request_topic, request.get());
        }
        Json source(irrigation_water_source(boot_id), cJSON_Delete);
        if (!source)
            continue;
        const bool has_tanks =
            cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(source.get(), "items")) > 0;
        if ((has_tanks || advertised_tanks)
            && publish_water_packet(client, irrigation_water_source_topic, source.get()))
            advertised_tanks = has_tanks;
    }
}

/**
 * @brief Report AP/LAN subnet overlap without modifying saved network settings.
 * @param[in] cfg Currently applied WiFi settings, used to check whether AP is active.
 * @pre Only the network manager calls this after netif initialization.
 * @details Reads live assigned addresses and updates only its own overlap warnings under
 * state_mutex;
 * @details other existing interface errors are preserved when overlap disappears.
 */
void check_subnets(const WifiConfig& cfg)
{
    if (!cfg.enabled || !cfg.ap.enabled)
        return;
    esp_netif_ip_info_t ap{};
    if (esp_netif_get_ip_info(ap_netif, &ap) != ESP_OK || ap.ip.addr == 0)
        return;
    const auto overlaps = [&](esp_netif_t* netif) {
        esp_netif_ip_info_t peer{};
        if (netif == nullptr || !esp_netif_is_netif_up(netif)
            || esp_netif_get_ip_info(netif, &peer) != ESP_OK || peer.ip.addr == 0)
            return false;
        const uint32_t common_mask = ap.netmask.addr & peer.netmask.addr;
        return ((ap.ip.addr ^ peer.ip.addr) & common_mask) == 0;
    };
    const bool sta_overlap = overlaps(sta_netif);
    const bool eth_overlap = overlaps(eth_netif);
    // Report ambiguity without silently changing persisted user settings.
    StateLock lock;
    const std::string warning = "AP subnet overlaps LAN subnet";
    if (sta_overlap)
        status.wifi_error = warning;
    else if (status.wifi_error == warning)
        status.wifi_error.clear();
    if (eth_overlap)
        status.eth_error = warning;
    else if (status.eth_error == warning)
        status.eth_error.clear();
}

/**
 * @brief Own interface/client lifecycles and perform deferred retries and status publishing.
 * @note The unnamed FreeRTOS task argument is unused. This task never returns.
 * @details Waits up to 200 ms for coalesced work. Applies saved changes after a one-second delay,
 * @details retains active wiring until reboot after a profile change, bounds MQTT subscription
 * retries
 * @details to three attempts, and publishes periodic snapshots independently of local control
 * loops.
 */
void network_manager(void*)
{
    runtime_task_observe(RuntimeTask::Network);
    DeviceConfig applied;
    bool have_applied = false;
    int64_t apply_at = 0;
    int64_t retry_sta_at = 0;
    int64_t heartbeat_at = 0;
    int64_t sockets_at = 0;
    int64_t subscription_at = 0;
    int64_t mqtt_retry_at = 0;
    unsigned subscription_attempts = 0;
    bool availability_pending = false;
    while (true) {
        uint32_t notifications = 0;
        xTaskNotifyWait(0, UINT32_MAX, &notifications, pdMS_TO_TICKS(200));
        int64_t now = esp_timer_get_time();
        if ((notifications & kMqttRetry) && mqtt_retry_at == 0)
            mqtt_retry_at = now + 5'000'000;
        if (notifications & kApply)
            apply_at = now + 1'000'000;
        if (notifications & kRetrySta)
            retry_sta_at = now + 5'000'000;
        if (!have_applied || (apply_at != 0 && now >= apply_at)) {
            const auto cfg = config_get();
            // An earlier queued apply must not activate settings saved for a
            // different board. Keep the applied configuration until reboot.
            if (cfg.hardware.boardId == board_profile_active().id) {
                const bool wifi_changed = !have_applied || !same_wifi(cfg.wifi, applied.wifi);
                const bool eth_changed = !have_applied || !same_eth(cfg.ethernet, applied.ethernet);
                if (wifi_changed) {
                    const esp_err_t error = apply_wifi(cfg.wifi);
                    if (error != ESP_OK)
                        set_error(&Status::wifi_error, "Wi-Fi apply", error);
                    retry_sta_at = 0;
                }
                if (eth_changed || (cfg.ethernet.enabled && eth_netif == nullptr)) {
                    const esp_err_t error = apply_ethernet(cfg.ethernet);
                    if (error != ESP_OK)
                        set_error(&Status::eth_error, "W5500 apply", error);
                }
                if (!have_applied || wifi_changed || eth_changed
                    || !same_linux(cfg.linux, applied.linux)) {
                    apply_mqtt(cfg.linux);
                    mqtt_retry_at = 0;
                }
                applied = cfg;
                have_applied = true;
                check_subnets(applied.wifi);
            }
            apply_at = 0;
        }
        now = esp_timer_get_time();
        if (retry_sta_at != 0 && now >= retry_sta_at) {
            retry_sta_at = 0;
            if (wifi_started && applied.wifi.enabled && applied.wifi.sta.enabled) {
                const esp_err_t error = esp_wifi_connect();
                if (error != ESP_OK && error != ESP_ERR_WIFI_CONN) {
                    set_error(&Status::wifi_error, "Wi-Fi reconnect", error);
                    retry_sta_at = now + 5'000'000;
                }
            }
        }
        if (notifications & kMqttOnline) {
            mqtt_retry_at = 0;
            telemetry_cache.reset();
            availability_pending = true;
            subscription_attempts = 0;
            subscription_at = now;
            heartbeat_at = 0;
            sockets_at = 0;
            const auto client = mqtt_client.load();
            esp_mqtt5_subscribe_property_config_t optional{};
            optional.retain_as_published_flag = true;
            optional.retain_handle = 2;
            if (client && esp_mqtt5_client_set_subscribe_property(client, &optional) == ESP_OK)
                static_cast<void>(esp_mqtt_client_subscribe_single(
                    client, irrigation_water_reply_topic.c_str(), 0));
        }
        if (mqtt_retry_at != 0 && now >= mqtt_retry_at) {
            bool connected;
            {
                StateLock lock;
                connected = status.mqtt_connected;
            }
            mqtt_retry_at = 0;
            if (have_applied && !connected && !applied.linux.host.empty())
                apply_mqtt(applied.linux);
        }
        if (availability_pending) {
            bool connected;
            {
                StateLock lock;
                connected = status.mqtt_connected;
            }
            const auto client = mqtt_client.load();
            if (client == nullptr || !connected)
                availability_pending = false;
            else if (enqueue_message(client, availability_topic, "online", 1, true))
                availability_pending = false;
        }
        if (notifications & (kSocketSubscribed | kSocketSubscribeFailed)) {
            StateLock lock;
            // Task notification bits can outlive the retired client. A new CONNECTED callback
            // clears these observations, so an old SUBACK must not cancel the new subscription.
            if ((notifications & kSocketSubscribed) && status.mqtt_connected
                && status.socket_commands_ready)
                subscription_at = 0;
            if ((notifications & kSocketSubscribeFailed) && status.mqtt_connected
                && status.socket_subscription_failed)
                subscription_at = now + 5'000'000;
        }
        if (subscription_at != 0 && now >= subscription_at) {
            bool connected;
            {
                StateLock lock;
                connected = status.mqtt_connected;
            }
            const auto client = mqtt_client.load();
            if (client == nullptr || !connected)
                subscription_at = 0;
            else if (subscription_attempts >= 3) {
                StateLock lock;
                status.socket_commands_ready = false;
                status.mqtt_error =
                    "Controller subscriptions failed after 3 attempts; check broker ACL/connection";
                subscription_at = 0;
            } else {
                ++subscription_attempts;
                // RAP preserves RETAIN on live deliveries; RH=2 skips stored
                // commands. Retry is bounded, including missing SUBACKs.
                esp_mqtt5_subscribe_property_config_t subscription{};
                subscription.retain_as_published_flag = true;
                subscription.retain_handle = 2;
                const esp_mqtt_topic_t topics[] = {{socket_command_topic.c_str(), 1},
                                                   {light_command_topic.c_str(), 1},
                                                   {thermostat_command_topic.c_str(), 1},
                                                   {security_command_topic.c_str(), 1},
                                                   {tank_command_topic.c_str(), 1},
                                                   {irrigation_command_topic.c_str(), 1},
                                                   {security_hub_topic.c_str(), 0},
                                                   {management_request_topic.c_str(), 1}};
                constexpr auto topic_count = static_cast<int>(sizeof(topics) / sizeof(topics[0]));
                const bool sent =
                    esp_mqtt5_client_set_subscribe_property(client, &subscription) == ESP_OK
                    && esp_mqtt_client_subscribe_multiple(client, topics, topic_count) >= 0;
                subscription_at = now + (sent ? 10'000'000 : 5'000'000);
                if (!sent) {
                    StateLock lock;
                    status.socket_commands_ready = false;
                    status.mqtt_error = "Cannot send controller command subscriptions";
                }
            }
        }
        if (notifications & kCheckSubnets)
            check_subnets(applied.wifi);
        if (now >= heartbeat_at) {
            publish_heartbeat();
            heartbeat_at = now + kHeartbeatUs;
        }
        if (now >= sockets_at) {
            publish_controller_status();
            sockets_at = now + 500'000;
        }
        const auto client = mqtt_client.load();
        if (client != nullptr) {
            const int bytes = esp_mqtt_client_get_outbox_size(client);
            StateLock lock;
            status.outbox_bytes = bytes;
        }
    }
}

/**
 * @brief Attach a nonempty diagnostic to a JSON status object.
 * @param[in,out] object Borrowed JSON object that receives the optional error property.
 * @param[in] error Diagnostic text; an empty string leaves the object unchanged.
 */
void add_error(cJSON* object, const std::string& error)
{
    if (!error.empty())
        cJSON_AddStringToObject(object, "error", error.c_str());
}

/**
 * @brief Construct one default WiFi netif using error-returning SDK primitives.
 * @param[out] netif Owned attached interface on success; nullptr on failure.
 * @param[in] access_point Whether to create the AP rather than the station interface.
 * @return ESP_OK, NO_MEM, or an attachment/event-handler registration error.
 * @note The convenience esp_netif_create_default_wifi_* helpers assert on failure. This
 * equivalent checked sequence allows startup to report a degraded service and keep local loops.
 */
esp_err_t create_wifi_netif(esp_netif_t*& netif, bool access_point)
{
    esp_netif_config_t configuration = ESP_NETIF_DEFAULT_WIFI_AP();
    if (!access_point)
        configuration = ESP_NETIF_DEFAULT_WIFI_STA();
    netif = esp_netif_new(&configuration);
    if (netif == nullptr)
        return ESP_ERR_NO_MEM;
    auto error =
        access_point ? esp_netif_attach_wifi_ap(netif) : esp_netif_attach_wifi_station(netif);
    if (error == ESP_OK)
        error = access_point ? esp_wifi_set_default_wifi_ap_handlers()
                             : esp_wifi_set_default_wifi_sta_handlers();
    if (error != ESP_OK) {
        esp_netif_destroy_default_wifi(netif);
        netif = nullptr;
    }
    return error;
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Initialize network objects once and start the configuration manager.
 * @return ESP_OK or an initialization/task allocation error.
 * @pre esp_netif_init(), the default event loop, NVS, configuration and board activation
 * have completed. Call from startup, before serving HTTP requests.
 * @note Peripheral Ethernet failure is reported asynchronously and leaves Wi-Fi available.
 * @endcond
 */
esp_err_t network_init()
{
    if (manager_task != nullptr)
        return ESP_OK;
    state_mutex = xSemaphoreCreateMutex();
    if (state_mutex == nullptr)
        return ESP_ERR_NO_MEM;
    auto error = create_wifi_netif(ap_netif, true);
    if (error == ESP_OK)
        error = create_wifi_netif(sta_netif, false);
    if (error != ESP_OK) {
        if (ap_netif != nullptr) {
            esp_netif_destroy_default_wifi(ap_netif);
            ap_netif = nullptr;
        }
        return error;
    }
    esp_netif_set_hostname(ap_netif, device_id().c_str());
    esp_netif_set_hostname(sta_netif, device_id().c_str());
    wifi_init_config_t wifi = WIFI_INIT_CONFIG_DEFAULT();
    error = esp_wifi_init(&wifi);
    if (error != ESP_OK)
        return error;
    error = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (error != ESP_OK)
        return error;
    error = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, network_event, nullptr);
    if (error != ESP_OK)
        return error;
    error = esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, network_event, nullptr);
    if (error != ESP_OK)
        return error;
    error = esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, network_event, nullptr);
    if (error != ESP_OK)
        return error;
    availability_topic = "fcplcn/" + device_id() + "/availability";
    heartbeat_topic = "fcplcn/" + device_id() + "/system/status";
    socket_command_topic = "fcplcn/" + device_id() + "/controllers/sockets/set";
    socket_ack_topic = "fcplcn/" + device_id() + "/controllers/sockets/ack";
    socket_status_topic = "fcplcn/" + device_id() + "/controllers/sockets/status";
    light_command_topic = "fcplcn/" + device_id() + "/controllers/lights/set";
    light_ack_topic = "fcplcn/" + device_id() + "/controllers/lights/ack";
    light_status_topic = "fcplcn/" + device_id() + "/controllers/lights/status";
    meteo_status_topic = "fcplcn/" + device_id() + "/controllers/meteo/status";
    thermostat_status_topic = "fcplcn/" + device_id() + "/controllers/thermostats/status";
    thermostat_command_topic = "fcplcn/" + device_id() + "/controllers/thermostats/set";
    thermostat_ack_topic = "fcplcn/" + device_id() + "/controllers/thermostats/ack";
    security_status_topic = "fcplcn/" + device_id() + "/controllers/security/status";
    security_command_topic = "fcplcn/" + device_id() + "/controllers/security/set";
    security_ack_topic = "fcplcn/" + device_id() + "/controllers/security/ack";
    security_hub_topic = "fcplcn/" + device_id() + "/controllers/security/hub";
    security_event_topic = "fcplcn/" + device_id() + "/controllers/security/event";
    tank_status_topic = "fcplcn/" + device_id() + "/controllers/tanks/status";
    tank_command_topic = "fcplcn/" + device_id() + "/controllers/tanks/set";
    tank_ack_topic = "fcplcn/" + device_id() + "/controllers/tanks/ack";
    irrigation_status_topic = "fcplcn/" + device_id() + "/controllers/irrigation/status";
    irrigation_command_topic = "fcplcn/" + device_id() + "/controllers/irrigation/set";
    irrigation_ack_topic = "fcplcn/" + device_id() + "/controllers/irrigation/ack";
    irrigation_water_request_topic = "fcplcn/" + device_id() + "/irrigation-water/request";
    irrigation_water_reply_topic = "fcplcn/" + device_id() + "/irrigation-water/reply";
    irrigation_water_source_topic = "fcplcn/" + device_id() + "/irrigation-water/source";
    management_request_topic = "fcplcn/" + device_id() + "/management/request";
    management_reply_topic = "fcplcn/" + device_id() + "/management/reply";
    char boot[24];
    std::snprintf(boot,
                  sizeof(boot),
                  "%08lx%08lx",
                  static_cast<unsigned long>(esp_random()),
                  static_cast<unsigned long>(esp_random()));
    boot_id = boot;
    security_sync_connection(false, boot_id);
    if (xTaskCreate(management_worker, "fcplcn_management", 16 * 1024, nullptr, 3, &management_task)
        != pdPASS)
        return ESP_ERR_NO_MEM;
    if (xTaskCreate(
            security_event_worker, "fcplcn_security_tx", 4096, nullptr, 3, &security_event_task)
        != pdPASS)
        return ESP_ERR_NO_MEM;
    if (xTaskCreate(
            irrigation_water_worker, "fcplcn_water_tx", 4096, nullptr, 3, &irrigation_water_task)
        != pdPASS)
        return ESP_ERR_NO_MEM;
    if (xTaskCreate(network_manager, "fcplcn_network", 8192, nullptr, 5, &manager_task) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Coalesce a request to apply the latest saved settings after the HTTP reply.
 * @note Thread-safe task-context notification; the manager delays apply by about one second.
 * A pending board-profile change is applied only at reboot.
 * @endcond
 */
void network_schedule_apply()
{
    notify_manager(kApply);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Copy current Wi-Fi, Ethernet and Linux MQTT observations without credentials.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr if the root cannot be allocated.
 * @note Thread-safe in task context after initialization; SDK observation calls may block briefly.
 * @endcond
 */
cJSON* network_status_json()
{
    const auto cfg = config_get();
    Status current;
    esp_netif_t* ethernet_netif;
    if (state_mutex != nullptr) {
        StateLock lock;
        current = status;
        ethernet_netif = eth_netif;
    } else {
        ethernet_netif = nullptr;
    }
    cJSON* root = cJSON_CreateObject();
    if (root == nullptr)
        return nullptr;
    cJSON* wifi = cJSON_AddObjectToObject(root, "wifi");
    cJSON_AddBoolToObject(wifi, "enabled", cfg.wifi.enabled);
    const bool ap_enabled = cfg.wifi.enabled && cfg.wifi.ap.enabled;
    cJSON* ap = cJSON_AddObjectToObject(wifi, "ap");
    cJSON_AddBoolToObject(ap, "enabled", ap_enabled);
    cJSON_AddStringToObject(ap, "ssid", cfg.wifi.ap.ssid.c_str());
    esp_netif_ip_info_t ap_ip{};
    if (ap_netif != nullptr && ap_enabled)
        esp_netif_get_ip_info(ap_netif, &ap_ip);
    cJSON_AddStringToObject(ap, "ip", ip_string(ap_ip.ip).c_str());
    wifi_sta_list_t stations{};
    if (ap_enabled)
        esp_wifi_ap_get_sta_list(&stations);
    cJSON_AddNumberToObject(ap, "clients", stations.num);
    uint8_t channel = static_cast<uint8_t>(cfg.wifi.ap.channel);
    wifi_second_chan_t secondary;
    if (ap_enabled)
        esp_wifi_get_channel(&channel, &secondary);
    cJSON_AddNumberToObject(ap, "channel", channel);
    cJSON* sta = cJSON_AddObjectToObject(wifi, "sta");
    const bool sta_enabled = cfg.wifi.enabled && cfg.wifi.sta.enabled;
    cJSON_AddBoolToObject(sta, "enabled", sta_enabled);
    cJSON_AddBoolToObject(sta, "connected", sta_enabled && current.sta_connected);
    cJSON_AddStringToObject(sta, "ssid", cfg.wifi.sta.ssid.c_str());
    esp_netif_ip_info_t sta_ip{};
    if (sta_netif != nullptr && sta_enabled && current.sta_connected)
        esp_netif_get_ip_info(sta_netif, &sta_ip);
    cJSON_AddStringToObject(sta, "ip", ip_string(sta_ip.ip).c_str());
    wifi_ap_record_t association{};
    if (sta_enabled && current.sta_connected && esp_wifi_sta_get_ap_info(&association) == ESP_OK) {
        cJSON_AddNumberToObject(sta, "rssi", association.rssi);
    }
    add_error(sta, current.wifi_error);

    cJSON* ethernet = cJSON_AddObjectToObject(root, "ethernet");
    cJSON_AddBoolToObject(ethernet, "enabled", cfg.ethernet.enabled);
    cJSON_AddBoolToObject(ethernet, "dhcp", cfg.ethernet.dhcp);
    cJSON_AddBoolToObject(ethernet, "linkUp", cfg.ethernet.enabled && current.eth_link);
    esp_netif_ip_info_t eth_ip{};
    esp_netif_dns_info_t dns{};
    if (ethernet_netif != nullptr && cfg.ethernet.enabled && current.eth_link) {
        esp_netif_get_ip_info(ethernet_netif, &eth_ip);
        esp_netif_get_dns_info(ethernet_netif, ESP_NETIF_DNS_MAIN, &dns);
    }
    cJSON_AddStringToObject(ethernet, "ip", ip_string(eth_ip.ip).c_str());
    cJSON_AddStringToObject(ethernet, "netmask", ip_string(eth_ip.netmask).c_str());
    cJSON_AddStringToObject(ethernet, "gateway", ip_string(eth_ip.gw).c_str());
    cJSON_AddStringToObject(ethernet, "dns", ip_string(dns.ip.u_addr.ip4).c_str());
    cJSON_AddStringToObject(ethernet, "mac", current.eth_mac.c_str());
    add_error(ethernet, current.eth_error);

    cJSON* linux = cJSON_AddObjectToObject(root, "linux");
    cJSON_AddStringToObject(linux, "host", cfg.linux.host.c_str());
    cJSON_AddNumberToObject(linux, "port", cfg.linux.port);
    cJSON_AddBoolToObject(linux, "connected", current.mqtt_connected);
    cJSON_AddBoolToObject(linux, "socketCommandsReady", current.socket_commands_ready);
    cJSON_AddBoolToObject(linux, "controllerCommandsReady", current.socket_commands_ready);
    cJSON_AddNumberToObject(linux, "txQueued", current.tx_queued);
    cJSON_AddNumberToObject(linux, "txDropped", current.tx_dropped);
    cJSON_AddNumberToObject(linux, "lastTxError", current.last_tx_error);
    cJSON_AddNumberToObject(linux, "outboxBytes", current.outbox_bytes);
    add_error(linux, current.mqtt_error);
    return root;
}
