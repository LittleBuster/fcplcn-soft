/** @file controller_irrigation.cpp
 * @brief Weekly local-time schedules with monotonic duration and an optional local tank interlock.
 */
#include "controllers/controller_internal.h"
#include <ctime>
#include <cstdio>

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {
namespace {
constexpr auto kind = ControllerKind::Irrigation;
#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
std::int64_t wallSeconds = 0;
#endif
/** @brief Validate one finite integral JSON number within inclusive bounds.
 * @param value Borrowed JSON number.
 * @param lo Minimum accepted value.
 * @param hi Maximum accepted value.
 * @return True for an in-range integer.
 */
bool integer_in(const cJSON* value, int lo, int hi)
{
    return cJSON_IsNumber(value) && value->valuedouble >= lo && value->valuedouble <= hi
           && std::floor(value->valuedouble) == value->valuedouble;
}

/** @brief Confirm a valve closed using a fresh relay reading or an explicit OFF write.
 * @param id Local relay identifier.
 * @return True when OFF is confirmed.
 */
bool close_valve(const std::string& id)
{
    HardwareIoChannelState valve{};
    return (hardware_io_read_relay(id, valve) == ESP_OK && valve.valid && valve.fresh
            && !valve.value)
           || hardware_io_set_relay(id, false) == ESP_OK;
}

/** @brief Request OFF for valves assigned by a configuration on this board.
 * @param config Irrigation settings owning the outputs.
 * @return True when all applicable valves confirm OFF.
 */
bool close_all(const Configuration& config)
{
    if (config.boardId != board_profile_active().id)
        return true;
    bool ok = true;
    for (const auto& rule : config.items) {
        if (!close_valve(rule.relayId))
            ok = false;
    }
    return ok;
}

/** @brief Limit a running valve command to its duration and any required tank observation.
 * @param rule Irrigation schedule and optional source tank.
 * @param runtime Current monotonic stop time and tank sample expiry.
 * @return Latest monotonic instant through which this rule may request its valve open.
 */
std::int64_t valve_deadline(const Item& rule, const Runtime& runtime)
{
    if (rule.tankId.empty())
        return runtime.irrigationStopUs;
    return std::min(runtime.irrigationStopUs, runtime.irrigationWaterExpiry);
}
}  // namespace

/** @brief Read one weekly schedule and its local valve and tank bindings.
 * @param json Borrowed configuration row.
 * @param[out] item Parsed settings.
 * @param backup Whether durable permission must be supplied and restored.
 * @return True for the supported input schema.
 */
bool parse_irrigation_item(const cJSON* json, Item& item, bool backup)
{
    if (!settings_json_fields(json,
                              {"id", "name", "relayId", "days", "startTime", "durationMinutes"},
                              {"tankId", "enabled"})
        || !text_field(json, "id", item.id, kSocketMaxIdBytes)
        || !text_field(json, "name", item.name, kSocketMaxNameBytes)
        || !text_field(json, "relayId", item.relayId, 32)
        || !text_field(json, "tankId", item.tankId, kIrrigationTankIdBytes, true))
        return false;
    const auto* duration = cJSON_GetObjectItemCaseSensitive(json, "durationMinutes");
    const auto* days = cJSON_GetObjectItemCaseSensitive(json, "days");
    const auto* permission = cJSON_GetObjectItemCaseSensitive(json, "enabled");
    std::string time;
    if (!integer_in(duration, 1, 1440) || !text_field(json, "startTime", time, 5)
        || time.size() != 5 || time[2] != ':')
        return false;
    for (int i : {0, 1, 3, 4})
        if (time[i] < '0' || time[i] > '9')
            return false;
    const unsigned hour = (time[0] - '0') * 10 + time[1] - '0',
                   minute = (time[3] - '0') * 10 + time[4] - '0';
    if (hour > 23 || minute > 59 || !cJSON_IsArray(days) || cJSON_GetArraySize(days) < 1
        || cJSON_GetArraySize(days) > 7 || ((permission || backup) && !cJSON_IsBool(permission)))
        return false;
    item.daysMask = 0;
    const cJSON* day;
    cJSON_ArrayForEach(day, days)
    {
        if (!integer_in(day, 1, 7))
            return false;
        const auto bit = 1u << (day->valueint - 1);
        if (item.daysMask & bit)
            return false;
        item.daysMask |= bit;
    }
    item.startMinute = hour * 60 + minute;
    item.durationMinutes = duration->valueint;
    item.enabled = backup && cJSON_IsTrue(permission);
    return true;
}

/** @brief Export durable rule settings and confirmed schedule permission.
 * @param item Configured irrigation rule.
 * @return Owned JSON object or nullptr on allocation failure.
 */
cJSON* irrigation_item_json(const Item& item)
{
    Json row(cJSON_CreateObject(), cJSON_Delete);
    char time[8];
    std::snprintf(time,
                  sizeof(time),
                  "%02u:%02u",
                  static_cast<unsigned>(item.startMinute / 60),
                  static_cast<unsigned>(item.startMinute % 60));
    if (!row || !cJSON_AddStringToObject(row.get(), "id", item.id.c_str())
        || !cJSON_AddStringToObject(row.get(), "name", item.name.c_str())
        || !cJSON_AddStringToObject(row.get(), "relayId", item.relayId.c_str())
        || !cJSON_AddStringToObject(row.get(), "tankId", item.tankId.c_str())
        || !cJSON_AddStringToObject(row.get(), "startTime", time)
        || !cJSON_AddNumberToObject(row.get(), "durationMinutes", item.durationMinutes)
        || !cJSON_AddBoolToObject(row.get(), "enabled", item.enabled))
        return nullptr;
    auto* days = cJSON_AddArrayToObject(row.get(), "days");
    if (!days)
        return nullptr;
    for (int i = 0; i < 7; ++i)
        if (item.daysMask & (1u << i)) {
            Json day(cJSON_CreateNumber(i + 1), cJSON_Delete);
            if (!day || !cJSON_AddItemToArray(days, day.get()))
                return nullptr;
            day.release();
        }
    return row.release();
}

/** @brief Cancel all active runs and close irrigation valves during a worker fault or restore.
 */
void irrigation_off_locked()
{
    const auto module = index(kind);
    for (auto& runtime : runtimes[module]) {
        runtime.irrigationStopUs = 0;
        runtime.irrigationWater = -1;
        runtime.irrigationWaterExpiry = 0;
    }
    close_all(configurations[module]);
}

/** @brief Start scheduled local runs on a minute transition, then apply valve demand with a fresh
 * water interlock.
 */
void irrigation_step_locked()
{
    const auto module = index(kind);
    const auto& config = configurations[module];
    if (config.items.empty() || config.boardId != board_profile_active().id)
        return;
    const auto now = esp_timer_get_time();
#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
    const std::time_t wall = wallSeconds;
#else
    const std::time_t wall = std::time(nullptr);
#endif
    std::tm local{};
    const bool valid = wall >= 1704067200LL && wall < 4102444800LL && localtime_r(&wall, &local);
    const auto minute = valid ? static_cast<std::int64_t>(wall) / 60 : -1;
    const int date = local.tm_year * 366 + local.tm_yday;
    auto& runtime = runtimes[module];
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& rule = config.items[i];
        auto& r = runtime[i];
        // Require an observed minute edge; booting, enabling or recovering within
        // an already-started minute must never replay the watering event.
        const bool due = valid && r.irrigationLastMinute >= 0
                         && minute == r.irrigationLastMinute + 1 && local.tm_sec < 3
                         && date > r.irrigationLastDate
                         && local.tm_hour * 60 + local.tm_min == rule.startMinute
                         && (rule.daysMask & (1u << ((local.tm_wday + 6) % 7)));
        r.irrigationLastMinute = minute;
        if (due)
            r.irrigationLastDate = date;
        const bool remote = remote_tank_id(rule.tankId);
        std::uint64_t water_generation = 0;
        r.irrigationWater =
            remote ? remote_tank_water(rule.tankId, now, r.irrigationWaterExpiry, water_generation)
                   : irrigation_tank_water(rule.tankId, r.irrigationWaterExpiry);
        const bool continuous_water = !remote || water_generation == r.irrigationWaterGeneration;
        r.irrigationWaterGeneration = water_generation;
        HardwareIoChannelState valve{};
        const bool fresh =
            hardware_io_read_relay(rule.relayId, valve) == ESP_OK && valve.valid && valve.fresh;
        if (!config.enabled || !rule.enabled)
            r.error.clear();
        else if (r.inhibited)
            r.error = r.inhibitError;
        else if (!fresh)
            r.error = "Нет подтверждения реле крана";
        else if (!valid)
            r.error = "Не установлено время PLC";
        else if (!rule.tankId.empty() && r.irrigationWater < 0)
            r.error = "Нет подтверждённых данных бака";
        else if (!rule.tankId.empty() && !r.irrigationWater)
            r.error = "В баке нет воды";
        else
            r.error.clear();
        if (!config.enabled || !rule.enabled || !r.error.empty())
            r.irrigationStopUs = 0;
        else if (due)
            r.irrigationStopUs = now + 60'000'000LL * rule.durationMinutes;
        else if (now >= r.irrigationStopUs || !continuous_water || !valve.value
                 || valve.generation != r.irrigationRelayGeneration)
            r.irrigationStopUs = 0;
        r.irrigationRelayGeneration = valve.generation;
    }
    // Aggregate demand before touching a shared valve so an idle rule can never
    // cancel another rule's run. Rules on a shared valve have the same water source.
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& id = config.items[i].relayId;
        if (std::any_of(config.items.begin(), config.items.begin() + i, [&](const Item& x) {
                return x.relayId == id;
            }))
            continue;
        std::int64_t until = 0;
        for (std::size_t j = i; j < config.items.size(); ++j)
            if (config.items[j].relayId == id)
                until = std::max(until, valve_deadline(config.items[j], runtime[j]));
        HardwareIoChannelState valve{};
        const bool fresh =
            hardware_io_read_relay(id, valve) == ESP_OK && valve.valid && valve.fresh;
        const bool desired = until > esp_timer_get_time();
        if (fresh && valve.value == desired && (desired || !until))
            continue;
        if (desired && fresh && hardware_io_set_relay_until(id, true, until) == ESP_OK)
            continue;
        const bool closed = close_valve(id);
        if (!closed || until) {
            for (std::size_t j = i; j < config.items.size(); ++j)
                if (config.items[j].relayId == id) {
                    runtime[j].irrigationStopUs = 0;
                    runtime[j].error = closed ? "Полив прерван" : "Закрытие крана не подтверждено";
                }
        }
    }
}

