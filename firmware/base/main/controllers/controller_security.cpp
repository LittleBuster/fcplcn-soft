/**
 * @file controller_security.cpp
 * @brief Autonomous intrusion detection, iButton permissions and confirmed siren control.
 * @details Monotonic entry/exit countdowns are RAM-only. Confirmed armed/alarm flags live in
 * FRAM, so reboot never grants a fresh exit delay or silently clears an existing alarm.
 */
#include "controllers/controller_internal.h"

#include "sensors/ibutton.h"
#include "controllers/security_sync.h"

/** @cond FCPLCN_CONTROLLER_INTERNALS */
namespace fcplcn::controllers::detail {
namespace {
constexpr std::size_t kMaxSecurityZones = 16;
constexpr std::size_t kMaxSecurityKeys = 16;
constexpr std::int64_t kSecuritySettleUs = 300'000;
constexpr std::int64_t kReaderFreshMs = 1'000;
constexpr std::int64_t kKeyEventFreshMs = 500;
constexpr std::int64_t kEnrollmentUs = 30'000'000;

/** @brief Distinct-sample input debounce state with honest missing/recovery observations. */
struct SecurityZoneRuntime {
    HardwareIoChannelState input;
    std::uint32_t generation = 0;
    std::int64_t lastSampleUs = -1;
    std::int64_t settlingUntilUs = 0;
    unsigned candidateSamples = 0;
    bool candidate = false;
    bool stable = false;
    bool level = false;
    bool available = false;
    std::string error;
};

/** @brief Volatile alarm timing, reader anti-replay baseline and explicit fault recovery state. */
struct SecurityRuntime {
    std::vector<SecurityZoneRuntime> zones;
    std::int64_t bootGraceUntilUs = 0;
    std::int64_t exitUntilUs = 0;
    std::int64_t entryUntilUs = 0;
    std::int64_t enrollmentUntilUs = 0;
    std::int64_t persistenceRetryAtUs = 0;
    std::int64_t sirenRetryAtUs = 0;
    std::uint64_t readerGeneration = 0;
    std::uint64_t consumedEvent = 0;
    bool readerBaseline = false;
    bool pendingAlarm = false;
    bool disarmInhibited = false;
    bool sirenError = false;
    std::string alarmReason;
    std::string storageError;
    std::string outputError;
    std::string lastKeyName;
    std::string lastKeyError;
};

SecurityRuntime security_runtime;

/**
 * @brief Borrow the security module selected by its stable controller index.
 * @return Mutable security configuration; lifetime follows the shared configuration array.
 * @pre Hold controller_mutex.
 */
Configuration& security_configuration()
{
    return configurations[index(ControllerKind::Security)];
}

/**
 * @brief Decide whether a physical reader snapshot is fresh enough for key authorization.
 * @param[in] reading Borrowed acquisition snapshot.
 * @param[in] nowMs Current ESP uptime in milliseconds.
 * @return True for a healthy nonfuture sample no more than one second old.
 */
bool security_reader_fresh(const IbuttonReading& reading, std::int64_t nowMs)
{
    return reading.available && reading.updatedAtMs >= 0 && reading.updatedAtMs <= nowMs
           && nowMs - reading.updatedAtMs <= kReaderFreshMs;
}

/**
 * @brief Require a new physical release before any pending key can authorize another transition.
 * @pre Hold controller_mutex; this cache-only driver operation performs no bus I/O.
 */
void security_reader_barrier()
{
    ibutton_require_release();
    const auto reader = ibutton_read();
    security_runtime.readerGeneration = reader.generation;
    security_runtime.consumedEvent = reader.eventSequence;
    security_runtime.readerBaseline = true;
}

/**
 * @brief Translate a confirmed input level using the selected normally-closed/open zone type.
 * @param[in] item Zone type and binding.
 * @param[in] level Raw digital HIGH/LOW after three distinct confirming observations.
 * @return True for open reed contacts or closed motion-detector contacts.
 */
bool security_active(const Item& item, bool level)
{
    return item.securityType == SecuritySensorType::Reed ? level : !level;
}

/**
 * @brief Update all zone caches without generating edges from duplicate or recovered samples.
 * @param[in] nowUs Current monotonic uptime in microseconds.
 * @pre Hold controller_mutex.
 */
void sample_security_zones(std::int64_t nowUs)
{
    const auto& config = security_configuration();
    if (security_runtime.zones.size() != config.items.size())
        security_runtime.zones.assign(config.items.size(), SecurityZoneRuntime{});
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        auto& runtime = security_runtime.zones[i];
        HardwareIoChannelState input;
        const auto result = hardware_io_read_input(config.items[i].inputId, input);
        runtime.input = input;
        runtime.available = result == ESP_OK && input.valid && input.fresh;
        if (!runtime.available) {
            runtime.stable = false;
            runtime.candidateSamples = 0;
            runtime.lastSampleUs = -1;
            runtime.error = "Нет свежих данных входа";
            continue;
        }
        if (runtime.lastSampleUs < 0 || runtime.generation != input.generation
            || input.updatedAtUs < runtime.lastSampleUs) {
            runtime.generation = input.generation;
            runtime.lastSampleUs = input.updatedAtUs;
            runtime.candidate = input.value;
            runtime.candidateSamples = 1;
            runtime.stable = false;
            runtime.settlingUntilUs = nowUs + kSecuritySettleUs;
        } else if (input.updatedAtUs > runtime.lastSampleUs) {
            runtime.lastSampleUs = input.updatedAtUs;
            if (runtime.candidate != input.value) {
                runtime.candidate = input.value;
                runtime.candidateSamples = 1;
            } else if (runtime.candidateSamples < kPressConfirmSamples)
                ++runtime.candidateSamples;
            if (runtime.candidateSamples >= kPressConfirmSamples) {
                runtime.stable = true;
                runtime.level = runtime.candidate;
            }
        }
        runtime.error = runtime.stable ? "" : "Ожидается подтверждение уровня входа";
    }
}

/**
 * @brief Read the current siren output without assuming an unavailable relay is OFF.
 * @param[out] relay Fresh physical readback when available.
 * @return True only for a known, valid and fresh assigned relay.
 * @pre Hold controller_mutex.
 */
bool security_siren_read(HardwareIoChannelState& relay)
{
    const auto& id = security_configuration().security.sirenRelayId;
    return !id.empty() && hardware_io_read_relay(id, relay) == ESP_OK && relay.valid && relay.fresh;
}

/**
 * @brief Explain why a new arming command cannot be accepted yet.
 * @param[in] allowActive True during a configured exit delay; healthy active zones may then close.
 * @return Empty text when all required resources are ready, otherwise the first blocking reason.
 * @pre Hold controller_mutex after sampling zone inputs.
 */
std::string security_arm_block(bool allowActive)
{
    const auto& config = security_configuration();
    if (!initialized || worker_error != ESP_OK || config.boardId != board_profile_active().id)
        return "Контроллер охраны недоступен для активной платы";
    if (!config.enabled)
        return "Модуль охраны выключен";
    if (config.items.empty())
        return "Добавьте хотя бы один датчик охраны";
    HardwareIoChannelState relay;
    if (!config.security.sirenRelayId.empty() && !security_siren_read(relay))
        return "Нет свежего подтверждения реле сирены";
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& zone = security_runtime.zones[i];
        if (!zone.available || !zone.stable)
            return "Нет подтверждённого уровня: " + config.items[i].name;
        if (!allowActive && security_active(config.items[i], zone.level))
            return "Датчик сработал: " + config.items[i].name;
    }
    return {};
}

