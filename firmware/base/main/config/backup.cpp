/**
 * @file backup.cpp
 * @brief Complete backup codecs and one-commit restore staging.
 * @details The importer checks the active board and exact versioned schemas before any mutation.
 * Legacy documents gain explicitly empty newer modules; v4 thermostats gain their legacy
 * enabled behavior. The final store-generation CAS protects the validated section set.
 */
#include "config/backup.h"
#include "security/auth.h"
#include "hardware/board_profile.h"
#include "config/config.h"
#include "config/settings_json.h"
#include "config/settings_store.h"
#include "controllers/socket_controller.h"
#include "product_identity.h"
#include <cmath>
#include <cstring>
#include <memory>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

/**
 * @brief Prepare replacement FRAM states after restore writers drain and before flash commits.
 * @param[in] replacement Validated replacement settings and controller identity.
 * @param[in] current Authoritative settings whose FRAM slot must remain intact on failure.
 * @return ESP_OK after verified FRAM staging, or a storage error without changing flash.
 */
esp_err_t prepare_restore_states(const SettingsSnapshot& replacement,
                                 const SettingsSnapshot& current)
{
    constexpr auto section = static_cast<std::size_t>(SettingsSection::Controllers);
    return controllers_prepare_restore_states(replacement.sections[section],
                                              current.sections[section]);
}

/**
 * @brief Borrow a case-sensitive member from a JSON object.
 * @param[in] parent Borrowed parent; a missing or non-object parent yields no matching member.
 * @param[in] key NUL-terminated member name.
 * @return Borrowed member node, or nullptr; the parent retains ownership.
 */
const cJSON* get(const cJSON* parent, const char* key)
{
    return cJSON_GetObjectItemCaseSensitive(parent, key);
}

/**
 * @brief Compare a JSON string with a required backup-schema literal.
 * @param[in] value Borrowed candidate node; nullptr and non-strings are rejected.
 * @param[in] expected Non-null NUL-terminated literal.
 * @return True for an exact case-sensitive byte match.
 */
bool text(const cJSON* value, const char* expected)
{
    return cJSON_IsString(value) && value->valuestring != nullptr
           && std::strcmp(value->valuestring, expected) == 0;
}

/**
 * @brief Decode a positive integral backup revision or format version.
 * @param[in] value Borrowed JSON number in the inclusive range 1 through UINT32_MAX.
 * @param[out] number Converted value on success; unchanged on failure.
 * @return True only for a finite integral number in range.
 */
bool integer(const cJSON* value, std::uint32_t& number)
{
    if (!cJSON_IsNumber(value) || !std::isfinite(value->valuedouble)
        || std::floor(value->valuedouble) != value->valuedouble || value->valuedouble < 1
        || value->valuedouble > UINT32_MAX)
        return false;
    number = static_cast<std::uint32_t>(value->valuedouble);
    return true;
}

/**
 * @brief Set an import-validation diagnostic and classify the request as invalid.
 * @param[out] error Replaced with the supplied diagnostic.
 * @param[in] message Non-null NUL-terminated failure explanation.
 * @return BackupResult::InvalidInput; no settings or hardware are changed.
 */
BackupResult invalid(std::string& error, const char* message)
{
    error = message;
    return BackupResult::InvalidInput;
}

/**
 * @brief Set an import-conflict diagnostic without mutating the active configuration.
 * @param[out] error Replaced with the supplied diagnostic.
 * @param[in] message Non-null NUL-terminated conflict explanation.
 * @return BackupResult::Conflict; no settings or hardware are changed.
 */
BackupResult conflict(std::string& error, const char* message)
{
    error = message;
    return BackupResult::Conflict;
}

/**
 * @brief Copy an older controller document into the current module layout.
 * @param[in] controllers Borrowed controller object already checked against its legacy version.
 * @param[in] version Supported older backup version, 1 through 6.
 * @return Caller-owned JSON for cJSON_Delete(), or nullptr on allocation failure.
 * @details Missing newer modules become empty and disabled. Version 4 thermostat rows
 * receive an empty button binding and enabled=true to preserve their former behavior.
 * Version 6 duration settings are validated by the importer and removed here: fixed cycle
 * timing belongs to firmware policy, never to portable controller configuration.
 * The original JSON and all persistent settings remain unchanged.
 */
