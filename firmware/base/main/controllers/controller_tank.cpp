/** @file controller_tank.cpp
 * @brief Autonomous local tank level monitoring, dry-run protection and fill-valve control.
 */
#include "controllers/controller_internal.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {

/** @brief Read and validate ordered contacts without assuming missing inputs are dry.
 * @param item Local tank bindings, bottom to top.
 * @param[out] wet Logical contact closures.
 * @param[out] observations Physical observations with generation and monotonic freshness.
 * @param[out] error Failure diagnostic.
 * @return True for fresh, exclusive and physically consistent contacts.
 */
static bool tank_inputs(const Item& item,
                        std::array<bool, 3>& wet,
                        std::array<HardwareIoChannelState, 3>& observations,
                        std::string& error)
{
    bool dry_seen = false;
    for (std::size_t n = 0; n < item.levelInputs.size(); ++n) {
        const auto& id = item.levelInputs[n];
        auto& sample = observations[n];
        if (claim_count(configurations, ResourceKind::Input, id) != 1
            || hardware_io_read_input(id, sample) != ESP_OK || !sample.valid || !sample.fresh) {
            error = "Нет свежих данных датчика уровня или вход занят";
            return false;
        }
        wet[n] = input_contact_closed(id, sample.value);
        if (wet[n] && dry_seen) {
            error = "Ошибка уровней: верхний датчик мокрый, нижний сухой";
            return false;
        }
        dry_seen |= !wet[n];
    }
    error.clear();
    return true;
}

/** @brief Read the optional local outputs; an absent output is intentionally not actuated.
 * @param item Tank bindings.
 * @param[out] states Pump and valve observations.
 * @return True if each configured relay is fresh and exclusively owned.
 */
static bool tank_outputs(const Item& item, std::array<HardwareIoChannelState, 2>& states)
{
    const std::array<std::string, 2> ids{item.pumpRelayId, item.valveRelayId};
    bool ready = true;
    for (std::size_t n = 0; n < ids.size(); ++n)
        if (!ids[n].empty()
            && (claim_count(configurations, ResourceKind::Relay, ids[n]) != 1
                || hardware_io_read_relay(ids[n], states[n]) != ESP_OK || !states[n].valid
                || !states[n].fresh))
            ready = false;
    return ready;
}

/** @brief Revoke both output intents, retaining an explicit diagnostic if OFF is unconfirmed.
 * @param item Tank whose configured pump and fill valve must be safe.
 * @param[in,out] runtime Volatile diagnostic and acquisition state.
 * @return True only if all configured outputs confirmed OFF.
 */
static bool tank_off(const Item& item, Runtime& runtime)
{
    bool ok = true;
    for (const auto& id : {item.pumpRelayId, item.valveRelayId})
        if (!id.empty()) {
            HardwareIoChannelState relay;
            if (hardware_io_read_relay(id, relay) == ESP_OK && relay.valid && relay.fresh
                && !relay.value)
                continue;
            if (hardware_io_set_relay(id, false) != ESP_OK)
                ok = false;
        }
    runtime.tankHealthy = false;
    if (!ok)
        runtime.error += "; выключение реле не подтверждено";
    return ok;
}

/** @brief Force all tank outputs OFF during a pending import without altering durable settings. */
void tanks_off_locked()
{
    const auto module = index(ControllerKind::Tanks);
    for (std::size_t i = 0; i < configurations[module].items.size(); ++i) {
        auto& runtime = runtimes[module][i];
        runtime.error = "Импорт сохранён: безопасный OFF до перезагрузки";
        runtime.tankStableSinceUs = -1;
        runtime.tankAccepted = false;
        tank_off(configurations[module].items[i], runtime);
    }
}

/** @brief Advance independent drain-pump and fill-valve decisions from local debounced inputs.
 * @note A wet lowest contact permits draining. Filling depends only on the selected contact.
 * Input/relay generation changes, faults and disabled monitoring revoke both ON intents.
 */