/**
 * @brief Persist a latched alarm without writing the rarely changing flash configuration.
 * @param[in] nowUs Current monotonic uptime used to bound repeated failed FRAM attempts.
 * @pre Hold controller_mutex and the outer settings writer guard.
 */
void persist_security_alarm(std::int64_t nowUs)
{
    auto& config = security_configuration();
    if (!security_runtime.pendingAlarm || config.triggered
        || nowUs < security_runtime.persistenceRetryAtUs)
        return;
    Configurations next = configurations;
    next[index(ControllerKind::Security)].triggered = true;
    if (save_states(next) == ESP_OK) {
        config.triggered = true;
        security_runtime.pendingAlarm = false;
        security_runtime.storageError.clear();
    } else {
        security_runtime.storageError = "Тревога активна, но её сохранение во FRAM не подтверждено";
        security_runtime.persistenceRetryAtUs = esp_timer_get_time() + kRetryUs;
    }
}

/**
 * @brief Persist an intrusion marker before granting its one volatile entry grace period.
 * @param[in] reason Delayed zone identifying the pending intrusion.
 * @param[in] nowUs Current monotonic uptime.
 * @pre Hold controller_mutex and the settings writer guard.
 * @note Reboot loses only the grace timer: the durable marker restores an immediate alarm.
 * Failed FRAM verification grants no quiet grace and leaves an immediate pending alarm.
 */
void begin_security_entry(const std::string& reason, std::int64_t nowUs)
{
    security_runtime.alarmReason = reason;
    security_runtime.pendingAlarm = true;
    security_runtime.persistenceRetryAtUs = 0;
    persist_security_alarm(nowUs);
    security_runtime.entryUntilUs =
        security_configuration().triggered && !security_runtime.pendingAlarm
            ? esp_timer_get_time()
                  + security_configuration().security.entryDelaySeconds * 1'000'000LL
            : 0;
}

/**
 * @brief Latch an intrusion/fault locally before attempting its durable FRAM record.
 * @param[in] reason Human-readable zone or hardware fault causing the alarm.
 * @param[in] nowUs Current monotonic uptime.
 * @pre Hold controller_mutex and the outer settings writer guard.
 */
void trigger_security_alarm(const std::string& reason, std::int64_t nowUs)
{
    if (security_runtime.disarmInhibited)
        return;
    if (!security_configuration().triggered && !security_runtime.pendingAlarm) {
        security_runtime.alarmReason = reason;
        security_runtime.persistenceRetryAtUs = 0;
    }
    security_runtime.pendingAlarm = !security_configuration().triggered;
    security_runtime.entryUntilUs = 0;
    security_runtime.exitUntilUs = 0;
    persist_security_alarm(nowUs);
}

/**
 * @brief Request the autonomous siren target with bounded retries and honest readback errors.
 * @param[in] on Latched-alarm demand, never a remotely queued raw relay ON.
 * @param[in] nowUs Current monotonic uptime for retry pacing.
 * @pre Hold controller_mutex.
 */
void drive_security_siren(bool on, std::int64_t nowUs)
{
    const auto& id = security_configuration().security.sirenRelayId;
    if (id.empty())
        return;
    HardwareIoChannelState observed;
    const bool ready = security_siren_read(observed);
    if (ready && observed.value == on) {
        security_runtime.sirenError = false;
        security_runtime.outputError.clear();
        security_runtime.sirenRetryAtUs = 0;
        return;
    }
    if (nowUs < security_runtime.sirenRetryAtUs)
        return;
    const auto result = hardware_io_set_relay(id, on);
    security_runtime.sirenError = result != ESP_OK;
    security_runtime.outputError = result == ESP_OK ? ""
                                   : on             ? "Включение сирены не подтверждено"
                                                    : "Выключение сирены не подтверждено";
    security_runtime.sirenRetryAtUs = result == ESP_OK ? 0 : esp_timer_get_time() + kRetryUs;
}

/**
 * @brief Consume one driver-confirmed physical iButton touch, including ignored/enrollment events.
 * @param[in] nowUs Current monotonic uptime.
 * @pre Hold controller_mutex and the outer settings writer guard.
 */
