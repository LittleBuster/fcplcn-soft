/** @file Bounded catalogue and expiring water observations received from the local hub. */
#include "controllers/irrigation_water.h"
#include "controllers/controller_internal.h"

namespace fcplcn::controllers::detail {
namespace {
constexpr std::size_t kMaxCatalogueTanks = 96;
constexpr std::int64_t kWaterGrantUs = 3'000'000;
constexpr std::int64_t kCatalogueGraceUs = 15'000'000;
constexpr std::string_view kDevicePrefix = "fcplcn-";

struct RemoteTank {
    std::string id, name, deviceName;
    int water = -1;
    std::int64_t expiresUs = 0;
    std::uint32_t sequence = 0;
    std::uint64_t generation = 0;
};

std::mutex water_mutex;
bool connected = false;
std::uint32_t request_sequence = 0;
std::int64_t request_at = -1;
std::uint64_t water_generation = 0;
std::vector<std::string> requested_sources;
std::vector<RemoteTank> catalogue;

/** @brief Check a complete FCPLCn device identifier.
 * @param id Candidate device ID from a binding or a reply.
 * @return True for the hub's bounded device-ID alphabet and prefix.
 */
bool device_identifier(std::string_view id)
{
    return id.size() > kDevicePrefix.size() && id.size() <= kRemoteTankDeviceIdBytes
           && id.substr(0, kDevicePrefix.size()) == kDevicePrefix
           && std::all_of(id.begin() + kDevicePrefix.size(), id.end(), [](unsigned char c) {
                  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                         || c == '_' || c == '-';
              });
}

/** @brief Choose an existing row or one old, unbound row when the catalogue is full.
 * @param id Remote tank key.
 * @return Row to update, or nullptr if this round already supplied all available slots.
 * @pre Hold water_mutex.
 */
RemoteTank* catalogue_slot(std::string_view id)
{
    const auto current = std::find_if(catalogue.begin(), catalogue.end(), [&](const auto& row) {
        return row.id == id;
    });
    if (current != catalogue.end())
        return &*current;
    if (catalogue.size() < kMaxCatalogueTanks) {
        catalogue.emplace_back();
        return &catalogue.back();
    }
    auto oldest = catalogue.end();
    for (auto it = catalogue.begin(); it != catalogue.end(); ++it) {
        if (it->sequence == request_sequence
            || std::find(requested_sources.begin(), requested_sources.end(), it->id)
                   != requested_sources.end())
            continue;
        if (oldest == catalogue.end() || it->sequence < oldest->sequence)
            oldest = it;
    }
    return oldest == catalogue.end() ? nullptr : &*oldest;
}
}  // namespace

/** @brief Validate a qualified remote tank reference; the separator is forbidden in local IDs.
 * @param id Candidate reference.
 * @return True for a valid FCPLCn device ID slash a valid tank ID.
 */
bool remote_tank_id(std::string_view id)
{
    const auto slash = id.find('/');
    return slash != std::string_view::npos && device_identifier(id.substr(0, slash))
           && valid_id(id.substr(slash + 1));
}

/** @brief Read a remote water grant with both its hard deadline and continuity token.
 * @param id Qualified configuration reference.
 * @param nowUs Current PLC monotonic uptime.
 * @param[out] expiry Grant deadline, zero when no current observation is usable.
 * @param[out] generation Changes after disconnection, expiry or a different water observation.
 * @return 1 for confirmed water, 0 for dry and -1 for an unknown observation.
 */
int remote_tank_water(std::string_view id,
                      std::int64_t nowUs,
                      std::int64_t& expiry,
                      std::uint64_t& generation)
{
    expiry = 0;
    generation = 0;
    std::lock_guard<std::mutex> lock(water_mutex);
    if (!connected)
        return -1;
    for (const auto& row : catalogue) {
        if (row.id != id || nowUs >= row.expiresUs)
            continue;
        expiry = row.expiresUs;
        generation = row.generation;
        return row.water;
    }
    return -1;
}

/** @brief Append private discovery metadata to an irrigation editor snapshot.
 * @param root Existing owned irrigation JSON response.
 * @return True when the entire bounded catalogue was added.
 */
bool add_remote_tanks(cJSON* root)
{
    auto* rows = cJSON_AddArrayToObject(root, "remoteTanks");
    if (!rows)
        return false;
    std::lock_guard<std::mutex> lock(water_mutex);
    const auto now = esp_timer_get_time();
    for (const auto& tank : catalogue) {
        if (now - tank.expiresUs >= kCatalogueGraceUs)
            continue;
        Json row(cJSON_CreateObject(), cJSON_Delete);
        if (!row || !cJSON_AddStringToObject(row.get(), "id", tank.id.c_str())
            || !cJSON_AddStringToObject(row.get(), "name", tank.name.c_str())
            || !cJSON_AddStringToObject(row.get(), "deviceName", tank.deviceName.c_str())
            || !(connected && now < tank.expiresUs && tank.water >= 0
                     ? cJSON_AddBoolToObject(row.get(), "waterAvailable", tank.water == 1)
                     : cJSON_AddNullToObject(row.get(), "waterAvailable"))
            || !cJSON_AddItemToArray(rows, row.get()))
            return false;
        row.release();
    }
    return true;
}
}  // namespace fcplcn::controllers::detail