void tanks_step_locked()
{
    const auto module = index(ControllerKind::Tanks);
    const auto& config = configurations[module];
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& item = config.items[i];
        auto& runtime = runtimes[module][i];
        if (config.boardId != board_profile_active().id)
            continue;
        if (!config.enabled || !item.enabled || runtime.inhibited || settings_restore_pending()) {
            runtime.error = runtime.inhibited ? runtime.inhibitError : "Мониторинг воды выключен";
            runtime.tankStableSinceUs = -1;
            runtime.tankWet = {};
            runtime.tankAccepted = false;
            tank_off(item, runtime);
            continue;
        }
        std::array<bool, 3> wet{};
        std::array<HardwareIoChannelState, 3> inputs{};
        std::array<HardwareIoChannelState, 2> outputs{};
        if (!tank_inputs(item, wet, inputs, runtime.error) || !tank_outputs(item, outputs)) {
            if (runtime.error.empty())
                runtime.error = "Нет свежих данных реле бака";
            runtime.tankStableSinceUs = -1;
            runtime.tankWet = {};
            runtime.tankAccepted = false;
            tank_off(item, runtime);
            continue;
        }
        std::int64_t expires = std::numeric_limits<std::int64_t>::max();
        for (std::size_t n = 0; n < item.levelInputs.size(); ++n)
            expires = std::min(expires, inputs[n].updatedAtUs + 300'000);
        const auto now = esp_timer_get_time();
        // Input observations may expire while waiting for the relay cache mutex.
        // Recheck before retaining an already-ON output as well as before new ON writes.
        if (now >= expires) {
            runtime.error = "Данные датчиков уровня устарели";
            runtime.tankStableSinceUs = -1;
            runtime.tankWet = {};
            runtime.tankAccepted = false;
            tank_off(item, runtime);
            continue;
        }
        bool epoch_changed = !runtime.tankRelaySeen;
        bool changed = runtime.tankStableSinceUs < 0 || !runtime.tankRelaySeen;
        bool new_sample = true;
        for (std::size_t n = 0; n < item.levelInputs.size(); ++n) {
            changed |= wet[n] != runtime.tankCandidate[n]
                       || inputs[n].generation != runtime.tankGeneration[n];
            epoch_changed |= inputs[n].generation != runtime.tankGeneration[n];
            new_sample &= inputs[n].updatedAtUs > runtime.tankSampleAt[n];
        }
        const std::array<std::string, 2> relay_ids{item.pumpRelayId, item.valveRelayId};
        for (std::size_t n = 0; n < 2; ++n) {
            if (!relay_ids[n].empty()) {
                changed |= outputs[n].generation != runtime.tankRelayGeneration[n];
                epoch_changed |= outputs[n].generation != runtime.tankRelayGeneration[n];
            }
            runtime.tankRelayGeneration[n] = outputs[n].generation;
        }
        runtime.tankRelaySeen = true;
        // Revoke a wet bottom contact immediately. If it bounces wet, dependent
        // irrigation rules still require a new confirmed sample before starting.
        if (!wet[0])
            runtime.tankWet[0] = false;
        if (changed) {
            runtime.tankCandidate = wet;
            runtime.tankStableSinceUs = now;
            runtime.tankSamples = 0;
            runtime.tankHealthy = false;
        }
        if (new_sample) {
            ++runtime.tankSamples;
            for (std::size_t n = 0; n < item.levelInputs.size(); ++n) {
                runtime.tankSampleAt[n] = inputs[n].updatedAtUs;
                runtime.tankGeneration[n] = inputs[n].generation;
            }
        }
        if (runtime.tankSamples < kPressConfirmSamples
            || now - runtime.tankStableSinceUs < kDebounceUs) {
            runtime.error = "Ожидается подтверждение датчиков уровня";
            // Keep an already-confirmed output only while its own controlling contact
            // is unchanged in the accepted hardware epoch. Any generation/fault resets
            // the baseline; OFF transitions never wait for the debounce interval.
            const bool accepted = runtime.tankAccepted && !epoch_changed;
            const std::array<bool, 2> keep{accepted && runtime.tankWet[0] && wet[0]
                                               && outputs[0].value,
                                           accepted && !runtime.tankWet[item.fillLevel - 1]
                                               && !wet[item.fillLevel - 1] && outputs[1].value};
            bool stopped = true;
            for (std::size_t n = 0; n < 2; ++n)
                if (!relay_ids[n].empty() && !keep[n] && outputs[n].value
                    && hardware_io_set_relay(relay_ids[n], false) != ESP_OK)
                    stopped = false;
            runtime.tankHealthy = false;
            if (epoch_changed || !stopped)
                runtime.tankAccepted = false;
            if (!stopped)
                tank_off(item, runtime);
            continue;
        }
        const std::array<bool, 2> desired{wet[0], !wet[item.fillLevel - 1]};
        bool ok = true;
        for (std::size_t n = 0; n < 2; ++n) {
            if (relay_ids[n].empty())
                continue;
            if (outputs[n].value == desired[n])
                continue;
            const auto result = desired[n]
                                    ? hardware_io_set_relay_until(relay_ids[n], true, expires)
                                    : hardware_io_set_relay(relay_ids[n], false);
            if (result != ESP_OK) {
                ok = false;
                break;
            }
        }
        if (!ok) {
            runtime.error = "Реле не подтвердило автоматику бака; задан OFF";
            runtime.tankStableSinceUs = -1;
            runtime.tankWet = {};
            runtime.tankAccepted = false;
            tank_off(item, runtime);
            continue;
        }
        runtime.tankWet = wet;
        runtime.tankHealthy = true;
        runtime.tankAccepted = true;
        runtime.error.clear();
    }
}