void process_security_key(std::int64_t nowUs)
{
    const auto reader = ibutton_read();
    if (!security_runtime.readerBaseline
        || reader.generation != security_runtime.readerGeneration) {
        security_runtime.readerBaseline = true;
        security_runtime.readerGeneration = reader.generation;
        security_runtime.consumedEvent = reader.eventSequence;
        return;
    }
    if (reader.eventSequence <= security_runtime.consumedEvent)
        return;
    security_runtime.consumedEvent = reader.eventSequence;
    const auto nowMs = nowUs / 1000;
    if (security_runtime.enrollmentUntilUs > nowUs || !security_reader_fresh(reader, nowMs)
        || reader.eventAtMs < 0 || reader.eventAtMs > nowMs
        || nowMs - reader.eventAtMs > kKeyEventFreshMs)
        return;
    const auto& config = security_configuration();
    if (!config.enabled || config.boardId != board_profile_active().id)
        return;
    const auto key = std::find_if(
        config.security.keys.begin(), config.security.keys.end(), [&](const auto& item) {
            return item.address == reader.eventAddress;
        });
    if (key == config.security.keys.end()) {
        security_runtime.lastKeyName.clear();
        security_runtime.lastKeyError = "Неизвестный ключ iButton";
        return;
    }
    security_runtime.lastKeyName = key->name;
    SecuritySyncGuard sync;
    const auto plan = sync.plan(config.armed, nowMs, reader.eventAtMs);
    if (plan.busy) {
        security_runtime.lastKeyError = "Выполняется сценарий дома; повторите прикладывание позже";
        return;
    }
    std::string error;
    const bool applied =
        set_security_armed_locked(
            plan.value, error, plan.coordinated ? plan.expiresAtUptimeMs * 1000 : 0)
        == SocketResult::Ok;
    const bool queued = sync.record(
        plan, key->id, key->name, reader.eventAtMs, esp_timer_get_time() / 1000, applied);
    if (applied && (!plan.coordinated || queued))
        security_runtime.lastKeyError.clear();
    else if (applied)
        security_runtime.lastKeyError =
            "Локальное состояние изменено; событие для хаба не отправлено";
    else
        security_runtime.lastKeyError = error;
}

/**
 * @brief Decode a bounded integral countdown parameter from a strict JSON object.
 * @param[in] request Borrowed security configuration.
 * @param[in] name Required field name.
 * @param[out] value Parsed 0..300 second value on success.
 * @return True for a finite integral number in the supported interval.
 */
bool security_delay(const cJSON* request, const char* name, std::uint16_t& value)
{
    const auto* field = cJSON_GetObjectItemCaseSensitive(request, name);
    if (!cJSON_IsNumber(field) || !std::isfinite(field->valuedouble) || field->valuedouble < 0
        || field->valuedouble > 300 || std::floor(field->valuedouble) != field->valuedouble)
        return false;
    value = static_cast<std::uint16_t>(field->valuedouble);
    return true;
}

/**
 * @brief Append one immutable profile resource name to a caller-owned JSON catalog.
 * @param[in,out] array Existing JSON array.
 * @param[in] name Static profile name copied into a new JSON string.
 * @return True after allocation and successful attachment.
 */
bool security_add_port(cJSON* array, const char* name)
{
    Json value(cJSON_CreateString(name), cJSON_Delete);
    if (!value || !cJSON_AddItemToArray(array, value.get()))
        return false;
    value.release();
    return true;
}
}  // namespace

/**
 * @brief Return the portable JSON spelling of a supported digital security detector type.
 * @param[in] type Reed-contact or motion-detector contact policy.
 * @return Borrowed process-lifetime spelling.
 */
const char* security_type_id(SecuritySensorType type)
{
    return type == SecuritySensorType::Motion ? "motion" : "reed";
}

/**
 * @brief Validate and canonicalize a DS1990A-family iButton wire-order ROM.
 * @param[in,out] address Sixteen hex characters; converted to lowercase only on success.
 * @return True for family 0x01 and a valid Dallas CRC-8 over all eight ROM bytes.
 */
bool normalize_security_address(std::string& address)
{
    if (address.size() != 16)
        return false;
    std::array<std::uint8_t, 8> bytes{};
    std::string normalized;
    normalized.reserve(16);
    for (std::size_t i = 0; i < address.size(); ++i) {
        const auto ch = address[i];
        const auto value = ch >= '0' && ch <= '9'   ? ch - '0'
                           : ch >= 'a' && ch <= 'f' ? ch - 'a' + 10
                           : ch >= 'A' && ch <= 'F' ? ch - 'A' + 10
                                                    : -1;
        if (value < 0)
            return false;
        bytes[i / 2] |= static_cast<std::uint8_t>(value << (i % 2 == 0 ? 4 : 0));
        normalized.push_back("0123456789abcdef"[value]);
    }
    if (bytes[0] != 0x01 || fcplcn::util::crc8_dallas(bytes.data(), bytes.size()) != 0)
        return false;
    address = std::move(normalized);
    return true;
}

/**
 * @brief Reset volatile countdowns/debounce without clearing confirmed FRAM armed/alarm flags.
 * @pre Hold controller_mutex; hardware and the driver may retain their own caches.
 */
void reset_security_runtime()
{
    security_runtime = SecurityRuntime{};
    security_runtime.bootGraceUntilUs = esp_timer_get_time() + kSecuritySettleUs;
    security_runtime.zones.assign(security_configuration().items.size(), SecurityZoneRuntime{});
}

/**
 * @brief Apply the committed reader binding and start a new safe input/event baseline.
 * @pre Hold controller_mutex after a successful configuration commit or during startup.
 * @note Reader acquisition may run while disarmed so key enrollment needs no temporary arming.
 */
void apply_security_config()
{
    reset_security_runtime();
    const auto& config = security_configuration();
    ibutton_configure(config.boardId == board_profile_active().id ? config.security.readerPortId
                                                                  : "");
    security_reader_barrier();
}