using namespace fcplcn::controllers::detail;

/** @brief Revoke all reply challenges and remote grants on a local MQTT connection change.
 * @param ready Whether a new MQTT connection has been established.
 * @note A newly connected client still needs a new challenge. Sequences survive reconnects.
 */
void irrigation_water_connection(bool ready)
{
    std::lock_guard<std::mutex> lock(water_mutex);
    connected = ready;
    request_at = -1;
    catalogue.clear();
    requested_sources.clear();
}

/** @brief Generate a challenge and prioritize sources referenced by saved irrigation rules.
 * @param bootId Technical identity of the local boot.
 * @param nowUs Monotonic uptime when a request is prepared for immediate MQTT publication.
 * @return Owned JSON payload, or nullptr if unavailable.
 */
cJSON* irrigation_water_request(std::string_view bootId, std::int64_t nowUs)
{
    std::vector<std::string> sources;
    {
        std::lock_guard<std::mutex> lock(controller_mutex);
        for (const auto& rule : configurations[index(ControllerKind::Irrigation)].items)
            if (remote_tank_id(rule.tankId)
                && std::find(sources.begin(), sources.end(), rule.tankId) == sources.end())
                sources.push_back(rule.tankId);
    }
    std::lock_guard<std::mutex> lock(water_mutex);
    if (!connected || nowUs < 0 || nowUs > INT64_MAX - kWaterGrantUs
        || request_sequence == UINT32_MAX)
        return nullptr;
    const std::string boot(bootId);
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddStringToObject(root.get(), "bootId", boot.c_str())
        || !cJSON_AddNumberToObject(root.get(), "sequence", request_sequence + 1))
        return nullptr;
    if (!sources.empty()) {
        auto* priority = cJSON_AddArrayToObject(root.get(), "sources");
        if (!priority)
            return nullptr;
        for (const auto& source : sources) {
            Json row(cJSON_CreateString(source.c_str()), cJSON_Delete);
            if (!row || !cJSON_AddItemToArray(priority, row.get()))
                return nullptr;
            row.release();
        }
    }
    ++request_sequence;
    request_at = nowUs;
    requested_sources = std::move(sources);
    catalogue.erase(std::remove_if(catalogue.begin(),
                                   catalogue.end(),
                                   [&](const auto& tank) {
                                       return nowUs - tank.expiresUs >= kCatalogueGraceUs;
                                   }),
                    catalogue.end());
    return root.release();
}

/** @brief Sample local tank availability without copying network cache into the source report.
 * @param bootId Current boot identity of the PLC that owns the physical tank inputs.
 * @return Owned JSON with sample uptime and tank rows, or nullptr on allocation failure.
 */