/** @brief Read the debounced bottom water contact with the original hardware freshness deadline.
 * @param id Linked local tank ID.
 * @param[out] expiry Monotonic sample expiry in microseconds, or zero for unavailable data.
 * @return One when wet, zero when dry, or minus one when monitoring is unavailable.
 */
int irrigation_tank_water(const std::string& id, std::int64_t& expiry)
{
    const auto module = index(ControllerKind::Tanks);
    const auto& tanks = configurations[module];
    expiry = 0;
    if (id.empty() || !tanks.enabled || tanks.boardId != board_profile_active().id)
        return -1;
    for (std::size_t n = 0; n < tanks.items.size(); ++n) {
        if (tanks.items[n].id != id)
            continue;
        const auto& state = runtimes[module][n];
        if (!tanks.items[n].enabled || state.inhibited || !state.tankAccepted
            || state.tankStableSinceUs < 0)
            return -1;
        expiry = *std::min_element(state.tankSampleAt.begin(),
                                   state.tankSampleAt.begin() + tanks.items[n].levelInputs.size())
                 + 300'000;
        if (expiry <= esp_timer_get_time())
            return -1;
        return state.tankCandidate[0] && state.tankWet[0] ? 1 : 0;
    }
    return -1;
}

/** @brief Decode strict tank settings; runtime output demand is never accepted from JSON.
 * @param json Borrowed item configuration.
 * @param[out] item Parsed settings.
 * @param backup True requires the saved monitoring permission.
 * @return True for the supported schema and typed values; bounds are checked separately.
 */
bool parse_tank_item(const cJSON* json, Item& item, bool backup)
{
    if (!settings_json_fields(
            json,
            {"id", "name", "pumpRelayId", "valveRelayId", "levelInputs", "fillLevel"},
            {"enabled"})
        || !text_field(json, "id", item.id, kSocketMaxIdBytes)
        || !text_field(json, "name", item.name, kSocketMaxNameBytes)
        || !text_field(json, "pumpRelayId", item.pumpRelayId, 32)
        || !text_field(json, "valveRelayId", item.valveRelayId, 32))
        return false;
    const auto* levels = cJSON_GetObjectItemCaseSensitive(json, "levelInputs");
    const auto* fill = cJSON_GetObjectItemCaseSensitive(json, "fillLevel");
    const auto* enabled = cJSON_GetObjectItemCaseSensitive(json, "enabled");
    if (!cJSON_IsArray(levels) || cJSON_GetArraySize(levels) < 1 || cJSON_GetArraySize(levels) > 3
        || !cJSON_IsNumber(fill) || !std::isfinite(fill->valuedouble) || fill->valuedouble < 1
        || fill->valuedouble > cJSON_GetArraySize(levels)
        || std::floor(fill->valuedouble) != fill->valuedouble || (backup && !cJSON_IsBool(enabled))
        || (enabled && !cJSON_IsBool(enabled)))
        return false;
    const cJSON* entry;
    cJSON_ArrayForEach(entry, levels)
    {
        if (!cJSON_IsString(entry) || !entry->valuestring || std::strlen(entry->valuestring) > 32)
            return false;
        item.levelInputs.emplace_back(entry->valuestring);
    }
    item.fillLevel = static_cast<unsigned>(fill->valuedouble);
    if (backup)
        item.enabled = cJSON_IsTrue(enabled);
    return true;
}