cJSON* upgrade_legacy_controllers(const cJSON* controllers, std::uint32_t version)
{
    Json root(cJSON_Duplicate(controllers, true), cJSON_Delete);
    if (!root)
        return nullptr;
    for (const char* id : {"lights", "meteo", "thermostats"}) {
        if (version >= 2 && std::strcmp(id, "lights") == 0)
            continue;
        if (version >= 3 && std::strcmp(id, "meteo") == 0)
            continue;
        if (version >= 4 && std::strcmp(id, "thermostats") == 0)
            continue;
        auto* module = cJSON_AddObjectToObject(root.get(), id);
        if (!module || !cJSON_AddBoolToObject(module, "enabled", false)
            || !cJSON_AddArrayToObject(module, "items"))
            return nullptr;
    }
    if (version == 4) {
        auto* rows = cJSON_GetObjectItemCaseSensitive(
            cJSON_GetObjectItemCaseSensitive(root.get(), "thermostats"), "items");
        for (auto* row = rows ? rows->child : nullptr; row; row = row->next)
            if (!cJSON_AddStringToObject(row, "inputId", "")
                || !cJSON_AddBoolToObject(row, "enabled", true))
                return nullptr;
    }
    if (version == 6) {
        auto* rows = cJSON_GetObjectItemCaseSensitive(
            cJSON_GetObjectItemCaseSensitive(root.get(), "thermostats"), "items");
        for (auto* row = rows ? rows->child : nullptr; row; row = row->next) {
            cJSON_DeleteItemFromObjectCaseSensitive(row, "minOnSeconds");
            cJSON_DeleteItemFromObjectCaseSensitive(row, "minOffSeconds");
        }
    }
    auto* security = cJSON_AddObjectToObject(root.get(), "security");
    if (!security || !cJSON_AddBoolToObject(security, "enabled", false)
        || !cJSON_AddStringToObject(security, "sirenRelayId", "")
        || !cJSON_AddStringToObject(security, "readerPortId", "")
        || !cJSON_AddNumberToObject(security, "entryDelaySeconds", 15)
        || !cJSON_AddNumberToObject(security, "exitDelaySeconds", 30)
        || !cJSON_AddBoolToObject(security, "armed", false)
        || !cJSON_AddBoolToObject(security, "triggered", false)
        || !cJSON_AddArrayToObject(security, "keys") || !cJSON_AddArrayToObject(security, "items"))
        return nullptr;
    return root.release();
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Export one coherent snapshot with secrets and a password verifier.
 * @param[out] error Diagnostic on failure; cleared on success.
 * @return Caller-owned JSON, to be freed with cJSON_Delete(), or nullptr.
 * @pre Configuration, authentication, controllers and the active board are initialized.
 * @note Thread-safe; reads the atomic store rather than unsaved UI or runtime drafts.
 * @endcond
 */
cJSON* backup_export_json(std::string& error)
{
    SettingsSnapshot snapshot;
    Json controllers(controllers_backup_snapshot(snapshot, error), cJSON_Delete);
    if (!controllers)
        return nullptr;
    Json config(config_backup_json(snapshot.sections[0], error), cJSON_Delete);
    if (!config)
        return nullptr;
    Json user(auth_backup_json(snapshot.sections[1], error), cJSON_Delete);
    if (!user)
        return nullptr;
    if (!text(get(get(config.get(), "hardware"), "boardId"), board_profile_active().id)) {
        error = "Выбран другой профиль платы: сначала завершите перезагрузку";
        return nullptr;
    }
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !cJSON_AddStringToObject(root.get(), "format", "fcplcn-config")
        || !cJSON_AddNumberToObject(root.get(), "version", 8)
        || !cJSON_AddStringToObject(root.get(), "product", FCPLCN_PRODUCT_NAME)
        || !cJSON_AddStringToObject(root.get(), "boardId", board_profile_active().id)
        || !cJSON_AddStringToObject(root.get(), "sourceDeviceId", device_id().c_str()))
        return nullptr;
    if (!cJSON_AddItemToObject(root.get(), "config", config.get()))
        return nullptr;
    config.release();
    if (!cJSON_AddItemToObject(root.get(), "user", user.get()))
        return nullptr;
    user.release();
    if (!cJSON_AddItemToObject(root.get(), "controllers", controllers.get()))
        return nullptr;
    controllers.release();
    error.clear();
    return root.release();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate and durably stage a complete replacement without activating it.
 * @param[in] request Borrowed JSON object containing baseRevision and document.
 * @param[out] error Diagnostic on failure; cleared on success.
 * @return Restore outcome. Success freezes subsequent settings mutations until reboot.
 * @pre The caller authenticates the request, enforces its size and reserves a reboot worker.
 * @note Thread-safe. Do not call while holding a SettingsWriteGuard or a module lock.
 * @details All codecs and board checks run before the single store commit. Existing
 * guards drain before staging; generation CAS rejects intervening configuration changes.
 * The caller schedules reboot only after success; this function does not restart hardware.
 * @endcond
 */
BackupResult backup_stage_restore(const cJSON* request, std::string& error)
{
    std::uint32_t base_revision;
    if (!settings_json_fields(request, {"baseRevision", "document"})
        || !integer(get(request, "baseRevision"), base_revision))
        return invalid(error, "Укажите baseRevision и полный документ резервной копии");
    const auto* document = get(request, "document");
    std::uint32_t version;
    if (!settings_json_fields(
            document,
            {"format", "version", "product", "boardId", "config", "user", "controllers"},
            {"sourceDeviceId"})
        || !text(get(document, "format"), "fcplcn-config")
        || !text(get(document, "product"), FCPLCN_PRODUCT_NAME)
        || !integer(get(document, "version"), version) || (version < 1 || version > 8))
        return invalid(error, "Неизвестный формат, продукт или версия резервной копии");
    if (get(document, "sourceDeviceId") != nullptr
        && (!cJSON_IsString(get(document, "sourceDeviceId"))
            || get(document, "sourceDeviceId")->valuestring == nullptr
            || std::strlen(get(document, "sourceDeviceId")->valuestring) > 128))
        return invalid(error, "Некорректный sourceDeviceId");
    const auto* board = get(document, "boardId");
    const auto* configured_board = get(get(get(document, "config"), "hardware"), "boardId");
    if (!cJSON_IsString(board) || board->valuestring == nullptr || !cJSON_IsString(configured_board)
        || configured_board->valuestring == nullptr)
        return invalid(error, "Не указан аппаратный профиль резервной копии");
    // Check ACTIVE hardware before reading or mutating persistent settings.
    if (board_profile_canonical_id(board->valuestring) != board_profile_active().id
        || board_profile_canonical_id(configured_board->valuestring) != board_profile_active().id)
        return conflict(error, "Профиль резервной копии не совпадает с активной платой");
    const auto* incoming_controllers = get(document, "controllers");
    if (!(version == 1   ? settings_json_fields(incoming_controllers, {"sockets"})
          : version == 2 ? settings_json_fields(incoming_controllers, {"sockets", "lights"})
          : version == 3
              ? settings_json_fields(incoming_controllers, {"sockets", "lights", "meteo"})
          : version < 8
              ? settings_json_fields(incoming_controllers,
                                     {"sockets", "lights", "meteo", "thermostats"})
              : settings_json_fields(incoming_controllers,
                                     {"sockets", "lights", "meteo", "thermostats", "security"})))
        return invalid(error, "Неизвестный или отсутствующий контроллер в резервной копии");
    Json upgraded(nullptr, cJSON_Delete);
    if (version == 4) {
        const auto* rows = get(get(incoming_controllers, "thermostats"), "items");
        if (!cJSON_IsArray(rows))
            return invalid(error, "Не указан список термостатов старой конфигурации");
        const cJSON* row;
        cJSON_ArrayForEach(row, rows)
        {
            if (!settings_json_fields(
                    row, {"id", "name", "meteoId", "relayId", "mode", "setpointC", "hysteresisC"}))
                return invalid(error, "Неизвестные поля термостата в конфигурации v4");
        }
    }
    if (version == 5) {
        const auto* rows = get(get(incoming_controllers, "thermostats"), "items");
        if (!cJSON_IsArray(rows))
            return invalid(error, "Не указан список термостатов конфигурации v5");
        const cJSON* row;
        cJSON_ArrayForEach(row, rows)
        {
            if (!settings_json_fields(row,
                                      {"id",
                                       "name",
                                       "meteoId",
                                       "relayId",
                                       "inputId",
                                       "enabled",
                                       "mode",
                                       "setpointC",
                                       "hysteresisC"}))
                return invalid(error, "Неизвестные поля термостата в конфигурации v5");
        }
    }
    if (version == 6) {
        const auto* rows = get(get(incoming_controllers, "thermostats"), "items");
        if (!cJSON_IsArray(rows))
            return invalid(error, "Не указан список термостатов конфигурации v6");
        const cJSON* row;
        cJSON_ArrayForEach(row, rows)
        {
            if (!settings_json_fields(row,
                                      {"id",
                                       "name",
                                       "meteoId",
                                       "relayId",
                                       "inputId",
                                       "enabled",
                                       "mode",
                                       "setpointC",
                                       "hysteresisC",
                                       "minOnSeconds",
                                       "minOffSeconds"}))
                return invalid(error, "Неизвестные поля термостата в конфигурации v6");
            for (const char* name : {"minOnSeconds", "minOffSeconds"}) {
                const auto* value = get(row, name);
                if (!cJSON_IsNumber(value) || !std::isfinite(value->valuedouble)
                    || value->valuedouble < 0 || value->valuedouble > 86400
                    || std::floor(value->valuedouble) != value->valuedouble)
                    return invalid(error, "Некорректное устаревшее время термостата v6");
            }
        }
    }
    if (version < 8) {
        upgraded.reset(upgrade_legacy_controllers(incoming_controllers, version));
        if (!upgraded) {
            error = "Недостаточно памяти";
            return BackupResult::StorageError;
        }
        incoming_controllers = upgraded.get();
    }
    SettingsSnapshot replacement;
    if (!config_backup_record(get(document, "config"), 1, replacement.sections[0], error)
        || !auth_backup_record(get(document, "user"), replacement.sections[1], error))
        return BackupResult::InvalidInput;
    const auto controller_result = controllers_backup_prepare(
        incoming_controllers, 1, 1, 1, 1, replacement.sections[2], error);
    if (controller_result != SocketResult::Ok)
        return controller_result == SocketResult::Conflict ? BackupResult::Conflict
                                                           : BackupResult::InvalidInput;
    if (settings_restore_pending())
        return conflict(error, "Импорт уже сохранён: ожидается перезагрузка");
    SettingsSnapshot current;
    if (settings_store_snapshot(current) != ESP_OK) {
        error = "Не удалось прочитать текущие настройки";
        return BackupResult::StorageError;
    }
    std::uint32_t current_revision, socket_revision, light_revision, meteo_revision,
        thermostat_revision, security_revision;
    if (!config_record_revision(current.sections[0], current_revision, error)
        || !controllers_record_revisions(current.sections[2],
                                         socket_revision,
                                         light_revision,
                                         meteo_revision,
                                         thermostat_revision,
                                         error,
                                         &security_revision))
        return BackupResult::StorageError;
    if (base_revision != current_revision || current_revision == UINT32_MAX
        || socket_revision == UINT32_MAX || light_revision == UINT32_MAX
        || meteo_revision == UINT32_MAX || thermostat_revision == UINT32_MAX
        || security_revision == UINT32_MAX)
        return conflict(error, "Настройки уже изменились: обновите страницу перед импортом");
    if (!config_backup_record(
            get(document, "config"), current_revision + 1, replacement.sections[0], error)
        || !controllers_backup_record(incoming_controllers,
                                      socket_revision + 1,
                                      light_revision + 1,
                                      meteo_revision + 1,
                                      thermostat_revision + 1,
                                      replacement.sections[2],
                                      error,
                                      security_revision + 1))
        return BackupResult::InvalidInput;
    const auto result =
        settings_store_stage(replacement, current.generation, prepare_restore_states);
    if (result == ESP_ERR_INVALID_STATE)
        return conflict(error, "Настройки изменились или импорт уже ожидает перезагрузки");
    if (result == ESP_ERR_INVALID_SIZE)
        return invalid(error, "Настройки превышают допустимый размер Flash-записи");
    if (result != ESP_OK) {
        error = "Не удалось атомарно сохранить резервную копию";
        return BackupResult::StorageError;
    }
    error.clear();
    return BackupResult::Ok;
}