/** @brief Export rule settings, cached tank status and confirmed relay feedback.
 * @return Owned JSON module snapshot or nullptr on allocation failure.
 */
cJSON* irrigation_status_locked()
{
    const auto module = index(kind);
    const auto& config = configurations[module];
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddNumberToObject(root.get(), "revision", config.revision)
        || !cJSON_AddBoolToObject(root.get(), "enabled", config.enabled))
        return nullptr;
    auto* items = cJSON_AddArrayToObject(root.get(), "items");
    auto* ports = cJSON_AddObjectToObject(root.get(), "ports");
    auto* relays = ports ? cJSON_AddArrayToObject(ports, "relays") : nullptr;
    if (!items || !relays)
        return nullptr;
    const auto& board = board_profile_active();
    for (std::size_t i = 0; i < board.relayCount; ++i) {
        Json id(cJSON_CreateString(board.relays[i].name), cJSON_Delete);
        if (!id || !cJSON_AddItemToArray(relays, id.get()))
            return nullptr;
        id.release();
    }
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& rule = config.items[i];
        const auto& r = runtimes[module][i];
        Json row(irrigation_item_json(rule), cJSON_Delete);
        HardwareIoChannelState valve{};
        const bool fresh = initialized && worker_error == ESP_OK && config.boardId == board.id
                           && hardware_io_read_relay(rule.relayId, valve) == ESP_OK && valve.valid
                           && valve.fresh;
        const auto now = esp_timer_get_time();
        const auto remaining = std::max<std::int64_t>(0, r.irrigationStopUs - now);
        if (!row
            || !(fresh ? cJSON_AddBoolToObject(row.get(), "actual", remaining > 0 && valve.value)
                       : cJSON_AddNullToObject(row.get(), "actual"))
            || !(fresh ? cJSON_AddBoolToObject(row.get(), "valveActual", valve.value)
                       : cJSON_AddNullToObject(row.get(), "valveActual"))
            || !(r.irrigationWater >= 0 && r.irrigationWaterExpiry > now
                     ? cJSON_AddBoolToObject(row.get(), "waterAvailable", r.irrigationWater == 1)
                     : cJSON_AddNullToObject(row.get(), "waterAvailable"))
            || !cJSON_AddNumberToObject(
                row.get(), "remainingSeconds", (remaining + 999999) / 1000000)
            || !(r.error.empty() ? cJSON_AddNullToObject(row.get(), "error")
                                 : cJSON_AddStringToObject(row.get(), "error", r.error.c_str()))
            || !cJSON_AddItemToArray(items, row.get()))
            return nullptr;
        row.release();
    }
    return root.release();
}