/** @brief Serialize only durable bindings and the monitoring permission.
 * @param item Tank row.
 * @return Caller-owned JSON object, or nullptr on allocation failure.
 */
cJSON* tank_item_json(const Item& item)
{
    Json json(cJSON_CreateObject(), cJSON_Delete);
    if (!json || !cJSON_AddStringToObject(json.get(), "id", item.id.c_str())
        || !cJSON_AddStringToObject(json.get(), "name", item.name.c_str())
        || !cJSON_AddStringToObject(json.get(), "pumpRelayId", item.pumpRelayId.c_str())
        || !cJSON_AddStringToObject(json.get(), "valveRelayId", item.valveRelayId.c_str())
        || !cJSON_AddBoolToObject(json.get(), "enabled", item.enabled)
        || !cJSON_AddNumberToObject(json.get(), "fillLevel", item.fillLevel))
        return nullptr;
    auto* levels = cJSON_AddArrayToObject(json.get(), "levelInputs");
    if (!levels)
        return nullptr;
    for (const auto& id : item.levelInputs) {
        Json value(cJSON_CreateString(id.c_str()), cJSON_Delete);
        if (!value || !cJSON_AddItemToArray(levels, value.get()))
            return nullptr;
        value.release();
    }
    return json.release();
}

/** @brief Report fresh discrete level estimates and physical output confirmation separately.
 * @return Caller-owned module JSON with input/relay catalogs.
 */
cJSON* tanks_status_locked()
{
    const auto module = index(ControllerKind::Tanks);
    const auto& config = configurations[module];
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddNumberToObject(root.get(), "revision", config.revision)
        || !cJSON_AddBoolToObject(root.get(), "enabled", config.enabled))
        return nullptr;
    auto* items = cJSON_AddArrayToObject(root.get(), "items");
    auto* ports = cJSON_AddObjectToObject(root.get(), "ports");
    auto* relays = ports ? cJSON_AddArrayToObject(ports, "relays") : nullptr;
    auto* inputs_catalog = ports ? cJSON_AddArrayToObject(ports, "inputs") : nullptr;
    if (!items || !relays || !inputs_catalog)
        return nullptr;
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& item = config.items[i];
        const auto& runtime = runtimes[module][i];
        std::array<bool, 3> wet{};
        std::array<HardwareIoChannelState, 3> inputs{};
        std::array<HardwareIoChannelState, 2> outputs{};
        std::string error;
        const bool input_ready = tank_inputs(item, wet, inputs, error);
        const bool output_ready = tank_outputs(item, outputs);
        bool accepted_epoch = true;
        auto fresh_until = std::numeric_limits<std::int64_t>::max();
        for (std::size_t n = 0; n < item.levelInputs.size(); ++n) {
            accepted_epoch &= inputs[n].generation == runtime.tankGeneration[n];
            fresh_until = std::min(fresh_until, inputs[n].updatedAtUs + 300'000);
        }
        if (!item.pumpRelayId.empty())
            accepted_epoch &= outputs[0].generation == runtime.tankRelayGeneration[0];
        if (!item.valveRelayId.empty())
            accepted_epoch &= outputs[1].generation == runtime.tankRelayGeneration[1];
        const bool available = initialized && worker_error == ESP_OK && config.enabled
                               && item.enabled && !runtime.inhibited && !settings_restore_pending()
                               && config.boardId == board_profile_active().id && input_ready
                               && output_ready && runtime.tankHealthy && wet == runtime.tankWet
                               && accepted_epoch && esp_timer_get_time() < fresh_until;
        if (!available && error.empty())
            error = runtime.error;
        Json json(tank_item_json(item), cJSON_Delete);
        auto* levels = json ? cJSON_AddArrayToObject(json.get(), "levelsWet") : nullptr;
        if (!levels || !cJSON_AddBoolToObject(json.get(), "available", available)
            || !(error.empty() ? cJSON_AddNullToObject(json.get(), "error")
                               : cJSON_AddStringToObject(json.get(), "error", error.c_str())))
            return nullptr;
        unsigned count = 0;
        for (std::size_t n = 0; n < item.levelInputs.size(); ++n) {
            count += wet[n];
            Json value(available ? cJSON_CreateBool(wet[n]) : cJSON_CreateNull(), cJSON_Delete);
            if (!value || !cJSON_AddItemToArray(levels, value.get()))
                return nullptr;
            value.release();
        }
        if (!(available
                  ? cJSON_AddNumberToObject(json.get(),
                                            "levelPct",
                                            std::lround(100.0 * count / item.levelInputs.size()))
                  : cJSON_AddNullToObject(json.get(), "levelPct")))
            return nullptr;
        for (std::size_t n = 0; n < 2; ++n) {
            const bool configured = !(n == 0 ? item.pumpRelayId : item.valveRelayId).empty();
            const auto* key = n == 0 ? "pumpActual" : "valveActual";
            if (!(configured && outputs[n].valid && outputs[n].fresh
                      ? cJSON_AddBoolToObject(json.get(), key, outputs[n].value)
                      : cJSON_AddNullToObject(json.get(), key)))
                return nullptr;
        }
        if (!cJSON_AddItemToArray(items, json.get()))
            return nullptr;
        json.release();
    }
    const auto& board = board_profile_active();
    for (std::size_t n = 0; n < board.relayCount; ++n) {
        Json value(cJSON_CreateString(board.relays[n].name), cJSON_Delete);
        if (!value || !cJSON_AddItemToArray(relays, value.get()))
            return nullptr;
        value.release();
    }
    for (std::size_t n = 0; n < board.inputCount; ++n) {
        Json value(cJSON_CreateString(board.inputs[n].name), cJSON_Delete);
        if (!value || !cJSON_AddItemToArray(inputs_catalog, value.get()))
            return nullptr;
        value.release();
    }
    return root.release();
}