/**
 * @brief Confirm an explicit arm/disarm permission and store its flags only in FRAM.
 * @param[in] armed Requested confirmed permission; disarming also clears latched alarm state.
 * @param[out] error Failure diagnostic, cleared on success.
 * @param[in] deadlineUs Optional command-delivery deadline; zero means no deadline.
 * @return Confirmation, disabled/unavailable/conflict, or durable-state failure.
 * @pre Hold controller_mutex and the settings writer guard.
 * @note An authorized but unpersisted disarm holds the physical siren OFF and reports failure;
 * the durable permission remains unchanged and will be restored after reboot.
 */
ControllerResult set_security_armed_locked(bool armed, std::string& error, std::int64_t deadlineUs)
{
    if (deadline_expired(deadlineUs))
        return expired(error);
    auto& config = security_configuration();
    if (!initialized || worker_error != ESP_OK || config.boardId != board_profile_active().id)
        return unavailable(error, "Охрана недоступна для активной платы");
    const auto nowUs = esp_timer_get_time();
    sample_security_zones(nowUs);
    if (deadline_expired(deadlineUs))
        return expired(error);
    const bool changed = config.armed != armed || (!armed && config.triggered)
                         || security_runtime.pendingAlarm || security_runtime.disarmInhibited
                         || !state_storage_healthy();
    if (armed && (!config.armed || security_runtime.disarmInhibited)) {
        error = security_arm_block(config.security.exitDelaySeconds != 0);
        if (deadline_expired(deadlineUs))
            return expired(error);
        if (!error.empty())
            return config.enabled ? SocketResult::Unavailable : SocketResult::Disabled;
    }
    if (armed && config.armed && !changed) {
        error.clear();
        return SocketResult::Ok;
    }
    if (!armed) {
        security_runtime.disarmInhibited = true;
        if (!config.security.sirenRelayId.empty()
            && hardware_io_set_relay(config.security.sirenRelayId, false) != ESP_OK) {
            security_runtime.outputError = "Снятие запрошено, но выключение сирены не подтверждено";
            return unavailable(error, security_runtime.outputError.c_str());
        }
        if (deadline_expired(deadlineUs)) {
            error = "Срок команды истёк до сохранения снятия; сирена удерживается выключенной";
            security_runtime.storageError = error;
            return SocketResult::Conflict;
        }
    }
    if (changed) {
        Configurations next = configurations;
        auto& replacement = next[index(ControllerKind::Security)];
        replacement.armed = armed;
        replacement.triggered = armed && (config.triggered || security_runtime.pendingAlarm);
        if (deadline_expired(deadlineUs))
            return expired(error);
        if (save_states(next) != ESP_OK) {
            error =
                armed
                    ? "Не удалось сохранить постановку на охрану во FRAM"
                    : "Снятие не сохранено: сирена удерживается выключенной, после перезапуска охрана восстановится";
            security_runtime.storageError = error;
            security_reader_barrier();
            return SocketResult::StorageError;
        }
        const bool startExit = armed && (!config.armed || security_runtime.disarmInhibited);
        config.armed = replacement.armed;
        config.triggered = replacement.triggered;
        security_runtime.pendingAlarm = false;
        if (startExit) {
            security_runtime.entryUntilUs = 0;
            security_runtime.exitUntilUs =
                !config.triggered
                    ? esp_timer_get_time() + config.security.exitDelaySeconds * 1'000'000LL
                    : 0;
            security_runtime.enrollmentUntilUs = 0;
        }
    }
    if (!armed) {
        security_runtime.entryUntilUs = 0;
        security_runtime.exitUntilUs = 0;
        security_runtime.alarmReason.clear();
    }
    security_runtime.disarmInhibited = false;
    security_runtime.storageError.clear();
    security_runtime.outputError.clear();
    security_runtime.sirenError = false;
    security_runtime.sirenRetryAtUs = 0;
    security_runtime.persistenceRetryAtUs = 0;
    security_reader_barrier();
    error.clear();
    return SocketResult::Ok;
}

/**
 * @brief Advance local guard delays, latched intrusion detection, key permissions and siren I/O.
 * @pre Hold controller_mutex and an outer settings writer guard; invoke every worker iteration.
 * @note Input faults and immediate zones bypass entry delay. Closing a delayed zone never
 * cancels its countdown; only confirmed disarming clears the pending intrusion.
 */
void security_step_locked()
{
    const auto nowUs = esp_timer_get_time();
    sample_security_zones(nowUs);
    process_security_key(nowUs);
    auto& config = security_configuration();
    if (!config.enabled || config.boardId != board_profile_active().id || !config.armed
        || security_runtime.disarmInhibited) {
        drive_security_siren(false, nowUs);
        return;
    }
    if ((config.triggered || security_runtime.pendingAlarm) && security_runtime.entryUntilUs == 0) {
        persist_security_alarm(nowUs);
        drive_security_siren(true, nowUs);
        return;
    }
    if (security_runtime.exitUntilUs > nowUs) {
        drive_security_siren(false, nowUs);
        return;
    }
    const bool exitFinished = security_runtime.exitUntilUs != 0;
    security_runtime.exitUntilUs = 0;
    if (security_runtime.entryUntilUs && nowUs >= security_runtime.entryUntilUs)
        trigger_security_alarm("Истекла задержка входа", nowUs);
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& item = config.items[i];
        const auto& zone = security_runtime.zones[i];
        if (!zone.available || !zone.stable) {
            if (exitFinished
                || (nowUs >= security_runtime.bootGraceUntilUs
                    && (!zone.available || nowUs >= zone.settlingUntilUs)))
                trigger_security_alarm("Неисправность входа: " + item.name, nowUs);
            continue;
        }
        if (!security_active(item, zone.level))
            continue;
        if (exitFinished || !item.entryDelay || config.security.entryDelaySeconds == 0)
            trigger_security_alarm("Сработал датчик: " + item.name, nowUs);
        else if (!config.triggered && !security_runtime.pendingAlarm
                 && security_runtime.entryUntilUs == 0)
            begin_security_entry("Вход: " + item.name, nowUs);
    }
    HardwareIoChannelState relay;
    if (!config.security.sirenRelayId.empty() && nowUs >= security_runtime.bootGraceUntilUs
        && !security_siren_read(relay))
        trigger_security_alarm("Нет подтверждения реле сирены", nowUs);
    persist_security_alarm(nowUs);
    drive_security_siren((config.triggered || security_runtime.pendingAlarm)
                             && security_runtime.entryUntilUs == 0,
                         nowUs);
}