/** @brief Validate and atomically replace irrigation rules after confirming assigned valves OFF.
 * @param request Revisioned replacement settings.
 * @param[out] error Failure diagnostic.
 * @return Confirmed replacement or a validation, claim, I/O or storage refusal.
 */
ControllerResult update_irrigation_locked(const cJSON* request, std::string& error)
{
    const auto module = index(ControllerKind::Irrigation);
    const auto& config = configurations[module];
    const auto* revision = cJSON_GetObjectItemCaseSensitive(request, "baseRevision");
    const auto* enabled = cJSON_GetObjectItemCaseSensitive(request, "enabled");
    const auto* items = cJSON_GetObjectItemCaseSensitive(request, "items");
    if (!settings_json_fields(request, {"baseRevision", "enabled", "items"})
        || !cJSON_IsNumber(revision) || !std::isfinite(revision->valuedouble)
        || revision->valuedouble < 1 || revision->valuedouble > UINT32_MAX
        || std::floor(revision->valuedouble) != revision->valuedouble || !cJSON_IsBool(enabled)
        || !cJSON_IsArray(items) || cJSON_GetArraySize(items) > 16)
        return SocketResult::InvalidInput;
    if (revision->valuedouble != config.revision) {
        error = "Настройки полива уже изменились. Обновите страницу.";
        return SocketResult::Conflict;
    }
    auto next = configurations;
    auto& replacement = next[module];
    replacement = Configuration{};
    replacement.boardId = board_profile_active().id;
    replacement.enabled = cJSON_IsTrue(enabled);
    replacement.revision = config.revision;
    const cJSON* json;
    cJSON_ArrayForEach(json, items)
    {
        Item item;
        if (!parse_irrigation_item(json, item)) {
            error = "Проверьте параметры правила полива";
            return SocketResult::InvalidInput;
        }
        for (const auto& old : config.items)
            if (old.id == item.id)
                item.enabled = old.enabled;
        replacement.items.push_back(std::move(item));
    }
    if (!valid_configuration(replacement, true, ControllerKind::Irrigation)) {
        error = "Проверьте бак, реле, дни, время и продолжительность полива";
        return SocketResult::InvalidInput;
    }
    if (item_count(next) > kSocketMaxItems || resource_conflict(next, true)) {
        error = "Бак удалён или реле занято другой автоматикой";
        return SocketResult::Conflict;
    }
    if (same_configuration(config, replacement)) {
        error.clear();
        return SocketResult::Ok;
    }
    if (config.revision == UINT32_MAX)
        return SocketResult::Conflict;
    ++replacement.revision;
    const auto inhibit = [&] {
        for (auto& runtime : runtimes[module]) {
            runtime.inhibited = true;
            runtime.inhibitError = "Изменение настроек не подтверждено; задан OFF";
            runtime.irrigationStopUs = 0;
        }
        close_all(config);
        close_all(replacement);
    };
    if (!close_all(config) || !close_all(replacement)) {
        inhibit();
        return unavailable(error, "Нельзя подтвердить закрытие крана перед изменением правила");
    }
    if (save(next) != ESP_OK) {
        inhibit();
        error = "Не удалось сохранить правила полива";
        return SocketResult::StorageError;
    }
    std::vector<Runtime> runtime(replacement.items.size());
    for (std::size_t i = 0; i < replacement.items.size(); ++i)
        for (std::size_t j = 0; j < config.items.size(); ++j)
            if (replacement.items[i].id == config.items[j].id) {
                runtime[i].irrigationLastDate = runtimes[module][j].irrigationLastDate;
                runtime[i].inhibited = runtimes[module][j].inhibited;
                runtime[i].inhibitError = runtimes[module][j].inhibitError;
            }
    configurations = std::move(next);
    runtimes[module] = std::move(runtime);
    const auto result = apply_relay_recovery_policies();
    if (result != ESP_OK) {
        worker_error = result;
        irrigation_off_locked();
        return unavailable(error, "Защита восстановления реле недоступна");
    }
    error.clear();
    return SocketResult::Ok;
}