cJSON* irrigation_water_source(std::string_view bootId)
{
    std::lock_guard<std::mutex> lock(controller_mutex);
    const std::string boot(bootId);
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddStringToObject(root.get(), "bootId", boot.c_str())
        || !cJSON_AddNumberToObject(root.get(), "uptimeMs", esp_timer_get_time() / 1'000))
        return nullptr;
    auto* items = cJSON_AddArrayToObject(root.get(), "items");
    if (!items)
        return nullptr;
    const auto& config = configurations[index(ControllerKind::Tanks)];
    for (const auto& tank : config.items) {
        std::int64_t expiry = 0;
        const auto water = worker_error == ESP_OK ? irrigation_tank_water(tank.id, expiry) : -1;
        Json row(cJSON_CreateObject(), cJSON_Delete);
        if (!row || !cJSON_AddStringToObject(row.get(), "id", tank.id.c_str())
            || !cJSON_AddStringToObject(row.get(), "name", tank.name.c_str())
            || !(water >= 0 ? cJSON_AddBoolToObject(row.get(), "water", water == 1)
                            : cJSON_AddNullToObject(row.get(), "water"))
            || !cJSON_AddItemToArray(items, row.get()))
            return nullptr;
        row.release();
    }
    return root.release();
}

/** @brief Validate one live hub reply to the latest local request.
 * @param payload Complete bounded JSON message.
 * @param retained Broker-retained messages never grant water access.
 * @param ownId Local device ID; use a local reference for tanks connected here.
 * @param bootId Current PLC boot identity.
 * @param nowUs Monotonic time of packet reception.
 * @return True when the catalogue accepted the row exactly once this round.
 */
bool irrigation_water_receive(std::string_view payload,
                              bool retained,
                              std::string_view ownId,
                              std::string_view bootId,
                              std::int64_t nowUs)
{
    if (retained || payload.empty() || payload.size() > kIrrigationWaterReplyMaxBytes
        || !supported_json_text(payload))
        return false;
    const std::string text(payload);
    Json root(cJSON_ParseWithLengthOpts(text.c_str(), text.size() + 1, nullptr, true),
              cJSON_Delete);
    if (!root
        || !settings_json_fields(
            root.get(), {"bootId", "sequence", "source", "sourceName", "id", "name", "water"}))
        return false;
    const auto* boot = cJSON_GetObjectItemCaseSensitive(root.get(), "bootId");
    const auto* sequence = cJSON_GetObjectItemCaseSensitive(root.get(), "sequence");
    const auto* water = cJSON_GetObjectItemCaseSensitive(root.get(), "water");
    std::string source, id, name, source_name;
    if (!cJSON_IsString(boot) || bootId != boot->valuestring || !cJSON_IsNumber(sequence)
        || (!cJSON_IsBool(water) && !cJSON_IsNull(water))
        || !text_field(root.get(), "source", source, kRemoteTankDeviceIdBytes) || source == ownId
        || !device_identifier(source) || !text_field(root.get(), "id", id, kSocketMaxIdBytes)
        || !valid_id(id) || !text_field(root.get(), "name", name, kSocketMaxNameBytes)
        || !valid_name(name)
        || !text_field(root.get(), "sourceName", source_name, kSocketMaxNameBytes)
        || !valid_name(source_name))
        return false;
    id = source + '/' + id;
    std::lock_guard<std::mutex> lock(water_mutex);
    if (!connected || request_at < 0 || nowUs < request_at || nowUs - request_at >= kWaterGrantUs
        || sequence->valuedouble != request_sequence)
        return false;
    auto* row = catalogue_slot(id);
    if (!row || (row->id == id && row->sequence == request_sequence))
        return false;
    const int observed = cJSON_IsNull(water) ? -1 : cJSON_IsTrue(water) ? 1 : 0;
    // Refreshing uninterrupted wet evidence keeps an already running schedule alive.
    // A break in that evidence must never resurrect an interrupted watering run.
    const auto generation = row->id == id && row->water == observed && nowUs < row->expiresUs
                                ? row->generation
                                : ++water_generation;
    *row = RemoteTank{std::move(id),
                      std::move(name),
                      std::move(source_name),
                      observed,
                      request_at + kWaterGrantUs,
                      request_sequence,
                      generation};
    return true;
}