/**
 * @brief Decode a strict security configuration or portable backup section.
 * @param[in] json Borrowed complete settings object with no unknown or duplicate fields.
 * @param[in,out] parsed Destination preserving caller-assigned board/revision for backups.
 * @param[out] error Failure diagnostic; cleared on success.
 * @param[in] backup True reads armed/triggered seeds; false reads baseRevision settings only.
 * @return True for complete bounded fields and normalized supported iButton ROMs.
 * @note Physical port existence, cross-module ownership and duplicate identities are validated
 * by the caller's complete configuration validator before persistence or activation.
 */
bool parse_security_module(const cJSON* json,
                           Configuration& parsed,
                           std::string& error,
                           bool backup)
{
    const bool fields = backup ? settings_json_fields(json,
                                                      {"enabled",
                                                       "sirenRelayId",
                                                       "readerPortId",
                                                       "exitDelaySeconds",
                                                       "entryDelaySeconds",
                                                       "keys",
                                                       "items",
                                                       "armed",
                                                       "triggered"})
                               : settings_json_fields(json,
                                                      {"baseRevision",
                                                       "enabled",
                                                       "sirenRelayId",
                                                       "readerPortId",
                                                       "exitDelaySeconds",
                                                       "entryDelaySeconds",
                                                       "keys",
                                                       "items"});
    const auto* enabled = cJSON_GetObjectItemCaseSensitive(json, "enabled");
    const auto* keys = cJSON_GetObjectItemCaseSensitive(json, "keys");
    const auto* items = cJSON_GetObjectItemCaseSensitive(json, "items");
    if (!fields || !cJSON_IsBool(enabled) || !cJSON_IsArray(keys)
        || cJSON_GetArraySize(keys) > static_cast<int>(kMaxSecurityKeys) || !cJSON_IsArray(items)
        || cJSON_GetArraySize(items) > static_cast<int>(kMaxSecurityZones)
        || !text_field(json, "sirenRelayId", parsed.security.sirenRelayId, 32)
        || !text_field(json, "readerPortId", parsed.security.readerPortId, 32)
        || !security_delay(json, "exitDelaySeconds", parsed.security.exitDelaySeconds)
        || !security_delay(json, "entryDelaySeconds", parsed.security.entryDelaySeconds)) {
        error = "Проверьте общие настройки, задержки 0–300 с и не более 16 ключей/датчиков";
        return false;
    }
    parsed.enabled = cJSON_IsTrue(enabled);
    if (backup) {
        const auto* armed = cJSON_GetObjectItemCaseSensitive(json, "armed");
        const auto* triggered = cJSON_GetObjectItemCaseSensitive(json, "triggered");
        if (!cJSON_IsBool(armed) || !cJSON_IsBool(triggered)) {
            error = "Некорректные сохранённые состояния охраны";
            return false;
        }
        parsed.armed = cJSON_IsTrue(armed);
        parsed.triggered = cJSON_IsTrue(triggered);
    } else {
        const auto* revision = cJSON_GetObjectItemCaseSensitive(json, "baseRevision");
        if (!cJSON_IsNumber(revision) || !std::isfinite(revision->valuedouble)
            || revision->valuedouble < 1 || revision->valuedouble > UINT32_MAX
            || std::floor(revision->valuedouble) != revision->valuedouble) {
            error = "Укажите корректную ревизию настроек охраны";
            return false;
        }
        parsed.revision = static_cast<std::uint32_t>(revision->valuedouble);
    }
    parsed.security.keys.clear();
    parsed.items.clear();
    const cJSON* object;
    cJSON_ArrayForEach(object, keys)
    {
        SecurityKey key;
        if (!settings_json_fields(object, {"id", "name", "address"})
            || !text_field(object, "id", key.id, kSocketMaxIdBytes)
            || !text_field(object, "name", key.name, kSocketMaxNameBytes)
            || !text_field(object, "address", key.address, 16)
            || !normalize_security_address(key.address)) {
            error = "Некорректный ключ iButton или контрольная сумма серийного номера";
            return false;
        }
        parsed.security.keys.push_back(std::move(key));
    }
    cJSON_ArrayForEach(object, items)
    {
        Item item;
        std::string type;
        const auto* delayed = cJSON_GetObjectItemCaseSensitive(object, "entryDelay");
        if (!settings_json_fields(object, {"id", "name", "inputId", "sensorType", "entryDelay"})
            || !text_field(object, "id", item.id, kSocketMaxIdBytes)
            || !text_field(object, "name", item.name, kSocketMaxNameBytes)
            || !text_field(object, "inputId", item.inputId, 32)
            || !text_field(object, "sensorType", type, 16) || (type != "reed" && type != "motion")
            || !cJSON_IsBool(delayed)) {
            error = "Проверьте поля датчика охраны";
            return false;
        }
        item.securityType =
            type == "motion" ? SecuritySensorType::Motion : SecuritySensorType::Reed;
        item.entryDelay = cJSON_IsTrue(delayed);
        parsed.items.push_back(std::move(item));
    }
    error.clear();
    return true;
}