/** @brief Persist a row permission without energizing a valve from the command callback.
 * @param id Irrigation rule identifier.
 * @param enabled Schedule permission.
 * @param[out] error Failure diagnostic.
 * @param limited Whether a monotonic delivery deadline is required.
 * @param deadlineMs Absolute delivery deadline in milliseconds.
 * @return Confirmed permission or a typed failure.
 */
ControllerResult irrigation_enabled_command(
    std::string_view id, bool enabled, std::string& error, bool limited, std::int64_t deadlineMs)
{
    SettingsWriteGuard mutation;
    if (!mutation)
        return SocketResult::Conflict;
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (limited
        && (deadlineMs <= 0 || deadlineMs > std::numeric_limits<std::int64_t>::max() / 1000))
        return SocketResult::Conflict;
    const auto deadline = limited ? deadlineMs * 1000 : 0;
    if (deadline_expired(deadline))
        return expired(error);
    if (!initialized || worker_error != ESP_OK)
        return unavailable(error, "Контроллер полива недоступен");
    const auto module = index(ControllerKind::Irrigation);
    for (std::size_t i = 0; i < configurations[module].items.size(); ++i) {
        if (configurations[module].items[i].id != id)
            continue;
        auto& runtime = runtimes[module][i];
        if (configurations[module].boardId != board_profile_active().id)
            return unavailable(error, "Правило относится к другой плате");
        if (enabled && configurations[module].items[i].enabled && !runtime.inhibited
            && state_storage_healthy()) {
            error.clear();
            return SocketResult::Ok;
        }
        const auto& rule = configurations[module].items[i];
        runtime.irrigationStopUs = 0;
        bool sharedDemand = false;
        for (std::size_t j = 0; j < configurations[module].items.size(); ++j)
            if (j != i && configurations[module].items[j].relayId == rule.relayId
                && valve_deadline(configurations[module].items[j], runtimes[module][j])
                       > esp_timer_get_time())
                sharedDemand = true;
        if (!sharedDemand && !close_valve(rule.relayId)) {
            runtime.inhibited = true;
            runtime.inhibitError = "Закрытие крана не подтверждено";
            return unavailable(error, runtime.inhibitError.c_str());
        }
        if (deadline_expired(deadline)) {
            runtime.inhibited = true;
            runtime.inhibitError = "Срок команды истёк до сохранения разрешения полива";
            return expired(error);
        }
        // A repeated OFF must still confirm the physical safe state, but a
        // confirmed, unchanged permission need not consume an EEPROM write cycle.
        if (!enabled && !rule.enabled && !runtime.inhibited && state_storage_healthy()) {
            error.clear();
            return SocketResult::Ok;
        }
        auto next = configurations;
        next[module].items[i].enabled = enabled;
        if (save_states(next) != ESP_OK) {
            runtime.inhibited = true;
            runtime.inhibitError = "Не удалось сохранить разрешение полива";
            error = runtime.inhibitError;
            return SocketResult::StorageError;
        }
        configurations = std::move(next);
        const auto previousDate = runtime.irrigationLastDate;
        runtime = Runtime{};
        runtime.irrigationLastDate = previousDate;
        error.clear();
        return SocketResult::Ok;
    }
    error = "Неизвестное правило полива";
    return SocketResult::NotFound;
}
}  // namespace fcplcn::controllers::detail