/** @brief Validate and atomically replace tank configuration after confirming both outputs OFF.
 * @param request Revisioned replacement settings.
 * @param[out] error Failure diagnostic.
 * @return Confirmed replacement or a validation, claim, I/O or storage refusal.
 */
ControllerResult update_tanks_locked(const cJSON* request, std::string& error)
{
    const auto module = index(ControllerKind::Tanks);
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
    if (revision->valuedouble != config.revision)
        return SocketResult::Conflict;
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
        if (!parse_tank_item(json, item))
            return SocketResult::InvalidInput;
        for (const auto& old : config.items)
            if (old.id == item.id)
                item.enabled = old.enabled;
        replacement.items.push_back(std::move(item));
    }
    if (!valid_configuration(replacement, true, ControllerKind::Tanks)) {
        error = "Выберите от одного до трёх входов по порядку снизу вверх и уровень наполнения";
        return SocketResult::InvalidInput;
    }
    if (item_count(next) > kSocketMaxItems || resource_conflict(next, true)) {
        error =
            "Проверьте назначения реле и входов. Бак, выбранный для полива, можно удалить после перенастройки правил.";
        return SocketResult::Conflict;
    }
    if (same_configuration(config, replacement)) {
        error.clear();
        return SocketResult::Ok;
    }
    if (config.revision == UINT32_MAX)
        return SocketResult::Conflict;
    ++replacement.revision;
    const auto stop = [&](const Configuration& settings) {
        bool ok = true;
        for (const auto& item : settings.items)
            for (const auto& id : {item.pumpRelayId, item.valveRelayId})
                if (!id.empty() && hardware_io_set_relay(id, false) != ESP_OK)
                    ok = false;
        return ok;
    };
    const auto inhibit = [&] {
        for (auto& runtime : runtimes[module]) {
            runtime.inhibited = true;
            runtime.inhibitError = "Изменение настроек не подтверждено; задан OFF";
            runtime.tankStableSinceUs = -1;
        }
        stop(config);
        stop(replacement);
    };
    if (!stop(config) || !stop(replacement)) {
        inhibit();
        return unavailable(error, "Нельзя подтвердить OFF перед изменением бака");
    }
    if (save(next) != ESP_OK) {
        inhibit();
        error = "Не удалось сохранить баки";
        return SocketResult::StorageError;
    }
    std::vector<Runtime> runtime(replacement.items.size());
    for (std::size_t i = 0; i < replacement.items.size(); ++i)
        for (std::size_t j = 0; j < config.items.size(); ++j)
            if (replacement.items[i].id == config.items[j].id) {
                runtime[i].inhibited = runtimes[module][j].inhibited;
                runtime[i].inhibitError = runtimes[module][j].inhibitError;
            }
    configurations = std::move(next);
    runtimes[module] = std::move(runtime);
    const auto result = apply_relay_recovery_policies();
    if (result != ESP_OK) {
        worker_error = result;
        tanks_off_locked();
        return unavailable(error, "Защита восстановления реле недоступна");
    }
    error.clear();
    return SocketResult::Ok;
}