/**
 * @brief Parse and commit all security settings while retaining independent operative flags.
 * @param[in] request Strict replacement settings with an optimistic revision token.
 * @param[out] error Validation, claim, safe-state or storage diagnostic.
 * @return Confirmation or a typed configuration failure.
 * @pre Hold controller_mutex and the settings writer guard.
 */
ControllerResult update_security_locked(const cJSON* request, std::string& error)
{
    auto& config = security_configuration();
    Configurations next = configurations;
    auto& replacement = next[index(ControllerKind::Security)];
    replacement = Configuration{};
    replacement.boardId = board_profile_active().id;
    if (!parse_security_module(request, replacement, error, false))
        return SocketResult::InvalidInput;
    if (replacement.revision != config.revision) {
        error = "Настройки охраны изменились. Обновите страницу";
        return SocketResult::Conflict;
    }
    replacement.armed = replacement.enabled && config.armed;
    replacement.triggered = replacement.enabled && config.triggered;
    if (!valid_configuration(replacement, true, ControllerKind::Security)) {
        error = "Проверьте ID, имена, сирену, считыватель, ключи и входы датчиков";
        return SocketResult::InvalidInput;
    }
    if (resource_conflict(next, true) || item_count(next) > kSocketMaxItems) {
        error = "Сирена, считыватель или вход уже принадлежат другому контроллеру";
        return SocketResult::Conflict;
    }
    if (same_configuration(config, replacement)) {
        error.clear();
        return SocketResult::Ok;
    }
    if (config.armed && replacement.enabled) {
        error = "Снимите охрану перед изменением её настроек";
        return SocketResult::Conflict;
    }
    if (replacement.revision == UINT32_MAX) {
        error = "Исчерпан счётчик версий охраны";
        return SocketResult::Conflict;
    }
    ++replacement.revision;
    if (!replacement.enabled || config.security.sirenRelayId != replacement.security.sirenRelayId) {
        security_runtime.disarmInhibited = config.armed || config.triggered;
        for (const auto* relayId :
             {&config.security.sirenRelayId, &replacement.security.sirenRelayId}) {
            if (!relayId->empty() && hardware_io_set_relay(*relayId, false) != ESP_OK)
                return unavailable(error, "Безопасное выключение реле сирены не подтверждено");
        }
    }
    if (save(next) != ESP_OK) {
        error = "Не удалось сохранить настройки охраны";
        if (security_runtime.disarmInhibited)
            security_runtime.storageError =
                "Выключение охраны не сохранено; сирена удерживается в OFF";
        return SocketResult::StorageError;
    }
    configurations = std::move(next);
    runtimes[index(ControllerKind::Security)].assign(security_configuration().items.size(),
                                                     Runtime{});
    const auto policies = apply_relay_recovery_policies();
    if (policies != ESP_OK) {
        worker_error = policies;
        service_error = "Защита восстановления сирены недоступна";
        return unavailable(error, service_error.c_str());
    }
    apply_security_config();
    service_error.clear();
    error.clear();
    return SocketResult::Ok;
}

/**
 * @brief Build common guard settings, current phase, key permissions and debounced zone states.
 * @return Owned status object for authenticated web/MQTT reporting, or nullptr on allocation
 * failure.
 * @pre Hold controller_mutex; no output command or persistence is performed.
 */