/** @endcond */

/** @brief Set a rule's durable schedule permission.
 * @param id Irrigation rule identifier.
 * @param enabled Schedule permission.
 * @param[out] error Failure diagnostic.
 * @return Confirmed permission or a typed failure.
 */
ControllerResult
controller_irrigation_set_enabled(std::string_view id, bool enabled, std::string& error)
{
    return fcplcn::controllers::detail::irrigation_enabled_command(id, enabled, error, false, 0);
}

/** @brief Set a rule's schedule permission before an absolute delivery deadline.
 * @param id Irrigation rule identifier.
 * @param enabled Schedule permission.
 * @param expiresAtUptimeMs Deadline in milliseconds.
 * @param[out] error Failure diagnostic.
 * @return Confirmation or a deadline/configuration/I/O/storage refusal.
 */
ControllerResult controller_irrigation_set_enabled_until(std::string_view id,
                                                         bool enabled,
                                                         std::int64_t expiresAtUptimeMs,
                                                         std::string& error)
{
    return fcplcn::controllers::detail::irrigation_enabled_command(
        id, enabled, error, true, expiresAtUptimeMs);
}

#ifdef FCPLCN_SOCKET_CONTROLLER_TESTING
/** @brief Set the deterministic wall clock for the next native worker step.
 * @param unixSeconds UTC epoch seconds.
 */
void controller_irrigation_test_clock(std::int64_t unixSeconds)
{
    fcplcn::controllers::detail::wallSeconds = unixSeconds;
}
#endif