/** @brief Persist a row permission without energizing either output from the command callback.
 * @param id Tank identifier.
 * @param enabled Monitoring permission.
 * @param[out] error Failure diagnostic.
 * @param limited Whether a monotonic delivery deadline is required.
 * @param deadlineMs Absolute delivery deadline in milliseconds.
 * @return Confirmed permission or a typed failure.
 */
ControllerResult tank_enabled_command(
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
        return unavailable(error, "Контроллер бака недоступен");
    const auto module = index(ControllerKind::Tanks);
    for (std::size_t i = 0; i < configurations[module].items.size(); ++i) {
        if (configurations[module].items[i].id != id)
            continue;
        auto& runtime = runtimes[module][i];
        if (configurations[module].boardId != board_profile_active().id)
            return unavailable(error, "Бак относится к другой плате");
        if (enabled && configurations[module].items[i].enabled && !runtime.inhibited
            && state_storage_healthy()) {
            error.clear();
            return SocketResult::Ok;
        }
        if (!tank_off(configurations[module].items[i], runtime)) {
            runtime.inhibited = true;
            runtime.inhibitError = "Выключение выходов бака не подтверждено";
            return unavailable(error, runtime.inhibitError.c_str());
        }
        if (deadline_expired(deadline)) {
            runtime.inhibited = true;
            runtime.inhibitError = "Срок команды истёк до сохранения; удерживается OFF";
            return expired(error);
        }
        auto next = configurations;
        next[module].items[i].enabled = enabled;
        if (save_states(next) != ESP_OK) {
            runtime.inhibited = true;
            runtime.inhibitError = "Не удалось сохранить мониторинг бака";
            error = runtime.inhibitError;
            return SocketResult::StorageError;
        }
        configurations = std::move(next);
        runtime = Runtime{};
        error.clear();
        return SocketResult::Ok;
    }
    error = "Неизвестный бак";
    return SocketResult::NotFound;
}
}  // namespace fcplcn::controllers::detail

/** @endcond */

/** @brief Set a tank's durable monitoring permission.
 * @param id Tank identifier.
 * @param enabled Monitoring permission.
 * @param[out] error Failure diagnostic.
 * @return Confirmed permission or a typed failure.
 */
ControllerResult controller_tank_set_enabled(std::string_view id, bool enabled, std::string& error)
{
    return fcplcn::controllers::detail::tank_enabled_command(id, enabled, error, false, 0);
}

/** @brief Set a tank's monitoring permission before an absolute delivery deadline.
 * @param id Tank identifier.
 * @param enabled Monitoring permission.
 * @param expiresAtUptimeMs Deadline in milliseconds.
 * @param[out] error Failure diagnostic.
 * @return Confirmation or a deadline/configuration/I/O/storage refusal.
 */
ControllerResult controller_tank_set_enabled_until(std::string_view id,
                                                   bool enabled,
                                                   std::int64_t expiresAtUptimeMs,
                                                   std::string& error)
{
    return fcplcn::controllers::detail::tank_enabled_command(
        id, enabled, error, true, expiresAtUptimeMs);
}