cJSON* security_status_locked()
{
    const auto& config = security_configuration();
    const auto& board = board_profile_active();
    const auto nowUs = esp_timer_get_time();
    sample_security_zones(nowUs);
    const auto reader = ibutton_read();
    HardwareIoChannelState siren;
    const bool sirenAvailable = security_siren_read(siren);
    const bool triggered = config.triggered || security_runtime.pendingAlarm;
    const bool exiting =
        config.enabled && config.armed && !triggered && security_runtime.exitUntilUs > nowUs;
    const bool entering = config.enabled && config.armed && security_runtime.entryUntilUs > nowUs;
    const char* phase = !config.enabled || !config.armed ? "disarmed"
                        : entering                       ? "entry_delay"
                        : triggered                      ? "alarm"
                        : exiting                        ? "exit_delay"
                                                         : "armed";
    const auto deadline = exiting    ? security_runtime.exitUntilUs
                          : entering ? security_runtime.entryUntilUs
                                     : 0;
    const auto remaining = deadline > nowUs ? (deadline - nowUs + 999'999) / 1'000'000 : 0;
    const auto enrollmentRemaining =
        security_runtime.enrollmentUntilUs > nowUs
            ? (security_runtime.enrollmentUntilUs - nowUs + 999'999) / 1'000'000
            : 0;
    const auto armBlock = security_arm_block(config.security.exitDelaySeconds != 0);
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddNumberToObject(root.get(), "revision", config.revision)
        || !cJSON_AddBoolToObject(root.get(), "enabled", config.enabled)
        || !cJSON_AddStringToObject(
            root.get(), "sirenRelayId", config.security.sirenRelayId.c_str())
        || !cJSON_AddStringToObject(
            root.get(), "readerPortId", config.security.readerPortId.c_str())
        || !cJSON_AddNumberToObject(
            root.get(), "exitDelaySeconds", config.security.exitDelaySeconds)
        || !cJSON_AddNumberToObject(
            root.get(), "entryDelaySeconds", config.security.entryDelaySeconds)
        || !cJSON_AddBoolToObject(root.get(), "armed", config.armed)
        || !cJSON_AddBoolToObject(root.get(), "triggered", triggered)
        || !cJSON_AddBoolToObject(root.get(), "pendingEntry", entering)
        || !cJSON_AddBoolToObject(root.get(), "inhibited", security_runtime.disarmInhibited)
        || !cJSON_AddStringToObject(root.get(), "phase", phase)
        || !cJSON_AddNumberToObject(root.get(), "remainingSeconds", static_cast<double>(remaining))
        || !cJSON_AddNumberToObject(
            root.get(), "enrollmentRemainingSeconds", static_cast<double>(enrollmentRemaining))
        || !cJSON_AddBoolToObject(root.get(), "readyToArm", armBlock.empty())
        || !cJSON_AddStringToObject(root.get(), "armBlockReason", armBlock.c_str())
        || !cJSON_AddBoolToObject(root.get(), "sirenAvailable", sirenAvailable)
        || !(sirenAvailable ? cJSON_AddBoolToObject(root.get(), "sirenActual", siren.value)
                            : cJSON_AddNullToObject(root.get(), "sirenActual"))
        || !cJSON_AddStringToObject(root.get(), "alarmReason", security_runtime.alarmReason.c_str())
        || !cJSON_AddStringToObject(root.get(), "lastKeyName", security_runtime.lastKeyName.c_str())
        || !cJSON_AddStringToObject(
            root.get(), "lastKeyError", security_runtime.lastKeyError.c_str()))
        return nullptr;
    auto* error = !security_runtime.storageError.empty()  ? security_runtime.storageError.c_str()
                  : !security_runtime.outputError.empty() ? security_runtime.outputError.c_str()
                  : !service_error.empty()                ? service_error.c_str()
                                                          : "";
    if (!cJSON_AddStringToObject(root.get(), "error", error))
        return nullptr;
    auto* readerJson = cJSON_AddObjectToObject(root.get(), "reader");
    auto* keys = cJSON_AddArrayToObject(root.get(), "keys");
    auto* items = cJSON_AddArrayToObject(root.get(), "items");
    auto* ports = cJSON_AddObjectToObject(root.get(), "ports");
    auto* relays = ports ? cJSON_AddArrayToObject(ports, "relays") : nullptr;
    auto* inputs = ports ? cJSON_AddArrayToObject(ports, "inputs") : nullptr;
    auto* sensors = ports ? cJSON_AddArrayToObject(ports, "sensors") : nullptr;
    if (!readerJson || !keys || !items || !relays || !inputs || !sensors
        || !cJSON_AddBoolToObject(
            readerJson, "available", security_reader_fresh(reader, nowUs / 1000))
        || !cJSON_AddBoolToObject(readerJson, "present", reader.present)
        || !cJSON_AddStringToObject(readerJson, "error", reader.error.c_str())
        || !cJSON_AddNumberToObject(
            readerJson, "updatedAtUptimeMs", static_cast<double>(reader.updatedAtMs)))
        return nullptr;
    for (const auto& key : config.security.keys) {
        Json item(cJSON_CreateObject(), cJSON_Delete);
        if (!item || !cJSON_AddStringToObject(item.get(), "id", key.id.c_str())
            || !cJSON_AddStringToObject(item.get(), "name", key.name.c_str())
            || !cJSON_AddStringToObject(item.get(), "address", key.address.c_str())
            || !cJSON_AddItemToArray(keys, item.get()))
            return nullptr;
        item.release();
    }
    for (std::size_t i = 0; i < config.items.size(); ++i) {
        const auto& zone = config.items[i];
        const auto observed =
            i < security_runtime.zones.size() ? security_runtime.zones[i] : SecurityZoneRuntime{};
        const bool available = observed.available && observed.stable;
        Json item(cJSON_CreateObject(), cJSON_Delete);
        if (!item || !cJSON_AddStringToObject(item.get(), "id", zone.id.c_str())
            || !cJSON_AddStringToObject(item.get(), "name", zone.name.c_str())
            || !cJSON_AddStringToObject(item.get(), "inputId", zone.inputId.c_str())
            || !cJSON_AddStringToObject(
                item.get(), "sensorType", security_type_id(zone.securityType))
            || !cJSON_AddBoolToObject(item.get(), "entryDelay", zone.entryDelay)
            || !cJSON_AddBoolToObject(item.get(), "available", available)
            || !(observed.available
                     ? cJSON_AddBoolToObject(item.get(), "inputLevel", observed.input.value)
                     : cJSON_AddNullToObject(item.get(), "inputLevel"))
            || !(observed.available
                     ? cJSON_AddBoolToObject(item.get(), "closed", !observed.input.value)
                     : cJSON_AddNullToObject(item.get(), "closed"))
            || !(available ? cJSON_AddBoolToObject(
                                 item.get(), "active", security_active(zone, observed.level))
                           : cJSON_AddNullToObject(item.get(), "active"))
            || !cJSON_AddStringToObject(item.get(), "error", observed.error.c_str())
            || !cJSON_AddItemToArray(items, item.get()))
            return nullptr;
        item.release();
    }
    for (std::size_t i = 0; i < board.relayCount; ++i)
        if (!security_add_port(relays, board.relays[i].name))
            return nullptr;
    for (std::size_t i = 0; i < board.inputCount; ++i)
        if (!security_add_port(inputs, board.inputs[i].name))
            return nullptr;
    for (std::size_t i = 0; i < board.sensorPortCount; ++i)
        if (!security_add_port(sensors, board.sensorPorts[i].name))
            return nullptr;
    Json sync(security_sync_status(nowUs / 1000), cJSON_Delete);
    if (!sync || !cJSON_AddItemToObject(root.get(), "hubSync", sync.get()))
        return nullptr;
    sync.release();
    return root.release();
}
}  // namespace fcplcn::controllers::detail

/** @endcond */

using namespace fcplcn::controllers::detail;

namespace {
/**
 * @brief Enter the shared mutation gate and translate an optional MQTT uptime deadline.
 * @param[in] armed Requested explicit permission.
 * @param[in] timed True when uptimeMs is a bounded command-delivery deadline.
 * @param[in] uptimeMs Delivery deadline in milliseconds; ignored for untimed web/key operations.
 * @param[out] error Failure diagnostic.
 * @param fence Optional exact short hub authority for a coordinated SET.
 * @return The serialized security permission result.
 */
ControllerResult security_armed_command(bool armed,
                                        bool timed,
                                        std::int64_t uptimeMs,
                                        std::string& error,
                                        const SecurityCommandFence* fence = nullptr)
{
    SettingsWriteGuard mutation;
    if (!mutation) {
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return SocketResult::Conflict;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (timed && (uptimeMs < 0 || uptimeMs > std::numeric_limits<std::int64_t>::max() / 1000))
        return expired(error);
    SecuritySyncGuard sync;
    if (fence != nullptr) {
        std::int64_t leaseDeadline = 0;
        if (!sync.allows(*fence, esp_timer_get_time() / 1000, leaseDeadline)) {
            error = "Истёк или изменился режим охраны хаба";
            return SocketResult::Conflict;
        }
        uptimeMs = std::min(uptimeMs, leaseDeadline);
    }
    return set_security_armed_locked(armed, error, timed ? uptimeMs * 1000 : 0);
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Set the independent guard permission without commanding raw siren demand.
 * @param[in] armed True arms the guard; false clears entry/exit timing and the latched alarm.
 * @param[out] error Failure diagnostic.
 * @return Confirmed FRAM state or a typed readiness/storage failure.
 * @endcond
 */
ControllerResult controller_security_set_armed(bool armed, std::string& error)
{
    return security_armed_command(armed, false, 0, error);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Set guard permission only within the explicit monotonic MQTT delivery deadline.
 * @param[in] armed Requested confirmed permission.
 * @param[in] expiresAtUptimeMs Deadline in uptime milliseconds, not a permission lease.
 * @param[out] error Failure diagnostic.
 * @return Confirmation or a typed expiry/readiness/storage failure.
 * @endcond
 */
ControllerResult
controller_security_set_armed_until(bool armed, std::int64_t expiresAtUptimeMs, std::string& error)
{
    return security_armed_command(armed, true, expiresAtUptimeMs, error);
}

/**
 * @brief Apply a coordinated permission while its exact hub authority is still current.
 * @param armed Requested durable permission.
 * @param expiresAtUptimeMs Delivery deadline in local monotonic milliseconds.
 * @param fence Exact hub epoch, house revision and lease sequence.
 * @param[out] error Typed failure diagnostic.
 * @return Confirmation or freshness/readiness/storage refusal.
 */
ControllerResult controller_security_set_hub_armed_until(bool armed,
                                                         std::int64_t expiresAtUptimeMs,
                                                         const SecurityCommandFence& fence,
                                                         std::string& error)
{
    return security_armed_command(armed, true, expiresAtUptimeMs, error, &fence);
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Search a selected free reader port without temporarily changing the saved binding.
 * @param[in] portId Selected profile sensor port; an unsaved free port may be searched.
 * @param[in] refresh True starts/restarts a bounded driver discovery job.
 * @param[out] result Owned scan JSON on success, or nullptr on failure.
 * @param[out] error Failure diagnostic.
 * @return Confirmation, ownership/armed conflict, or driver/unavailable failure.
 * @note Scanning suppresses all key toggles for thirty seconds and consumes event baselines;
 * the touched enrollment key is never replayed after the suppression window expires.
 * @endcond
 */
ControllerResult
controller_security_scan(std::string_view portId, bool refresh, cJSON*& result, std::string& error)
{
    result = nullptr;
    SettingsWriteGuard mutation;
    if (!mutation) {
        error = "Импорт уже сохранён: ожидается перезагрузка";
        return SocketResult::Conflict;
    }
    std::lock_guard<std::mutex> lock(controller_mutex);
    if (!operation_permitted())
        return expired(error);
    const auto& config = security_configuration();
    if (!initialized || worker_error != ESP_OK)
        return unavailable(error, "Охрана ещё не запущена");
    if (config.armed || config.triggered || security_runtime.pendingAlarm) {
        error = "Снимите охрану перед добавлением ключа";
        return SocketResult::Conflict;
    }
    if (!known_sensor_port(portId)) {
        error = "Неизвестный sensor-порт считывателя iButton";
        return SocketResult::NotFound;
    }
    const auto claims = claim_count(configurations, ResourceKind::Sensor, portId);
    const bool own = config.security.readerPortId == portId;
    if (claims > (own ? 1U : 0U)) {
        error = "Порт уже принадлежит другому устройству";
        return SocketResult::Conflict;
    }
    if (refresh || security_runtime.enrollmentUntilUs <= esp_timer_get_time())
        security_reader_barrier();
    const auto reader = ibutton_read();
    security_runtime.consumedEvent = reader.eventSequence;
    security_runtime.readerGeneration = reader.generation;
    security_runtime.readerBaseline = true;
    security_runtime.enrollmentUntilUs = esp_timer_get_time() + kEnrollmentUs;
    IbuttonScanSnapshot scan;
    const auto status = ibutton_request_scan(portId, refresh, scan);
    if (status != ESP_OK)
        return unavailable(error, "Поиск iButton недоступен");
    Json json(cJSON_CreateObject(), cJSON_Delete);
    if (!json || !cJSON_AddStringToObject(json.get(), "portId", std::string(portId).c_str())
        || !cJSON_AddBoolToObject(json.get(), "busy", scan.busy)
        || !cJSON_AddBoolToObject(json.get(), "complete", scan.complete)
        || !cJSON_AddStringToObject(json.get(), "error", scan.error.c_str()))
        return unavailable(error, "Недостаточно памяти для результатов поиска");
    auto* addresses = cJSON_AddArrayToObject(json.get(), "addresses");
    if (!addresses)
        return unavailable(error, "Недостаточно памяти для результатов поиска");
    for (const auto& address : scan.addresses) {
        Json value(cJSON_CreateString(address.c_str()), cJSON_Delete);
        if (!value || !cJSON_AddItemToArray(addresses, value.get()))
            return unavailable(error, "Недостаточно памяти для результатов поиска");
        value.release();
    }
    result = json.release();
    error.clear();
    return SocketResult::Ok;
}
