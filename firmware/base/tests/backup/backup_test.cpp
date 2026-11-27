#include "config/backup.h"
#include "config/config.h"
#include "security/auth.h"
#include "controllers/socket_controller.h"
#include "config/settings_store.h"
#include "hardware/board_profile.h"
#include "test_platform.h"
#include "cJSON.h"
#include "meteo_fake.h"
#include "ibutton_fake.h"
#include "config/state_journal.h"
#include "esp_timer.h"
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
#define REQUIRE(c)                                                                                 \
    do {                                                                                           \
        if (!(c))                                                                                  \
            throw std::runtime_error(std::string(__func__) + ":" + std::to_string(__LINE__)        \
                                     + ": " #c);                                                   \
    } while (false)

const cJSON* field(const cJSON* j, const char* key)
{
    return cJSON_GetObjectItemCaseSensitive(j, key);
}

cJSON* mutable_field(cJSON* j, const char* key)
{
    return cJSON_GetObjectItemCaseSensitive(j, key);
}

std::string text(const cJSON* j, const char* key)
{
    const auto* p = cJSON_GetStringValue(field(j, key));
    REQUIRE(p);
    return p;
}

std::string print(const cJSON* j)
{
    char* s = cJSON_PrintUnformatted(j);
    REQUIRE(s);
    std::string out = s;
    cJSON_free(s);
    return out;
}

Json parse(const std::string& s)
{
    Json j(cJSON_Parse(s.c_str()), cJSON_Delete);
    REQUIRE(j);
    return j;
}

Json copy(const cJSON* j)
{
    Json out(cJSON_Duplicate(j, true), cJSON_Delete);
    REQUIRE(out);
    return out;
}

Json document()
{
    std::string error;
    Json j(backup_export_json(error), cJSON_Delete);
    if (!j)
        throw std::runtime_error(error);
    return j;
}

SettingsSnapshot snapshot()
{
    SettingsSnapshot s;
    REQUIRE(settings_store_snapshot(s) == ESP_OK);
    return s;
}

void step()
{
    backup_test::advance(100'000);
    socket_controller_test_step();
}

void boot(bool fresh = false, unsigned suffix = 0x112233)
{
    socket_controller_test_reset();
    auth_test_reset();
    settings_store_test_reset();
    meteo_fake::reset();
    ibutton_fake::reset();
    backup_test::clear_pending();
    if (fresh)
        backup_test::reset();
    else
        backup_test::reboot_hardware();
    backup_test::set_mac_suffix(suffix);
    REQUIRE(settings_store_init() == ESP_OK);
    REQUIRE(config_init() == ESP_OK);
    REQUIRE(board_profile_activate(config_get().hardware.boardId));
    REQUIRE(auth_init() == ESP_OK);
    REQUIRE(socket_controller_init() == ESP_OK);
    step();
}

void configure(const std::string& body)
{
    auto j = parse(body);
    cJSON_AddNumberToObject(j.get(), "baseRevision", config_get().revision);
    std::string error;
    bool network = false;
    REQUIRE(config_update(j.get(), error, network) == ESP_OK);
}

unsigned socket_revision()
{
    Json j(socket_controller_status_json(), cJSON_Delete);
    return static_cast<unsigned>(field(j.get(), "revision")->valuedouble);
}

void sockets(const std::string& items)
{
    auto j = parse("{\"enabled\":true,\"items\":" + items
                   + ",\"baseRevision\":" + std::to_string(socket_revision()) + "}");
    std::string e;
    REQUIRE(socket_controller_update(j.get(), e) == SocketResult::Ok);
    step();
}

void source()
{
    boot(true);
    configure(
        u8R"({"device":{"name":"Котельная"},"wifi":{"ap":{"ssid":"Source AP","password":"ap-backup-secret"},"sta":{"ssid":"Source Router","password":"sta-backup-secret"}},"ethernet":{"dhcp":false,"ip":"10.20.30.40","netmask":"255.255.255.0","gateway":"10.20.30.1","dns":"10.20.30.1"},"linux":{"host":"hub.local","port":1884,"username":"source-plc","password":"mqtt-backup-secret"},"time":{"timezone":"UTC-3","ntpEnabled":true,"ntpServer":"clock.local"}})");
    REQUIRE(auth_change_user("", u8"оператор", std::string("web-backup-secret")) == AuthResult::Ok);
    sockets(
        u8R"([{"id":"kitchen","name":"Кухня","relayId":"rly-0/1","inputId":"in-0/1"},{"id":"hall","name":"Коридор","relayId":"rly-0/2","inputId":""}])");
    std::string error;
    REQUIRE(socket_controller_set_state("kitchen", true, error) == SocketResult::Ok);
}

BackupResult restore(const cJSON* doc, unsigned revision = 0)
{
    Json req(cJSON_CreateObject(), cJSON_Delete);
    cJSON_AddNumberToObject(req.get(), "baseRevision", revision ? revision : config_get().revision);
    cJSON_AddItemToObject(req.get(), "document", cJSON_Duplicate(doc, true));
    std::string error;
    return backup_stage_restore(req.get(), error);
}

AuthResult login(const std::string& username, const std::string& password)
{
    httpd_req_t req;
    AuthCookie cookie;
    return auth_login(&req, username, password, cookie);
}

void set_legacy_version(cJSON* doc, unsigned version)
{
    REQUIRE(version >= 1 && version <= 9);
    cJSON_ReplaceItemInObject(doc, "version", cJSON_CreateNumber(version));
    cJSON_DeleteItemFromObject(mutable_field(doc, "controllers"), "irrigation");
    if (version < 9)
        cJSON_DeleteItemFromObject(mutable_field(doc, "controllers"), "tanks");
    if (version < 8)
        cJSON_DeleteItemFromObject(mutable_field(doc, "controllers"), "security");
}

void defaults()
{
    boot(true);
    auto d = document();
    REQUIRE(text(d.get(), "format") == "fcplcn-config");
    REQUIRE(text(d.get(), "product") == "FCPLCn");
    REQUIRE(field(d.get(), "version")->valueint == 10);
    REQUIRE(text(field(field(d.get(), "config"), "device"), "name") == "FCPLCn");
    REQUIRE(text(field(d.get(), "user"), "algorithm") == "PBKDF2-HMAC-SHA256");
    REQUIRE(cJSON_GetArraySize(field(field(field(d.get(), "controllers"), "sockets"), "items"))
            == 0);
    const auto before = snapshot();
    auto again = document();
    REQUIRE(print(d.get()) == print(again.get()));
    REQUIRE(snapshot().generation == before.generation);
}

void clone()
{
    source();
    auto d = document();
    const auto expected = copy(field(d.get(), "config"));
    const auto expected_user = copy(field(d.get(), "user"));
    const auto expected_controllers = copy(field(d.get(), "controllers"));
    const auto source_id = device_id();
    Json visible(config_public_json(), cJSON_Delete);
    REQUIRE(print(visible.get()).find("ap-backup-secret") == std::string::npos);
    REQUIRE(print(visible.get()).find("mqtt-backup-secret") == std::string::npos);
    REQUIRE(text(field(field(field(d.get(), "config"), "wifi"), "ap"), "password")
            == "ap-backup-secret");
    REQUIRE(text(field(field(d.get(), "config"), "linux"), "password") == "mqtt-backup-secret");
    boot(true, 0x445566);
    const auto target_id = device_id();
    REQUIRE(target_id != source_id);
    const auto before_commits = backup_test::nvs_commits();
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    REQUIRE(settings_restore_pending());
    REQUIRE(backup_test::nvs_commits() == before_commits + 1);
    REQUIRE(config_get().device.name == "FCPLCn");
    REQUIRE(auth_get_username() == "admin");
    REQUIRE(!backup_test::relay(0));
    boot(false, 0x445566);
    REQUIRE(device_id() == target_id);
    REQUIRE(config_get().device.name == u8"Котельная");
    REQUIRE(backup_test::relay(0) && !backup_test::relay(1));
    auto actual = document();
    REQUIRE(print(field(actual.get(), "config")) == print(expected.get()));
    REQUIRE(print(field(actual.get(), "user")) == print(expected_user.get()));
    REQUIRE(print(field(actual.get(), "controllers")) == print(expected_controllers.get()));
    REQUIRE(login(u8"оператор", "web-backup-secret") == AuthResult::Ok);
    REQUIRE(login("admin", "") == AuthResult::InvalidCredentials);
}

void unchanged_after(const cJSON* invalid, BackupResult expected)
{
    const auto before = snapshot();
    const auto name = config_get().device.name;
    const auto user = auth_get_username();
    const auto relay = backup_test::relay(0);
    REQUIRE(restore(invalid) == expected);
    REQUIRE(snapshot().sections == before.sections);
    REQUIRE(snapshot().generation == before.generation);
    REQUIRE(!settings_restore_pending());
    REQUIRE(config_get().device.name == name && auth_get_username() == user
            && backup_test::relay(0) == relay);
}

void rejection()
{
    source();
    auto d = document();
    auto bad = copy(d.get());
    cJSON_ReplaceItemInObject(bad.get(), "boardId", cJSON_CreateString("different-board"));
    unchanged_after(bad.get(), BackupResult::Conflict);
    bad = copy(d.get());
    cJSON_ReplaceItemInObject(bad.get(), "version", cJSON_CreateNumber(999));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    cJSON_ReplaceItemInObject(bad.get(), "product", cJSON_CreateString("Other"));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    cJSON_AddObjectToObject(mutable_field(bad.get(), "controllers"), "unknown-controller");
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    auto* cfg = mutable_field(bad.get(), "config");
    cJSON_DeleteItemFromObject(mutable_field(cfg, "linux"), "password");
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    cJSON_ReplaceItemInObject(
        mutable_field(bad.get(), "user"), "iterations", cJSON_CreateNumber(1));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    cJSON_ReplaceItemInObject(
        mutable_field(bad.get(), "user"), "hash", cJSON_CreateString(std::string(64, 'z').c_str()));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    auto* rows =
        mutable_field(mutable_field(mutable_field(bad.get(), "controllers"), "sockets"), "items");
    cJSON_ReplaceItemInObject(
        cJSON_GetArrayItem(rows, 1), "relayId", cJSON_CreateString("rly-0/1"));
    unchanged_after(bad.get(), BackupResult::Conflict);
    bad = copy(d.get());
    cJSON_AddStringToObject(
        mutable_field(mutable_field(bad.get(), "config"), "device"), "unexpected", "ignored?");
    unchanged_after(bad.get(), BackupResult::InvalidInput);
}

void failed_commit()
{
    source();
    auto d = document();
    configure(R"({"device":{"name":"Current target"}})");
    backup_test::fail_commit();
    unchanged_after(d.get(), BackupResult::StorageError);
    boot();
    REQUIRE(config_get().device.name == "Current target");
    REQUIRE(backup_test::relay(0));
}

void cas()
{
    source();
    auto d = document();
    const auto before = snapshot();
    REQUIRE(restore(d.get(), config_get().revision + 1) == BackupResult::Conflict);
    REQUIRE(snapshot().sections == before.sections);
    REQUIRE(!settings_restore_pending());
    SettingsSnapshot replacement = before;
    replacement.generation = before.generation;
    REQUIRE(settings_store_stage(replacement, before.generation + 1) == ESP_ERR_INVALID_STATE);
    REQUIRE(!settings_restore_pending());
}

void pending()
{
    source();
    auto d = document();
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    const auto staged = snapshot();
    std::string e;
    bool network = false;
    auto j = parse("{\"baseRevision\":" + std::to_string(config_get().revision)
                   + ",\"device\":{\"name\":\"Must not save\"}}");
    REQUIRE(config_update(j.get(), e, network) != ESP_OK);
    REQUIRE(auth_change_user("web-backup-secret", "other", std::string("new-password"))
            != AuthResult::Ok);
    REQUIRE(socket_controller_set_state("kitchen", false, e) != SocketResult::Ok);
    REQUIRE(socket_controller_set_relay("rly-0/16", true, e) != SocketResult::Ok);
    backup_test::input(0, false);
    step();
    REQUIRE(backup_test::relay(0));
    REQUIRE(!backup_test::relay(15));
    REQUIRE(snapshot().sections == staged.sections);
    SettingsWriteGuard gate;
    REQUIRE(!gate);
}

SettingsBytes legacy_socket_record(const SettingsBytes& combined, bool duplicateInput);

void seed_legacy(const SettingsSnapshot& source_snapshot)
{
    SettingsBytes config = source_snapshot.sections[0];
    config.push_back(0);
    backup_test::raw_put("fcplcn_cfg", "config", config);
    backup_test::raw_put("fcplcn_auth", "account", source_snapshot.sections[1]);
    backup_test::raw_put("fcplcn_sockets", "runtime", source_snapshot.sections[2]);
}

void migration()
{
    source();
    auto original = snapshot();
    original.sections[2] = legacy_socket_record(original.sections[2], false);
    backup_test::reset();
    settings_store_test_reset();
    seed_legacy(original);
    REQUIRE(settings_store_init() == ESP_OK);
    REQUIRE(snapshot().sections == original.sections);
    REQUIRE(backup_test::raw_has(kSettingsNvsNamespace, kSettingsNvsKey));
    REQUIRE(!backup_test::raw_has("fcplcn_cfg", "config"));
    REQUIRE(!backup_test::raw_has("fcplcn_auth", "account"));
    REQUIRE(!backup_test::raw_has("fcplcn_sockets", "runtime"));
    boot();
    REQUIRE(config_get().device.name == u8"Котельная");
    REQUIRE(login(u8"оператор", "web-backup-secret") == AuthResult::Ok);
    REQUIRE(backup_test::relay(0));
}

void migration_failure()
{
    source();
    const auto original = snapshot();
    backup_test::reset();
    settings_store_test_reset();
    seed_legacy(original);
    backup_test::fail_commit();
    REQUIRE(settings_store_init() != ESP_OK);
    REQUIRE(!backup_test::raw_has(kSettingsNvsNamespace, kSettingsNvsKey));
    REQUIRE(backup_test::raw_has("fcplcn_cfg", "config"));
    REQUIRE(backup_test::raw_has("fcplcn_auth", "account"));
    REQUIRE(backup_test::raw_has("fcplcn_sockets", "runtime"));
    backup_test::clear_pending();
    settings_store_test_reset();
    REQUIRE(settings_store_init() == ESP_OK);
    REQUIRE(snapshot().sections == original.sections);
}

void corrupt_store()
{
    source();
    const auto original = snapshot();
    auto bytes = backup_test::raw_get(kSettingsNvsNamespace, kSettingsNvsKey);
    bytes.back() ^= 1;
    backup_test::raw_put(kSettingsNvsNamespace, kSettingsNvsKey, bytes);
    seed_legacy(original);
    settings_store_test_reset();
    REQUIRE(settings_store_init() != ESP_OK);
    REQUIRE(backup_test::raw_get(kSettingsNvsNamespace, kSettingsNvsKey) == bytes);
    REQUIRE(backup_test::raw_has("fcplcn_cfg", "config"));
}

void maximum()
{
    boot(true);
    const auto host = std::string(63, 'a') + '.' + std::string(63, 'b') + '.' + std::string(63, 'c')
                      + '.' + std::string(61, 'd');
    auto cfg = parse("{}");
    auto* device = cJSON_AddObjectToObject(cfg.get(), "device");
    cJSON_AddStringToObject(device, "name", std::string(64, 'N').c_str());
    auto* hub = cJSON_AddObjectToObject(cfg.get(), "linux");
    cJSON_AddStringToObject(hub, "host", host.c_str());
    cJSON_AddStringToObject(hub, "username", std::string(128, 'u').c_str());
    cJSON_AddStringToObject(hub, "password", std::string(128, 'p').c_str());
    configure(print(cfg.get()));
    Json rows(cJSON_CreateArray(), cJSON_Delete);
    for (unsigned i = 1; i <= 16; ++i) {
        auto* r = cJSON_CreateObject();
        cJSON_AddStringToObject(r, "id", (std::string(30, 's') + std::to_string(i)).c_str());
        cJSON_AddStringToObject(r, "name", std::string(64, 'L').c_str());
        cJSON_AddStringToObject(r, "relayId", ("rly-0/" + std::to_string(i)).c_str());
        cJSON_AddStringToObject(r, "inputId", ("in-0/" + std::to_string(i)).c_str());
        cJSON_AddItemToArray(rows.get(), r);
    }
    sockets(print(rows.get()));
    auto d = document();
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    const auto bytes = backup_test::raw_get(kSettingsNvsNamespace, kSettingsNvsKey);
    REQUIRE(bytes.size() <= kSettingsMaxBlobBytes);
    boot();
    REQUIRE(config_get().device.name.size() == 64);
    Json s(socket_controller_status_json(), cJSON_Delete);
    REQUIRE(cJSON_GetArraySize(field(s.get(), "items")) == 16);
    const auto before = snapshot();
    REQUIRE(
        settings_store_set(SettingsSection::Sockets, SettingsBytes(kSettingsMaxBlobBytes + 1, 1))
        != ESP_OK);
    REQUIRE(snapshot().sections == before.sections);
}

void gate()
{
    source();
    const auto before = snapshot();
    std::atomic<bool> held{false}, release{false}, started{false}, done{false};
    esp_err_t result = ESP_FAIL;
    std::thread writer([&] {
        SettingsWriteGuard guard;
        REQUIRE(guard);
        held = true;
        while (!release.load())
            std::this_thread::yield();
    });
    while (!held.load())
        std::this_thread::yield();
    std::thread importer([&] {
        started = true;
        result = settings_store_stage(before, before.generation);
        done = true;
    });
    while (!started.load())
        std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
    REQUIRE(!done.load());
    release = true;
    writer.join();
    importer.join();
    REQUIRE(result == ESP_OK && settings_restore_pending());
}

std::size_t allocation_count = 0, failed_allocation = 0;

void* injected_malloc(std::size_t size)
{
    ++allocation_count;
    if (allocation_count == failed_allocation)
        return nullptr;
    return std::malloc(size);
}

void injected_free(void* data)
{
    std::free(data);
}

struct AllocationInjection {
    explicit AllocationInjection(std::size_t fail)
    {
        allocation_count = 0;
        failed_allocation = fail;
        cJSON_Hooks h{injected_malloc, injected_free};
        cJSON_InitHooks(&h);
    }

    ~AllocationInjection()
    {
        cJSON_InitHooks(nullptr);
    }
};

void allocation_failure()
{
    source();
    auto d = document();
    std::size_t count = 0;
    {
        AllocationInjection inject(0);
        REQUIRE(restore(d.get()) == BackupResult::Ok);
        count = allocation_count;
    }
    boot();
    REQUIRE(count > 50);
    for (std::size_t fail = 1; fail <= count; ++fail) {
        const auto before = snapshot();
        // The request was already fully parsed by HTTP. Fault injection targets
        // internal validation/serialization, not the caller's JSON fixture.
        Json request(cJSON_CreateObject(), cJSON_Delete);
        cJSON_AddNumberToObject(request.get(), "baseRevision", config_get().revision);
        cJSON_AddItemToObject(request.get(), "document", cJSON_Duplicate(d.get(), true));
        BackupResult result;
        std::string error;
        {
            AllocationInjection inject(fail);
            result = backup_stage_restore(request.get(), error);
        }
        if (result == BackupResult::Ok) {
            boot();
            auto actual = document();
            REQUIRE(print(field(actual.get(), "config")) == print(field(d.get(), "config")));
            REQUIRE(print(field(actual.get(), "user")) == print(field(d.get(), "user")));
            REQUIRE(print(field(actual.get(), "controllers"))
                    == print(field(d.get(), "controllers")));
        } else {
            REQUIRE(!settings_restore_pending());
            REQUIRE(snapshot().sections == before.sections);
            REQUIRE(snapshot().generation == before.generation);
        }
    }
    std::cout << "Checked " << count
              << " cJSON allocation failure positions without partial configuration\n";
}

Json legacy_controller_json(const SettingsBytes& record)
{
    std::string error;
    Json modules(controllers_backup_json(record, error), cJSON_Delete);
    REQUIRE(modules);
    if (record == snapshot().sections[2]) {
        auto exported = document();
        return copy(field(exported.get(), "controllers"));
    }
    return modules;
}

void require_controller_migration(const SettingsSnapshot& before, unsigned flash_writes)
{
    const auto migrated = snapshot();
    REQUIRE(migrated.sections[0] == before.sections[0]
            && migrated.sections[1] == before.sections[1]);
    REQUIRE(migrated.sections[2] != before.sections[2]);
    const auto& record = migrated.sections[2];
    REQUIRE(record.size() > 26 && std::string(record.begin(), record.begin() + 8) == "FCCTRL11");
    REQUIRE(backup_test::nvs_commits() == flash_writes + 1);
    boot();
    REQUIRE(snapshot().sections == migrated.sections);
    REQUIRE(backup_test::nvs_commits() == flash_writes + 1);
}

SettingsBytes legacy_socket_record(const SettingsBytes& combined, bool duplicateInput = false)
{
    // Independently encode the historical FCSOCK01/v1 layout. New production
    // encoders emit FCCTRL11; using one would not test real migration.
    std::string error;
    auto combined_json = legacy_controller_json(combined);
    auto sockets_json = copy(field(combined_json.get(), "sockets"));
    REQUIRE(sockets_json);
    std::uint32_t revision = 0;
    REQUIRE(socket_record_revision(combined, revision, error));
    SettingsBytes bytes = {'F', 'C', 'S', 'O', 'C', 'K', '0', '1', 1, 0};
    const auto append_number = [&](std::uint32_t value) {
        for (unsigned i = 0; i < 4; ++i)
            bytes.push_back(static_cast<std::uint8_t>(value >> (i * 8)));
    };
    const auto append_text = [&](const std::string& value) {
        REQUIRE(value.size() <= 255);
        bytes.push_back(static_cast<std::uint8_t>(value.size()));
        bytes.insert(bytes.end(), value.begin(), value.end());
    };
    append_number(revision);
    bytes.push_back(cJSON_IsTrue(field(sockets_json.get(), "enabled")));
    append_text("wifi-relay-16-r2-stack");
    const auto* rows = field(sockets_json.get(), "items");
    bytes.push_back(static_cast<std::uint8_t>(cJSON_GetArraySize(rows)));
    unsigned index = 0;
    for (const auto* row = rows->child; row; row = row->next, ++index) {
        append_text(text(row, "id"));
        append_text(text(row, "name"));
        append_text(text(row, "relayId"));
        append_text(duplicateInput && index == 1 ? text(cJSON_GetArrayItem(rows, 0), "inputId")
                                                 : text(row, "inputId"));
        bytes.push_back(cJSON_IsTrue(field(row, "state")));
    }
    std::uint32_t crc = 0xffffffff;
    for (auto byte : bytes) {
        crc ^= byte;
        for (unsigned b = 0; b < 8; ++b)
            crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
    }
    append_number(~crc);
    return bytes;
}

void legacy_profile()
{
    source();
    auto original = snapshot();
    const std::string encoded(original.sections[0].begin(), original.sections[0].end());
    auto config = parse(encoded);
    cJSON_ReplaceItemInObject(mutable_field(config.get(), "hardware"),
                              "boardId",
                              cJSON_CreateString("wifi-relay-16-r2-stack"));
    const auto old = print(config.get());
    REQUIRE(settings_store_set(SettingsSection::Config, SettingsBytes(old.begin(), old.end()))
            == ESP_OK);
    REQUIRE(settings_store_set(SettingsSection::Sockets, legacy_socket_record(original.sections[2]))
            == ESP_OK);
    const auto stored_before_boot = snapshot();
    const auto commits_before_boot = backup_test::nvs_commits();
    boot();
    REQUIRE(config_get().hardware.boardId == "fcplcn-161608-1v0");
    REQUIRE(backup_test::relay(0));
    REQUIRE(!backup_test::relay(1));
    require_controller_migration(stored_before_boot, commits_before_boot);
    REQUIRE(board_profile_find("wifi-relay-16-r2-stack")
            == board_profile_find("fcplcn-161608-1v0"));
    REQUIRE(board_profile_activate("wifi-relay-16-r2-stack"));
    REQUIRE(board_profile_active().id == std::string("fcplcn-161608-1v0"));
    REQUIRE(board_profile_canonical_id("wifi-relay-16-r2-stack-other").empty());
    REQUIRE(board_profile_canonical_id("fcplcn-161608-1v0-other").empty());
    auto out = document();
    REQUIRE(text(out.get(), "boardId") == "fcplcn-161608-1v0");
    REQUIRE(text(field(field(out.get(), "config"), "hardware"), "boardId") == "fcplcn-161608-1v0");
}

void legacy_backup()
{
    source();
    auto old = document();
    cJSON_ReplaceItemInObject(old.get(), "boardId", cJSON_CreateString("wifi-relay-16-r2-stack"));
    cJSON_ReplaceItemInObject(mutable_field(mutable_field(old.get(), "config"), "hardware"),
                              "boardId",
                              cJSON_CreateString("wifi-relay-16-r2-stack"));
    boot(true, 0x445566);
    REQUIRE(restore(old.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(0));
    REQUIRE(config_get().device.name == u8"Котельная");
    auto out = document();
    REQUIRE(text(out.get(), "boardId") == "fcplcn-161608-1v0");
    REQUIRE(text(field(field(out.get(), "config"), "hardware"), "boardId") == "fcplcn-161608-1v0");
    REQUIRE(text(old.get(), "boardId")
            == "wifi-relay-16-r2-stack");  // Import never edits the caller's document.
    auto other = copy(old.get());
    cJSON_ReplaceItemInObject(other.get(), "boardId", cJSON_CreateString("different-board"));
    unchanged_after(other.get(), BackupResult::Conflict);
}

void configure_lights(const std::string& relay = "rly-0/3", const std::string& input = "in-0/3")
{
    Json current(controller_status_json(ControllerKind::Lights), cJSON_Delete);
    REQUIRE(current);
    auto body = parse(
        "{\"baseRevision\":" + std::to_string(field(current.get(), "revision")->valueint)
        + ",\"enabled\":true,\"items\":[{\"id\":\"ceiling\",\"name\":\"Люстра\",\"relayId\":\""
        + relay + "\",\"inputId\":\"" + input + "\"}]}");
    std::string error;
    REQUIRE(controller_update(ControllerKind::Lights, body.get(), error) == SocketResult::Ok);
    REQUIRE(controller_set_state(ControllerKind::Lights, "ceiling", true, error)
            == SocketResult::Ok);
}

void lights_clone()
{
    source();
    configure_lights();
    auto d = document();
    REQUIRE(field(d.get(), "version")->valueint == 10);
    const auto expected = copy(field(d.get(), "controllers"));
    boot(true, 0x445566);
    configure_lights("rly-0/16", "");
    REQUIRE(backup_test::relay(15));
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    REQUIRE(backup_test::relay(15));
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(0) && !backup_test::relay(1) && backup_test::relay(2)
            && !backup_test::relay(15));
    auto actual = document();
    REQUIRE(print(field(actual.get(), "controllers")) == print(expected.get()));
    std::string error;
    REQUIRE(socket_controller_set_relay("rly-0/3", false, error) == SocketResult::Ok);
    boot(false, 0x445566);
    REQUIRE(!backup_test::relay(2) && backup_test::relay(0));
}

void resource_rejection()
{
    source();
    configure_lights();
    auto d = document();
    auto bad = copy(d.get());
    auto* lights =
        mutable_field(mutable_field(mutable_field(bad.get(), "controllers"), "lights"), "items");
    cJSON_ReplaceItemInObject(
        cJSON_GetArrayItem(lights, 0), "relayId", cJSON_CreateString("rly-0/1"));
    unchanged_after(bad.get(), BackupResult::Conflict);
    bad = copy(d.get());
    lights =
        mutable_field(mutable_field(mutable_field(bad.get(), "controllers"), "lights"), "items");
    cJSON_ReplaceItemInObject(
        cJSON_GetArrayItem(lights, 0), "inputId", cJSON_CreateString("in-0/1"));
    unchanged_after(bad.get(), BackupResult::Conflict);
    bad = copy(d.get());
    cJSON_DeleteItemFromObject(mutable_field(bad.get(), "controllers"), "lights");
    unchanged_after(bad.get(), BackupResult::InvalidInput);
}

void legacy_v1()
{
    source();
    auto old = document();
    set_legacy_version(old.get(), 1);
    cJSON_DeleteItemFromObject(mutable_field(old.get(), "controllers"), "lights");
    cJSON_DeleteItemFromObject(mutable_field(old.get(), "controllers"), "meteo");
    cJSON_DeleteItemFromObject(mutable_field(old.get(), "controllers"), "thermostats");
    boot(true, 0x445566);
    configure_lights("rly-0/16", "");
    REQUIRE(restore(old.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(0) && !backup_test::relay(15));
    auto updated = document();
    REQUIRE(field(updated.get(), "version")->valueint == 10);
    const auto* lights = field(field(updated.get(), "controllers"), "lights");
    REQUIRE(cJSON_IsFalse(field(lights, "enabled")));
    REQUIRE(cJSON_GetArraySize(field(lights, "items")) == 0);
}

void legacy_conflict()
{
    source();
    const auto before = snapshot();
    REQUIRE(settings_store_set(SettingsSection::Controllers,
                               legacy_socket_record(before.sections[2], true))
            == ESP_OK);
    boot();
    REQUIRE(backup_test::relay(0) && !backup_test::relay(1));
    Json aggregate(controllers_status_json(), cJSON_Delete);
    REQUIRE(aggregate);
    bool conflict = false;
    for (const auto* r = field(aggregate.get(), "resources")->child; r; r = r->next)
        if (text(r, "id") == "in-0/1")
            conflict = cJSON_IsTrue(field(r, "conflict"));
    REQUIRE(conflict);
    backup_test::input(0, false);
    step();
    step();
    REQUIRE(backup_test::relay(0) && !backup_test::relay(1));
    std::string error;
    REQUIRE(socket_controller_set_state("kitchen", false, error) == SocketResult::Ok);
    boot();
    REQUIRE(!backup_test::relay(0) && !backup_test::relay(1));
    auto exported = document();
    unchanged_after(exported.get(), BackupResult::Conflict);
    sockets(
        u8R"([{"id":"kitchen","name":"Кухня","relayId":"rly-0/1","inputId":"in-0/1"},{"id":"hall","name":"Коридор","relayId":"rly-0/2","inputId":""}])");
    auto clean = document();
    REQUIRE(restore(clean.get()) == BackupResult::Ok);
}

std::string meteo_rom(unsigned serial)
{
    unsigned char bytes[8] = {0x28,
                              static_cast<unsigned char>(serial),
                              static_cast<unsigned char>(serial >> 8),
                              0,
                              0,
                              0,
                              0,
                              0};
    unsigned char crc = 0;
    for (unsigned i = 0; i < 7; ++i) {
        auto byte = bytes[i];
        for (unsigned b = 0; b < 8; ++b) {
            const bool mix = (crc ^ byte) & 1;
            crc >>= 1;
            if (mix)
                crc ^= 0x8c;
            byte >>= 1;
        }
    }
    bytes[7] = crc;
    const char* hex = "0123456789abcdef";
    std::string result;
    for (auto byte : bytes) {
        result += hex[byte >> 4];
        result += hex[byte & 15];
    }
    return result;
}

std::string meteo_items()
{
    return "[{\"id\":\"outside\",\"name\":\"Улица\",\"portId\":\"sens-0/1\",\"sensorType\":\"onewire\",\"address\":\""
           + meteo_rom(1)
           + "\"},{\"id\":\"boiler\",\"name\":\"Котёл\",\"portId\":\"sens-0/1\",\"sensorType\":\"onewire\",\"address\":\""
           + meteo_rom(2)
           + "\"},{\"id\":\"room\",\"name\":\"Комната\",\"portId\":\"sens-0/2\",\"sensorType\":\"dht22\",\"address\":\"\"}]";
}

void configure_meteo(const std::string& rows = meteo_items(), bool enabled = true)
{
    Json current(controller_status_json(ControllerKind::Meteo), cJSON_Delete);
    REQUIRE(current);
    auto body =
        parse("{\"baseRevision\":" + std::to_string(field(current.get(), "revision")->valueint)
              + ",\"enabled\":" + (enabled ? "true" : "false") + ",\"items\":" + rows + "}");
    std::string error;
    REQUIRE(controller_update(ControllerKind::Meteo, body.get(), error) == ControllerResult::Ok);
}

void meteo_clone()
{
    source();
    configure_lights();
    configure_meteo();
    auto d = document();
    REQUIRE(field(d.get(), "version")->valueint == 10);
    const auto expected = copy(field(d.get(), "controllers"));
    const auto* row =
        cJSON_GetArrayItem(field(field(field(d.get(), "controllers"), "meteo"), "items"), 0);
    REQUIRE(!field(row, "temperatureC") && !field(row, "devices") && !field(row, "state"));
    boot(true, 0x445566);
    const auto configure_count = meteo_fake::configure_calls();
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    REQUIRE(!meteo_fake::enabled());
    REQUIRE(meteo_fake::configure_calls() == configure_count);
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(0) && backup_test::relay(2));
    REQUIRE(meteo_fake::enabled() && meteo_fake::configured().size() == 2);
    auto out = document();
    REQUIRE(print(field(out.get(), "controllers")) == print(expected.get()));
    Json status(controller_status_json(ControllerKind::Meteo), cJSON_Delete);
    REQUIRE(
        cJSON_IsNull(field(cJSON_GetArrayItem(field(status.get(), "items"), 0), "temperatureC")));
    REQUIRE(restore(out.get()) == BackupResult::Ok);
    const auto before = snapshot();
    std::string error;
    const auto calls = meteo_fake::configure_calls();
    auto request =
        parse("{\"baseRevision\":" + std::to_string(field(status.get(), "revision")->valueint)
              + ",\"enabled\":false,\"items\":[]}");
    REQUIRE(controller_update(ControllerKind::Meteo, request.get(), error)
            == ControllerResult::Conflict);
    cJSON* scan = nullptr;
    REQUIRE(controller_meteo_scan("sens-0/1", true, scan, error) == ControllerResult::Conflict);
    REQUIRE(!scan && meteo_fake::configure_calls() == calls
            && snapshot().sections == before.sections);
}

void meteo_rejection()
{
    source();
    configure_meteo();
    auto d = document();
    auto bad = copy(d.get());
    cJSON_DeleteItemFromObject(mutable_field(bad.get(), "controllers"), "meteo");
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    auto* rows =
        mutable_field(mutable_field(mutable_field(bad.get(), "controllers"), "meteo"), "items");
    cJSON_ReplaceItemInObject(
        cJSON_GetArrayItem(rows, 0), "address", cJSON_CreateString("2800000000000000"));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    rows = mutable_field(mutable_field(mutable_field(bad.get(), "controllers"), "meteo"), "items");
    cJSON_ReplaceItemInObject(
        cJSON_GetArrayItem(rows, 0), "portId", cJSON_CreateString("sens-0/99"));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(d.get());
    rows = mutable_field(mutable_field(mutable_field(bad.get(), "controllers"), "meteo"), "items");
    cJSON_ReplaceItemInObject(
        cJSON_GetArrayItem(rows, 1), "address", cJSON_CreateString(meteo_rom(1).c_str()));
    unchanged_after(bad.get(), BackupResult::Conflict);
    bad = copy(d.get());
    rows = mutable_field(mutable_field(mutable_field(bad.get(), "controllers"), "meteo"), "items");
    cJSON_ReplaceItemInObject(
        cJSON_GetArrayItem(rows, 2), "portId", cJSON_CreateString("sens-0/1"));
    unchanged_after(bad.get(), BackupResult::Conflict);
}

SettingsBytes legacy_v2_record(const SettingsBytes& current)
{
    std::string error;
    auto json = legacy_controller_json(current);
    std::uint32_t sockets_revision = 0, lights_revision = 0;
    REQUIRE(controllers_record_revisions(current, sockets_revision, lights_revision, error));
    SettingsBytes bytes = {'F', 'C', 'C', 'T', 'R', 'L', '0', '2', 2, 0};
    const auto number = [&](std::uint32_t value) {
        for (unsigned i = 0; i < 4; ++i)
            bytes.push_back(static_cast<std::uint8_t>(value >> (i * 8)));
    };
    const auto string = [&](const std::string& value) {
        bytes.push_back(static_cast<std::uint8_t>(value.size()));
        bytes.insert(bytes.end(), value.begin(), value.end());
    };
    string("wifi-relay-16-r2-stack");
    unsigned index = 0;
    for (const char* name : {"sockets", "lights"}) {
        const auto* module = field(json.get(), name);
        number(index++ == 0 ? sockets_revision : lights_revision);
        bytes.push_back(cJSON_IsTrue(field(module, "enabled")));
        const auto* rows = field(module, "items");
        bytes.push_back(static_cast<std::uint8_t>(cJSON_GetArraySize(rows)));
        for (const auto* row = rows->child; row; row = row->next) {
            string(text(row, "id"));
            string(text(row, "name"));
            string(text(row, "relayId"));
            string(text(row, "inputId"));
            bytes.push_back(cJSON_IsTrue(field(row, "state")));
        }
    }
    std::uint32_t crc = 0xffffffff;
    for (auto byte : bytes) {
        crc ^= byte;
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
    }
    number(~crc);
    return bytes;
}

void legacy_v2_storage()
{
    source();
    configure_lights();
    const auto old = legacy_v2_record(snapshot().sections[2]);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    const auto before = snapshot();
    const auto commits = backup_test::nvs_commits();
    boot();
    REQUIRE(backup_test::relay(0) && backup_test::relay(2));
    require_controller_migration(before, commits);
    REQUIRE(!meteo_fake::enabled());
    auto d = document();
    const auto* meteo = field(field(d.get(), "controllers"), "meteo");
    REQUIRE(cJSON_IsFalse(field(meteo, "enabled"))
            && cJSON_GetArraySize(field(meteo, "items")) == 0);
    configure_meteo();
    const auto upgraded = snapshot().sections[2];
    REQUIRE(std::string(upgraded.begin(), upgraded.begin() + 8) == "FCCTRL11");
    boot();
    REQUIRE(backup_test::relay(0) && backup_test::relay(2) && meteo_fake::enabled());
}

void legacy_v2_backup()
{
    source();
    configure_lights();
    auto d = document();
    set_legacy_version(d.get(), 2);
    cJSON_DeleteItemFromObject(mutable_field(d.get(), "controllers"), "meteo");
    cJSON_DeleteItemFromObject(mutable_field(d.get(), "controllers"), "thermostats");
    boot(true, 0x445566);
    configure_meteo();
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    REQUIRE(meteo_fake::enabled());
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(0) && backup_test::relay(2) && !meteo_fake::enabled());
    auto out = document();
    REQUIRE(field(out.get(), "version")->valueint == 10);
    const auto* meteo = field(field(out.get(), "controllers"), "meteo");
    REQUIRE(cJSON_IsFalse(field(meteo, "enabled"))
            && cJSON_GetArraySize(field(meteo, "items")) == 0);
}

void maximum_meteo()
{
    boot(true);
    const auto host = std::string(63, 'a') + '.' + std::string(63, 'b') + '.' + std::string(63, 'c')
                      + '.' + std::string(61, 'd');
    auto cfg = parse("{}");
    auto* device = cJSON_AddObjectToObject(cfg.get(), "device");
    cJSON_AddStringToObject(device, "name", std::string(64, '\\').c_str());
    auto* wifi = cJSON_AddObjectToObject(cfg.get(), "wifi");
    for (const char* name : {"ap", "sta"}) {
        auto* side = cJSON_AddObjectToObject(wifi, name);
        cJSON_AddStringToObject(side, "ssid", std::string(32, '\\').c_str());
        cJSON_AddStringToObject(side, "password", std::string(63, '\1').c_str());
        if (std::string(name) == "ap") {
            cJSON_AddStringToObject(side, "ip", "192.168.255.253");
            cJSON_AddStringToObject(side, "netmask", "255.255.255.252");
        }
    }
    auto* eth = cJSON_AddObjectToObject(cfg.get(), "ethernet");
    cJSON_AddBoolToObject(eth, "dhcp", false);
    cJSON_AddStringToObject(eth, "ip", "172.168.255.253");
    cJSON_AddStringToObject(eth, "netmask", "255.255.255.252");
    cJSON_AddStringToObject(eth, "gateway", "172.168.255.254");
    cJSON_AddStringToObject(eth, "dns", "255.255.255.255");
    auto* hub = cJSON_AddObjectToObject(cfg.get(), "linux");
    cJSON_AddStringToObject(hub, "host", host.c_str());
    cJSON_AddStringToObject(hub, "username", std::string(128, '\\').c_str());
    cJSON_AddStringToObject(hub, "password", std::string(128, '\\').c_str());
    auto* time = cJSON_AddObjectToObject(cfg.get(), "time");
    cJSON_AddStringToObject(time, "timezone", std::string(96, '\\').c_str());
    cJSON_AddStringToObject(time, "ntpServer", host.c_str());
    configure(print(cfg.get()));
    Json rows(cJSON_CreateArray(), cJSON_Delete);
    for (unsigned i = 1; i <= 16; ++i) {
        const auto n = std::to_string(i);
        auto* row = cJSON_CreateObject();
        cJSON_AddStringToObject(row, "id", (std::string(32 - n.size(), 'r') + n).c_str());
        cJSON_AddStringToObject(row, "name", std::string(64, '\\').c_str());
        cJSON_AddStringToObject(row, "relayId", ("rly-0/" + n).c_str());
        cJSON_AddStringToObject(row, "inputId", ("in-0/" + n).c_str());
        cJSON_AddItemToArray(rows.get(), row);
    }
    sockets(print(rows.get()));
    Json meteo(cJSON_CreateArray(), cJSON_Delete);
    for (unsigned i = 1; i <= 16; ++i) {
        const auto n = std::to_string(i);
        auto* row = cJSON_CreateObject();
        cJSON_AddStringToObject(row, "id", (std::string(32 - n.size(), 'm') + n).c_str());
        cJSON_AddStringToObject(row, "name", std::string(64, '\\').c_str());
        cJSON_AddStringToObject(row, "portId", "sens-0/1");
        cJSON_AddStringToObject(row, "sensorType", "onewire");
        cJSON_AddStringToObject(row, "address", meteo_rom(i).c_str());
        cJSON_AddItemToArray(meteo.get(), row);
    }
    configure_meteo(print(meteo.get()));
    const auto config = snapshot();
    REQUIRE(config.sections[2].size() <= 4096 && config.sections[2].size() > 3800);
    REQUIRE(meteo_fake::configured().size() == 1);
    auto d = document();
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    const auto raw = backup_test::raw_get(kSettingsNvsNamespace, kSettingsNvsKey);
    REQUIRE(raw.size() <= kSettingsMaxBlobBytes && raw.size() > 6500);
    std::cout << "Maximum 16 relay + 16 meteo: controller record " << config.sections[2].size()
              << " B; complete NVS bundle " << raw.size() << "/" << kSettingsMaxBlobBytes << " B\n";
    boot();
    auto out = document();
    REQUIRE(cJSON_GetArraySize(field(field(field(out.get(), "controllers"), "meteo"), "items"))
            == 16);
    REQUIRE(cJSON_GetArraySize(field(field(field(out.get(), "controllers"), "sockets"), "items"))
            == 16);
}

void set_thermostat_enabled(const std::string& id, bool enabled)
{
    std::string error;
    REQUIRE(controller_thermostat_set_enabled(id, enabled, error) == ControllerResult::Ok);
}

void configure_thermostats(const std::string& rows, bool enabled = true, bool arm = true)
{
    Json current(controller_status_json(ControllerKind::Thermostats), cJSON_Delete);
    REQUIRE(current);
    auto items = parse(rows);
    for (auto* row = items->child; row; row = row->next) {
        if (!field(row, "inputId"))
            cJSON_AddStringToObject(row, "inputId", "");
    }
    auto body = parse("{\"baseRevision\":"
                      + std::to_string(field(current.get(), "revision")->valueint) + ",\"enabled\":"
                      + (enabled ? "true" : "false") + ",\"items\":" + print(items.get()) + "}");
    std::string error;
    REQUIRE(controller_update(ControllerKind::Thermostats, body.get(), error)
            == ControllerResult::Ok);
    if (arm)
        for (const auto* row = items->child; row; row = row->next)
            set_thermostat_enabled(text(row, "id"), true);
}

std::string thermostat_items()
{
    return R"([{"id":"heat-1","name":"Тёплый пол","meteoId":"room","relayId":"rly-0/4","inputId":"in-0/4","mode":"heating","setpointC":22.5,"hysteresisC":1},{"id":"heat-2","name":"Радиатор","meteoId":"room","relayId":"rly-0/5","inputId":"in-0/5","mode":"heating","setpointC":23,"hysteresisC":2}])";
}

void raw_room_temperature(double value)
{
    backup_test::advance(1'000);
    MeteoPortReading reading;
    reading.available = true;
    reading.temperatureC = value;
    reading.humidityPct = 55;
    reading.lastSuccessMs = esp_timer_get_time() / 1000;
    meteo_fake::reading("sens-0/2", reading);
    step();
}

void room_temperature(double value)
{
    raw_room_temperature(value);
    for (unsigned second = 0; second < 70; second += 5) {
        Json current(controller_status_json(ControllerKind::Thermostats), cJSON_Delete);
        REQUIRE(current);
        bool waiting = false;
        for (auto* row = field(current.get(), "items")->child; row; row = row->next)
            waiting = waiting || field(row, "holdRemainingSeconds")->valuedouble > 0;
        if (!waiting)
            return;
        backup_test::advance(5'000'000);
        raw_room_temperature(value);
    }
    REQUIRE(false);
}

void thermostat_clone()
{
    source();
    configure_lights();
    configure_meteo();
    configure_thermostats(thermostat_items());
    room_temperature(20);
    REQUIRE(backup_test::relay(3) && backup_test::relay(4));
    auto d = document();
    REQUIRE(field(d.get(), "version")->valueint == 10);
    const auto* saved = field(field(d.get(), "controllers"), "thermostats");
    const auto* row = cJSON_GetArrayItem(field(saved, "items"), 0);
    REQUIRE(!field(row, "state") && !field(row, "actual") && !field(row, "temperatureC"));
    const auto expected = copy(field(d.get(), "controllers"));
    boot(true, 0x445566);
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(0) && backup_test::relay(2));
    REQUIRE(!backup_test::relay(3)
            && !backup_test::relay(4));  // No durable ON demand may be replayed.
    auto out = document();
    REQUIRE(print(field(out.get(), "controllers")) == print(expected.get()));
    const auto commits = backup_test::commits();
    room_temperature(20);
    REQUIRE(backup_test::relay(3) && backup_test::relay(4));
    room_temperature(23);
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    REQUIRE(backup_test::commits() == commits);  // Autonomous transitions never write flash.
    REQUIRE(restore(out.get()) == BackupResult::Ok);
    std::string error;
    auto change = parse("{\"baseRevision\":1,\"enabled\":false,\"items\":[]}");
    REQUIRE(controller_update(ControllerKind::Thermostats, change.get(), error)
            == ControllerResult::Conflict);
}

void thermostat_rejection()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items());
    auto d = document();
    const auto mutate = [&](const char* key, cJSON* replacement, BackupResult result) {
        auto bad = copy(d.get());
        auto* rows = mutable_field(
            mutable_field(mutable_field(bad.get(), "controllers"), "thermostats"), "items");
        cJSON_ReplaceItemInObject(cJSON_GetArrayItem(rows, 0), key, replacement);
        unchanged_after(bad.get(), result);
    };
    mutate("relayId", cJSON_CreateString("rly-0/1"), BackupResult::Conflict);
    mutate("inputId", cJSON_CreateString("in-0/1"), BackupResult::Conflict);
    mutate("inputId", cJSON_CreateString("in-0/99"), BackupResult::InvalidInput);
    mutate("enabled", cJSON_CreateString("yes"), BackupResult::InvalidInput);
    mutate("mode", cJSON_CreateString("drying"), BackupResult::InvalidInput);
    mutate("setpointC", cJSON_CreateNumber(126), BackupResult::InvalidInput);
    mutate("setpointC", cJSON_CreateNumber(22.55), BackupResult::InvalidInput);
    mutate("hysteresisC", cJSON_CreateNumber(0), BackupResult::InvalidInput);
    mutate("hysteresisC", cJSON_CreateNumber(1.5), BackupResult::InvalidInput);
    mutate("hysteresisC", cJSON_CreateNumber(21), BackupResult::InvalidInput);
    mutate("meteoId", cJSON_CreateString("invalid/source"), BackupResult::InvalidInput);
    auto with_obsolete = copy(d.get());
    auto* obsolete_rows = mutable_field(
        mutable_field(mutable_field(with_obsolete.get(), "controllers"), "thermostats"), "items");
    cJSON_AddNumberToObject(cJSON_GetArrayItem(obsolete_rows, 0), "minOnSeconds", 60);
    unchanged_after(with_obsolete.get(), BackupResult::InvalidInput);
    auto bad = copy(d.get());
    cJSON_DeleteItemFromObject(mutable_field(bad.get(), "controllers"), "thermostats");
    unchanged_after(bad.get(), BackupResult::InvalidInput);
}

void thermostat_missing_source()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items());
    room_temperature(20);
    configure_meteo("[]");
    step();
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    auto d = document();
    const auto* saved = field(field(d.get(), "controllers"), "thermostats");
    REQUIRE(text(cJSON_GetArrayItem(field(saved, "items"), 0), "meteoId") == "room");
    boot(true, 0x445566);
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    Json status(controller_status_json(ControllerKind::Thermostats), cJSON_Delete);
    REQUIRE(status);
    const auto* row = cJSON_GetArrayItem(field(status.get(), "items"), 0);
    REQUIRE(cJSON_IsFalse(field(row, "sensorAvailable")) && cJSON_IsNull(field(row, "temperatureC"))
            && !text(row, "error").empty());
    configure_meteo();
    room_temperature(20);
    REQUIRE(backup_test::relay(3) && backup_test::relay(4));
}

SettingsBytes legacy_v3_record(const SettingsBytes& current)
{
    std::string error;
    auto json = legacy_controller_json(current);
    std::uint32_t sr = 0, lr = 0, mr = 0;
    REQUIRE(controllers_record_revisions(current, sr, lr, mr, error));
    SettingsBytes bytes = {'F', 'C', 'C', 'T', 'R', 'L', '0', '3', 3, 0};
    const auto number = [&](std::uint32_t value) {
        for (unsigned i = 0; i < 4; ++i)
            bytes.push_back(static_cast<std::uint8_t>(value >> (i * 8)));
    };
    const auto string = [&](const std::string& value) {
        bytes.push_back(static_cast<std::uint8_t>(value.size()));
        bytes.insert(bytes.end(), value.begin(), value.end());
    };
    string("wifi-relay-16-r2-stack");
    unsigned index = 0;
    const unsigned revisions[] = {sr, lr, mr};
    for (const char* name : {"sockets", "lights", "meteo"}) {
        const auto* module = field(json.get(), name);
        number(revisions[index++]);
        bytes.push_back(cJSON_IsTrue(field(module, "enabled")));
        const auto* rows = field(module, "items");
        bytes.push_back(static_cast<std::uint8_t>(cJSON_GetArraySize(rows)));
        for (const auto* row = rows->child; row; row = row->next) {
            string(text(row, "id"));
            string(text(row, "name"));
            if (std::string(name) == "meteo") {
                string(text(row, "portId"));
                bytes.push_back(text(row, "sensorType") == "dht22" ? 1 : 2);
                string(text(row, "address"));
            } else {
                string(text(row, "relayId"));
                string(text(row, "inputId"));
                bytes.push_back(cJSON_IsTrue(field(row, "state")));
            }
        }
    }
    std::uint32_t crc = 0xffffffff;
    for (auto byte : bytes) {
        crc ^= byte;
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
    }
    number(~crc);
    return bytes;
}

void legacy_v3_storage()
{
    source();
    configure_lights();
    configure_meteo();
    configure_thermostats(thermostat_items());
    const auto old = legacy_v3_record(snapshot().sections[2]);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    const auto before = snapshot();
    const auto commits = backup_test::nvs_commits();
    boot();
    require_controller_migration(before, commits);
    REQUIRE(backup_test::relay(0) && backup_test::relay(2) && !backup_test::relay(3)
            && !backup_test::relay(4));
    auto out = document();
    const auto* thermostats = field(field(out.get(), "controllers"), "thermostats");
    REQUIRE(cJSON_IsFalse(field(thermostats, "enabled"))
            && cJSON_GetArraySize(field(thermostats, "items")) == 0);
    REQUIRE(cJSON_GetArraySize(field(field(field(out.get(), "controllers"), "meteo"), "items"))
            == 3);
}

void legacy_v3_backup()
{
    source();
    configure_lights();
    configure_meteo();
    auto d = document();
    set_legacy_version(d.get(), 3);
    cJSON_DeleteItemFromObject(mutable_field(d.get(), "controllers"), "thermostats");
    boot(true, 0x445566);
    configure_meteo();
    configure_thermostats(thermostat_items());
    room_temperature(20);
    REQUIRE(backup_test::relay(3));
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    const auto staged = snapshot();
    const auto commits = backup_test::commits();
    step();
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    REQUIRE(snapshot().sections == staged.sections && backup_test::commits() == commits
            && settings_restore_pending());
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(0) && backup_test::relay(2) && !backup_test::relay(3)
            && !backup_test::relay(4));
    auto out = document();
    REQUIRE(field(out.get(), "version")->valueint == 10);
    const auto* thermostats = field(field(out.get(), "controllers"), "thermostats");
    REQUIRE(cJSON_IsFalse(field(thermostats, "enabled"))
            && cJSON_GetArraySize(field(thermostats, "items")) == 0);
}

void maximum_thermostats()
{
    maximum_meteo();
    sockets("[]");
    Json rows(cJSON_CreateArray(), cJSON_Delete);
    const auto meteoId = std::string(31, 'm') + "1";
    for (unsigned i = 1; i <= 16; ++i) {
        const auto n = std::to_string(i);
        auto* row = cJSON_CreateObject();
        cJSON_AddStringToObject(row, "id", (std::string(32 - n.size(), 't') + n).c_str());
        cJSON_AddStringToObject(row, "name", std::string(64, '\\').c_str());
        cJSON_AddStringToObject(row, "meteoId", meteoId.c_str());
        cJSON_AddStringToObject(row, "relayId", ("rly-0/" + n).c_str());
        cJSON_AddStringToObject(row, "inputId", ("in-0/" + n).c_str());
        cJSON_AddStringToObject(row, "mode", i % 2 ? "heating" : "cooling");
        cJSON_AddNumberToObject(row, "setpointC", i % 2 ? -55 : 125);
        cJSON_AddNumberToObject(row, "hysteresisC", 20);
        cJSON_AddItemToArray(rows.get(), row);
    }
    configure_thermostats(print(rows.get()));
    const auto configured = snapshot();
    REQUIRE(configured.sections[2].size() > 4096 && configured.sections[2].size() <= 5120);
    auto d = document();
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    const auto raw = backup_test::raw_get(kSettingsNvsNamespace, kSettingsNvsKey);
    REQUIRE(raw.size() > 7168 && raw.size() <= kSettingsMaxBlobBytes);
    std::cout << "Maximum 16 thermostats + 16 meteo: controller record "
              << configured.sections[2].size() << " B; NVS bundle " << raw.size() << "/"
              << kSettingsMaxBlobBytes << " B\n";
    boot();
    auto out = document();
    REQUIRE(print(field(out.get(), "controllers")) == print(field(d.get(), "controllers")));
    for (unsigned i = 0; i < 16; ++i)
        REQUIRE(!backup_test::relay(i));
}

void thermostat_modes_clone()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items(), true, false);
    room_temperature(20);
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    Json status(controller_status_json(ControllerKind::Thermostats), cJSON_Delete);
    const auto revision = field(status.get(), "revision")->valueint;
    for (const auto* row = field(status.get(), "items")->child; row; row = row->next)
        REQUIRE(cJSON_IsFalse(field(row, "enabled")));
    const auto commits = backup_test::commits();
    backup_test::input(3, false);
    step();
    step();
    step();
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    status.reset(controller_status_json(ControllerKind::Thermostats));
    REQUIRE(cJSON_IsTrue(field(cJSON_GetArrayItem(field(status.get(), "items"), 0), "enabled")));
    room_temperature(20);
    REQUIRE(backup_test::relay(3) && !backup_test::relay(4));
    REQUIRE(backup_test::commits() == commits + 1);
    status.reset(controller_status_json(ControllerKind::Thermostats));
    REQUIRE(field(status.get(), "revision")->valueint == revision);
    auto d = document();
    const auto* rows = field(field(field(d.get(), "controllers"), "thermostats"), "items");
    REQUIRE(cJSON_IsTrue(field(cJSON_GetArrayItem(rows, 0), "enabled"))
            && cJSON_IsFalse(field(cJSON_GetArrayItem(rows, 1), "enabled")));
    REQUIRE(text(cJSON_GetArrayItem(rows, 0), "inputId") == "in-0/4");
    boot(true, 0x445566);
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    room_temperature(20);
    REQUIRE(backup_test::relay(3) && !backup_test::relay(4));
    auto out = document();
    REQUIRE(print(field(out.get(), "controllers")) == print(field(d.get(), "controllers")));
}

SettingsBytes
legacy_v4_record(const SettingsBytes& current, bool version5 = false, bool version6 = false)
{
    auto bytes = legacy_v3_record(current);
    bytes.resize(bytes.size() - 4);
    bytes[7] = version6 ? '6' : version5 ? '5' : '4';
    bytes[8] = version6 ? 6 : version5 ? 5 : 4;
    const auto number = [&](std::uint32_t value) {
        for (unsigned i = 0; i < 4; ++i)
            bytes.push_back(static_cast<std::uint8_t>(value >> (i * 8)));
    };
    const auto string = [&](const std::string& value) {
        bytes.push_back(static_cast<std::uint8_t>(value.size()));
        bytes.insert(bytes.end(), value.begin(), value.end());
    };
    std::string error;
    auto json = legacy_controller_json(current);
    std::uint32_t sr = 0, lr = 0, mr = 0, tr = 0;
    REQUIRE(controllers_record_revisions(current, sr, lr, mr, tr, error));
    const auto* module = field(json.get(), "thermostats");
    number(tr);
    bytes.push_back(cJSON_IsTrue(field(module, "enabled")));
    const auto* rows = field(module, "items");
    bytes.push_back(static_cast<std::uint8_t>(cJSON_GetArraySize(rows)));
    for (const auto* row = rows->child; row; row = row->next) {
        string(text(row, "id"));
        string(text(row, "name"));
        string(text(row, "meteoId"));
        string(text(row, "relayId"));
        if (version5 || version6) {
            string(text(row, "inputId"));
            bytes.push_back(cJSON_IsTrue(field(row, "enabled")));
        }
        bytes.push_back(text(row, "mode") == "heating" ? 1 : 2);
        const auto tenths = static_cast<std::uint16_t>(
            static_cast<std::int16_t>(std::round(field(row, "setpointC")->valuedouble * 10)));
        bytes.push_back(static_cast<std::uint8_t>(tenths));
        bytes.push_back(static_cast<std::uint8_t>(tenths >> 8));
        bytes.push_back(static_cast<std::uint8_t>(field(row, "hysteresisC")->valueint));
        if (version6) {
            number(0);
            number(86400);
        }
    }
    std::uint32_t crc = 0xffffffff;
    for (auto byte : bytes) {
        crc ^= byte;
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
    }
    number(~crc);
    return bytes;
}

void legacy_v4_storage()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items(), true, false);
    const auto old = legacy_v4_record(snapshot().sections[2]);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    const auto before = snapshot();
    const auto commits = backup_test::nvs_commits();
    boot();
    require_controller_migration(before, commits);
    auto d = document();
    const auto* rows = field(field(field(d.get(), "controllers"), "thermostats"), "items");
    for (const auto* row = rows->child; row; row = row->next) {
        REQUIRE(cJSON_IsTrue(field(row, "enabled")));
        REQUIRE(text(row, "inputId").empty());
    }
    raw_room_temperature(20);
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    backup_test::advance(61'000'000);
    raw_room_temperature(20);
    REQUIRE(backup_test::relay(3) && backup_test::relay(4));
}

void legacy_v4_backup()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items(), true, false);
    auto d = document();
    set_legacy_version(d.get(), 4);
    auto* rows =
        mutable_field(mutable_field(mutable_field(d.get(), "controllers"), "thermostats"), "items");
    for (auto* row = rows->child; row; row = row->next) {
        cJSON_DeleteItemFromObject(row, "inputId");
        cJSON_DeleteItemFromObject(row, "enabled");
        cJSON_DeleteItemFromObject(row, "minOnSeconds");
        cJSON_DeleteItemFromObject(row, "minOffSeconds");
    }
    auto bad = copy(d.get());
    auto* badRows = mutable_field(
        mutable_field(mutable_field(bad.get(), "controllers"), "thermostats"), "items");
    cJSON_AddBoolToObject(cJSON_GetArrayItem(badRows, 0), "enabled", false);
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    boot(true, 0x445566);
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    raw_room_temperature(20);
    REQUIRE(!backup_test::relay(3) && !backup_test::relay(4));
    backup_test::advance(61'000'000);
    raw_room_temperature(20);
    REQUIRE(backup_test::relay(3) && backup_test::relay(4));
    auto out = document();
    REQUIRE(field(out.get(), "version")->valueint == 10);
    const auto* restoredRows =
        field(field(field(out.get(), "controllers"), "thermostats"), "items");
    for (const auto* row = restoredRows->child; row; row = row->next) {
        REQUIRE(cJSON_IsTrue(field(row, "enabled")));
        REQUIRE(text(row, "inputId").empty());
    }
}

void legacy_v5_storage()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items());
    const auto old = legacy_v4_record(snapshot().sections[2], true);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    const auto before = snapshot();
    const auto flash_writes = backup_test::nvs_commits();
    boot();
    require_controller_migration(before, flash_writes);
    auto d = document();
    const auto* rows = field(field(field(d.get(), "controllers"), "thermostats"), "items");
    for (const auto* row = rows->child; row; row = row->next) {
        REQUIRE(cJSON_IsTrue(field(row, "enabled")));
        REQUIRE(!field(row, "minOnSeconds"));
        REQUIRE(!field(row, "minOffSeconds"));
    }
    raw_room_temperature(20);
    REQUIRE(!backup_test::relay(3));
    backup_test::advance(61'000'000);
    raw_room_temperature(20);
    REQUIRE(backup_test::relay(3));
}

void legacy_v5_backup()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items());
    auto d = document();
    set_legacy_version(d.get(), 5);
    auto* rows =
        mutable_field(mutable_field(mutable_field(d.get(), "controllers"), "thermostats"), "items");
    for (auto* row = rows->child; row; row = row->next) {
        cJSON_DeleteItemFromObject(row, "minOnSeconds");
        cJSON_DeleteItemFromObject(row, "minOffSeconds");
    }
    boot(true, 0x445566);
    REQUIRE(restore(d.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    auto out = document();
    REQUIRE(field(out.get(), "version")->valueint == 10);
    const auto* restored = field(field(field(out.get(), "controllers"), "thermostats"), "items");
    REQUIRE(!field(cJSON_GetArrayItem(restored, 0), "minOnSeconds"));
    REQUIRE(!field(cJSON_GetArrayItem(restored, 0), "minOffSeconds"));
    auto bad = copy(out.get());
    auto* badRows = mutable_field(
        mutable_field(mutable_field(bad.get(), "controllers"), "thermostats"), "items");
    cJSON_AddNumberToObject(cJSON_GetArrayItem(badRows, 0), "minOnSeconds", 0);
    unchanged_after(bad.get(),
                    BackupResult::InvalidInput);  // Current format has no configurable durations.
}

void legacy_v6_storage()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items());
    const auto old = legacy_v4_record(snapshot().sections[2], false, true);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    const auto before = snapshot();
    const auto commits = backup_test::nvs_commits();
    boot();
    require_controller_migration(before, commits);
    auto output = document();
    REQUIRE(field(output.get(), "version")->valueint == 10);
    const auto* rows = field(field(field(output.get(), "controllers"), "thermostats"), "items");
    for (const auto* row = rows->child; row; row = row->next) {
        REQUIRE(!field(row, "minOnSeconds") && !field(row, "minOffSeconds"));
        REQUIRE(cJSON_IsTrue(field(row, "enabled")));
    }
    raw_room_temperature(20);
    REQUIRE(!backup_test::relay(3));
    for (unsigned i = 0; i < 59; ++i) {
        backup_test::advance(900'000);
        raw_room_temperature(20);
    }
    REQUIRE(!backup_test::relay(3));
    backup_test::advance(2'000'000);
    raw_room_temperature(20);
    REQUIRE(backup_test::relay(3));
    for (unsigned i = 0; i < 61; ++i) {
        backup_test::advance(900'000);
        raw_room_temperature(24);
    }
    REQUIRE(!backup_test::relay(3));  // The obsolete 86400 second minimum ON is ignored.
}

void legacy_v6_backup()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items());
    auto old = document();
    set_legacy_version(old.get(), 6);
    auto* rows = mutable_field(
        mutable_field(mutable_field(old.get(), "controllers"), "thermostats"), "items");
    for (auto* row = rows->child; row; row = row->next) {
        cJSON_AddNumberToObject(row, "minOnSeconds", 86400);
        cJSON_AddNumberToObject(row, "minOffSeconds", 0);
    }
    for (bool missing : {false, true}) {
        auto bad = copy(old.get());
        auto* badrows = mutable_field(
            mutable_field(mutable_field(bad.get(), "controllers"), "thermostats"), "items");
        auto* row = cJSON_GetArrayItem(badrows, 0);
        if (missing)
            cJSON_DeleteItemFromObject(row, "minOnSeconds");
        else
            cJSON_ReplaceItemInObject(row, "minOffSeconds", cJSON_CreateNumber(86401));
        unchanged_after(bad.get(), BackupResult::InvalidInput);
    }
    boot(true, 0x445566);
    REQUIRE(restore(old.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    auto output = document();
    REQUIRE(field(output.get(), "version")->valueint == 10);
    const auto* restored = field(field(field(output.get(), "controllers"), "thermostats"), "items");
    REQUIRE(!field(cJSON_GetArrayItem(restored, 0), "minOnSeconds"));
    REQUIRE(!field(cJSON_GetArrayItem(restored, 0), "minOffSeconds"));
    raw_room_temperature(20);
    REQUIRE(
        !backup_test::relay(3));  // The obsolete zero minimum OFF cannot bypass fixed protection.
    room_temperature(20);
    REQUIRE(backup_test::relay(3));
}

void thermostat_policy_import()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items(), true, false);
    REQUIRE(backup_test::recovery_policy(3) == HardwareRelayRecovery::Controller
            && backup_test::recovery_policy(4) == HardwareRelayRecovery::Controller);
    REQUIRE(backup_test::recovery_policy(0) == HardwareRelayRecovery::Buffered);
    auto saved = document();
    boot(true, 0x445566);
    for (unsigned i = 0; i < 16; ++i)
        REQUIRE(backup_test::recovery_policy(i) == HardwareRelayRecovery::Buffered);
    const auto calls = backup_test::recovery_policy_calls();
    REQUIRE(restore(saved.get()) == BackupResult::Ok);
    const auto staged = snapshot();
    REQUIRE(backup_test::recovery_policy_calls() == calls);
    for (unsigned i = 0; i < 16; ++i)
        REQUIRE(backup_test::recovery_policy(i) == HardwareRelayRecovery::Buffered);
    const auto commits = backup_test::commits();
    boot(false, 0x445566);
    REQUIRE(backup_test::recovery_policy_calls() == calls + 16);
    REQUIRE(backup_test::commits() == commits && snapshot().sections == staged.sections);
    REQUIRE(backup_test::recovery_policy(3) == HardwareRelayRecovery::Controller
            && backup_test::recovery_policy(4) == HardwareRelayRecovery::Controller);
    REQUIRE(backup_test::recovery_policy(0) == HardwareRelayRecovery::Buffered);
    REQUIRE(backup_test::relay(0) && !backup_test::relay(3) && !backup_test::relay(4));
}

void append_record_crc(SettingsBytes& bytes)
{
    std::uint32_t crc = 0xffffffff;
    for (auto byte : bytes) {
        crc ^= byte;
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
    }
    crc = ~crc;
    for (unsigned i = 0; i < 4; ++i)
        bytes.push_back(static_cast<std::uint8_t>(crc >> (i * 8)));
}

SettingsBytes
legacy_four_module_record(const SettingsBytes& current, unsigned version, bool live = true)
{
    REQUIRE(version == 7 || version == 8);
    std::string error;
    Json controllers = live ? legacy_controller_json(current)
                            : Json(controllers_backup_json(current, error), cJSON_Delete);
    REQUIRE(controllers);
    std::uint32_t sr = 0, lr = 0, mr = 0, tr = 0;
    REQUIRE(controllers_record_revisions(current, sr, lr, mr, tr, error));
    SettingsBytes bytes = {'F',
                           'C',
                           'C',
                           'T',
                           'R',
                           'L',
                           '0',
                           static_cast<std::uint8_t>('0' + version),
                           static_cast<std::uint8_t>(version),
                           0};
    if (version == 8) {
        REQUIRE(current.size() > 26);
        bytes.insert(bytes.end(), current.begin() + 10, current.begin() + 26);
    }
    const auto number = [&](std::uint32_t value) {
        for (unsigned i = 0; i < 4; ++i)
            bytes.push_back(static_cast<std::uint8_t>(value >> (i * 8)));
    };
    const auto string = [&](const std::string& value) {
        REQUIRE(value.size() <= 255);
        bytes.push_back(static_cast<std::uint8_t>(value.size()));
        bytes.insert(bytes.end(), value.begin(), value.end());
    };
    string(kDefaultBoardProfileId);
    const std::uint32_t revisions[] = {sr, lr, mr, tr};
    unsigned index = 0;
    for (const char* name : {"sockets", "lights", "meteo", "thermostats"}) {
        const auto* module = field(controllers.get(), name);
        number(revisions[index++]);
        bytes.push_back(cJSON_IsTrue(field(module, "enabled")));
        const auto* rows = field(module, "items");
        bytes.push_back(static_cast<std::uint8_t>(cJSON_GetArraySize(rows)));
        for (const auto* row = rows->child; row; row = row->next) {
            string(text(row, "id"));
            string(text(row, "name"));
            if (std::string(name) == "meteo") {
                string(text(row, "portId"));
                bytes.push_back(text(row, "sensorType") == "dht22" ? 1 : 2);
                string(text(row, "address"));
            } else if (std::string(name) == "thermostats") {
                string(text(row, "meteoId"));
                string(text(row, "relayId"));
                string(text(row, "inputId"));
                bytes.push_back(cJSON_IsTrue(field(row, "enabled")));
                bytes.push_back(text(row, "mode") == "heating" ? 1 : 2);
                const auto target = static_cast<std::uint16_t>(static_cast<std::int16_t>(
                    std::round(field(row, "setpointC")->valuedouble * 10)));
                bytes.push_back(static_cast<std::uint8_t>(target));
                bytes.push_back(static_cast<std::uint8_t>(target >> 8));
                bytes.push_back(static_cast<std::uint8_t>(field(row, "hysteresisC")->valueint));
            } else {
                string(text(row, "relayId"));
                string(text(row, "inputId"));
                bytes.push_back(cJSON_IsTrue(field(row, "state")));
            }
        }
    }
    append_record_crc(bytes);
    return bytes;
}

StateJournalPayload legacy_four_module_states(const cJSON* controllers)
{
    StateJournalPayload bytes{1};
    for (const char* name : {"sockets", "lights", "meteo", "thermostats"}) {
        const auto* rows = field(field(controllers, name), "items");
        const bool operative = std::string(name) != "meteo";
        bytes.push_back(static_cast<std::uint8_t>(operative ? cJSON_GetArraySize(rows) : 0));
        if (operative)
            for (const auto* row = rows->child; row; row = row->next)
                bytes.push_back(cJSON_IsTrue(
                    field(row, std::string(name) == "thermostats" ? "enabled" : "state")));
    }
    return bytes;
}

void legacy_v7_storage()
{
    source();
    configure_meteo();
    configure_thermostats(thermostat_items());
    auto exported = document();
    const auto old = legacy_four_module_record(snapshot().sections[2], 7);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    const auto before = snapshot();
    const auto flash_writes = backup_test::nvs_commits();
    boot();
    require_controller_migration(before, flash_writes);
    REQUIRE(backup_test::relay(0));
    auto restored = document();
    REQUIRE(print(field(restored.get(), "controllers"))
            == print(field(exported.get(), "controllers")));
    backup_test::erase_fram();
    boot();
    REQUIRE(!backup_test::relay(0));
    REQUIRE(backup_test::nvs_commits() == flash_writes + 1);
}

void legacy_v8_storage()
{
    source();
    std::string error;
    REQUIRE(socket_controller_set_state("kitchen", false, error) == SocketResult::Ok);
    configure_lights();
    configure_meteo();
    configure_thermostats(thermostat_items());
    REQUIRE(socket_controller_set_state("kitchen", true, error) == SocketResult::Ok);
    auto exported = document();
    const auto original = snapshot();
    const auto old = legacy_four_module_record(original.sections[2], 8, false);
    StateJournalKey key{};
    std::copy_n(old.begin() + 10, key.size(), key.begin());
    const auto payload = legacy_four_module_states(field(exported.get(), "controllers"));
    REQUIRE(payload[0] == 1);
    REQUIRE(state_journal_save(key, payload) == ESP_OK);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    const auto before = snapshot();
    const auto flash_writes = backup_test::nvs_commits();
    boot();
    require_controller_migration(before, flash_writes);
    REQUIRE(backup_test::relay(0));  // NVS kitchen seed was OFF; last FRAM state was ON.
    auto restored = document();
    REQUIRE(print(field(restored.get(), "controllers"))
            == print(field(exported.get(), "controllers")));
    const auto new_record = snapshot().sections[2];
    StateJournalKey new_key{};
    std::copy_n(new_record.begin() + 10, new_key.size(), new_key.begin());
    REQUIRE(new_key != key);
    StateJournalPayload migrated;
    REQUIRE(state_journal_load(new_key, migrated) == ESP_OK && migrated[0] == 4);
}

void legacy_v8_missing_fram()
{
    source();
    const auto old = legacy_four_module_record(snapshot().sections[2], 8, true);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    backup_test::erase_fram();
    boot();
    REQUIRE(!backup_test::relay(0));  // Missing state cannot resurrect an old ON seed.
    auto restored = document();
    const auto* rows = field(field(field(restored.get(), "controllers"), "sockets"), "items");
    REQUIRE(cJSON_IsFalse(field(cJSON_GetArrayItem(rows, 0), "state")));
    REQUIRE(snapshot().sections[2][8] == kControllerStorageVersion);
}

void legacy_v8_migration_failure()
{
    source();
    std::string error;
    REQUIRE(socket_controller_set_state("kitchen", false, error) == SocketResult::Ok);
    configure_lights();
    REQUIRE(socket_controller_set_state("kitchen", true, error) == SocketResult::Ok);
    auto exported = document();
    const auto old = legacy_four_module_record(snapshot().sections[2], 8, false);
    StateJournalKey key{};
    std::copy_n(old.begin() + 10, key.size(), key.begin());
    REQUIRE(state_journal_save(key, legacy_four_module_states(field(exported.get(), "controllers")))
            == ESP_OK);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    backup_test::fail_commit();
    boot();
    REQUIRE(snapshot().sections[2] == old);
    REQUIRE(!backup_test::relay(0));
    const auto writes = backup_test::fram_commits();
    const auto result = socket_controller_set_state("kitchen", false, error);
    if (result == SocketResult::Ok) {
        REQUIRE(backup_test::fram_commits() > writes);
        boot();
        REQUIRE(!backup_test::relay(0));  // A confirmed OFF cannot restore the pre-migration ON.
    } else {
        REQUIRE(result == SocketResult::StorageError);
        boot();
        REQUIRE(
            backup_test::relay(0));  // Failed migration retained the previous authoritative key.
    }
}

void legacy_v7_backup()
{
    source();
    auto old = document();
    set_legacy_version(old.get(), 7);
    boot(true, 0x445566);
    REQUIRE(restore(old.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(0));
    auto updated = document();
    REQUIRE(field(updated.get(), "version")->valueint == 10);
    const auto* security = field(field(updated.get(), "controllers"), "security");
    REQUIRE(cJSON_IsFalse(field(security, "enabled")) && cJSON_IsFalse(field(security, "armed")));
    REQUIRE(cJSON_GetArraySize(field(security, "keys")) == 0
            && cJSON_GetArraySize(field(security, "items")) == 0);
}

std::string security_key_rom(unsigned serial)
{
    std::uint8_t bytes[8] = {1, static_cast<std::uint8_t>(serial), 0x12, 0x34, 0x56, 0x78, 0x9a, 0};
    std::uint8_t crc = 0;
    for (unsigned i = 0; i < 7; ++i) {
        auto byte = bytes[i];
        for (unsigned bit = 0; bit < 8; ++bit) {
            const auto mix = (crc ^ byte) & 1;
            crc >>= 1;
            if (mix)
                crc ^= 0x8c;
            byte >>= 1;
        }
    }
    bytes[7] = crc;
    constexpr char hex[] = "0123456789abcdef";
    std::string result;
    for (auto byte : bytes) {
        result.push_back(hex[byte >> 4]);
        result.push_back(hex[byte & 15]);
    }
    return result;
}

Json security_status()
{
    Json result(controller_status_json(ControllerKind::Security), cJSON_Delete);
    REQUIRE(result);
    return result;
}

void configure_security(unsigned entryDelay = 0, bool delayed = false)
{
    const auto current = security_status();
    auto request = parse(
        "{\"baseRevision\":" + std::to_string(field(current.get(), "revision")->valueint)
        + ",\"enabled\":true,\"sirenRelayId\":\"rly-0/16\",\"readerPortId\":\"sens-0/8\",\"entryDelaySeconds\":0,\"exitDelaySeconds\":0,\"keys\":[{\"id\":\"owner\",\"name\":\"Хозяин\",\"address\":\""
        + security_key_rom(1)
        + "\"}],\"items\":[{\"id\":\"door\",\"name\":\"Дверь\",\"inputId\":\"in-0/16\",\"sensorType\":\"reed\",\"entryDelay\":false},{\"id\":\"motion\",\"name\":\"Прихожая\",\"inputId\":\"in-0/15\",\"sensorType\":\"motion\",\"entryDelay\":false}]}");
    backup_test::input(15, false);
    backup_test::input(14, true);
    cJSON_ReplaceItemInObject(request.get(), "entryDelaySeconds", cJSON_CreateNumber(entryDelay));
    cJSON_ReplaceItemInObject(cJSON_GetArrayItem(mutable_field(request.get(), "items"), 0),
                              "entryDelay",
                              cJSON_CreateBool(delayed));
    std::string error;
    const auto result = controller_update(ControllerKind::Security, request.get(), error);
    if (result != SocketResult::Ok)
        throw std::runtime_error("Security configure: " + error);
    ibutton_fake::release();
    step();
    step();
    step();
}

void arm_security(bool armed)
{
    std::string error;
    const auto result = controller_security_set_armed(armed, error);
    if (result != SocketResult::Ok)
        throw std::runtime_error("Security arm: " + error);
    step();
}

void trigger_security()
{
    backup_test::input(15, true);
    step();
    step();
    step();
    const auto status = security_status();
    REQUIRE(cJSON_IsTrue(field(status.get(), "armed"))
            && cJSON_IsTrue(field(status.get(), "triggered")));
    REQUIRE(backup_test::relay(15));
}

void security_clone()
{
    source();
    configure_security();
    const auto flash_writes = backup_test::nvs_commits();
    arm_security(true);
    auto armed = document();
    REQUIRE(backup_test::nvs_commits() == flash_writes);
    REQUIRE(cJSON_IsTrue(field(field(field(armed.get(), "controllers"), "security"), "armed")));
    trigger_security();
    auto alarm = document();
    REQUIRE(backup_test::nvs_commits() == flash_writes);
    REQUIRE(field(alarm.get(), "version")->valueint == 10);
    auto expected = copy(field(alarm.get(), "controllers"));
    boot(true, 0x445566);
    REQUIRE(restore(alarm.get()) == BackupResult::Ok);
    const auto staged = snapshot();
    auto staged_export = document();
    REQUIRE(print(field(staged_export.get(), "controllers")) == print(expected.get()));
    boot(false, 0x445566);
    REQUIRE(backup_test::relay(15));
    REQUIRE(backup_test::recovery_policy(15) == HardwareRelayRecovery::Controller);
    auto actual = document();
    REQUIRE(print(field(actual.get(), "controllers")) == print(expected.get()));
    REQUIRE(snapshot().sections == staged.sections);
    arm_security(false);
    REQUIRE(!backup_test::relay(15));
    REQUIRE(restore(armed.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    const auto status = security_status();
    REQUIRE(cJSON_IsTrue(field(status.get(), "armed"))
            && cJSON_IsFalse(field(status.get(), "triggered")));
    REQUIRE(text(status.get(), "phase") == "armed");
}

void security_rejection()
{
    source();
    configure_security();
    configure_meteo();
    auto saved = document();
    auto bad = copy(saved.get());
    auto* security = mutable_field(mutable_field(bad.get(), "controllers"), "security");
    cJSON_AddStringToObject(security, "unknownField", "invalid");
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(saved.get());
    security = mutable_field(mutable_field(bad.get(), "controllers"), "security");
    auto* key = cJSON_GetArrayItem(mutable_field(security, "keys"), 0);
    cJSON_ReplaceItemInObject(key, "address", cJSON_CreateString("0100000000000000"));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(saved.get());
    security = mutable_field(mutable_field(bad.get(), "controllers"), "security");
    key = cJSON_GetArrayItem(mutable_field(security, "keys"), 0);
    cJSON_ReplaceItemInObject(key, "address", cJSON_CreateString(meteo_rom(1).c_str()));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    bad = copy(saved.get());
    security = mutable_field(mutable_field(bad.get(), "controllers"), "security");
    cJSON_ReplaceItemInObject(security, "sirenRelayId", cJSON_CreateString("rly-0/1"));
    unchanged_after(bad.get(), BackupResult::Conflict);
    bad = copy(saved.get());
    security = mutable_field(mutable_field(bad.get(), "controllers"), "security");
    cJSON_ReplaceItemInObject(security, "readerPortId", cJSON_CreateString("sens-0/1"));
    unchanged_after(bad.get(), BackupResult::Conflict);
    bad = copy(saved.get());
    security = mutable_field(mutable_field(bad.get(), "controllers"), "security");
    cJSON_ReplaceItemInObject(cJSON_GetArrayItem(mutable_field(security, "items"), 0),
                              "inputId",
                              cJSON_CreateString("in-0/1"));
    unchanged_after(bad.get(), BackupResult::Conflict);
    bad = copy(saved.get());
    security = mutable_field(mutable_field(bad.get(), "controllers"), "security");
    cJSON_ReplaceItemInObject(security, "triggered", cJSON_CreateBool(true));
    unchanged_after(bad.get(), BackupResult::InvalidInput);
    const auto before = backup_test::commits();
    ibutton_fake::release();
    step();
    ibutton_fake::key(security_key_rom(2));
    step();
    const auto status = security_status();
    REQUIRE(cJSON_IsFalse(field(status.get(), "armed")) && !backup_test::relay(15));
    REQUIRE(!text(status.get(), "lastKeyError").empty());
    REQUIRE(backup_test::commits() == before);
}

void security_entry_backup()
{
    source();
    configure_security(15, true);
    arm_security(true);
    backup_test::input(15, true);
    step();
    step();
    step();
    const auto entering = security_status();
    REQUIRE(text(entering.get(), "phase") == "entry_delay");
    REQUIRE(cJSON_IsTrue(field(entering.get(), "triggered")) && !backup_test::relay(15));
    auto saved = document();
    boot(true, 0x445566);
    REQUIRE(restore(saved.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    const auto restored = security_status();
    REQUIRE(text(restored.get(), "phase") == "alarm");
    REQUIRE(cJSON_IsTrue(field(restored.get(), "armed"))
            && cJSON_IsTrue(field(restored.get(), "triggered")));
    REQUIRE(backup_test::relay(15));  // Portable restore cannot create a fresh quiet entry delay.
}

void security_atomic_failure()
{
    source();
    configure_security();
    auto off = document();
    arm_security(true);
    trigger_security();
    auto before = snapshot();
    backup_test::fail_fram_commit();
    REQUIRE(restore(off.get()) == BackupResult::StorageError);
    REQUIRE(snapshot().sections == before.sections && !settings_restore_pending());
    for (unsigned i = 0; i < 3; ++i) {
        backup_test::fail_commit();
        REQUIRE(restore(off.get()) == BackupResult::StorageError);
        REQUIRE(snapshot().sections == before.sections && !settings_restore_pending());
    }
    boot(false);
    auto status = security_status();
    REQUIRE(cJSON_IsTrue(field(status.get(), "armed"))
            && cJSON_IsTrue(field(status.get(), "triggered")));
    REQUIRE(backup_test::relay(15));
    REQUIRE(restore(off.get()) == BackupResult::Ok);
    boot(false);
    status = security_status();
    REQUIRE(cJSON_IsFalse(field(status.get(), "armed"))
            && cJSON_IsFalse(field(status.get(), "triggered")));
    REQUIRE(!backup_test::relay(15));
}

void fram_export_restore()
{
    source();
    const auto flash_writes = backup_test::nvs_commits();
    const auto before = snapshot();
    std::string error;
    REQUIRE(socket_controller_set_state("kitchen", false, error) == SocketResult::Ok);
    auto off = document();
    const auto* rows = field(field(field(off.get(), "controllers"), "sockets"), "items");
    REQUIRE(cJSON_IsFalse(field(cJSON_GetArrayItem(rows, 0), "state")));
    REQUIRE(snapshot().sections == before.sections);
    REQUIRE(socket_controller_set_state("kitchen", true, error) == SocketResult::Ok);
    auto on = document();
    rows = field(field(field(on.get(), "controllers"), "sockets"), "items");
    REQUIRE(cJSON_IsTrue(field(cJSON_GetArrayItem(rows, 0), "state")));
    REQUIRE(backup_test::nvs_commits() == flash_writes);
    REQUIRE(restore(off.get()) == BackupResult::Ok);
    const auto staged = snapshot();
    REQUIRE(staged.sections[2] != before.sections[2]);
    auto staged_export = document();
    rows = field(field(field(staged_export.get(), "controllers"), "sockets"), "items");
    REQUIRE(cJSON_IsFalse(field(cJSON_GetArrayItem(rows, 0), "state")));
    boot(false);
    REQUIRE(!backup_test::relay(0));
    REQUIRE(restore(on.get()) == BackupResult::Ok);
    boot(false);
    REQUIRE(backup_test::relay(0));
}

void fram_export_fault_recovery()
{
    source();
    const auto flash_writes = backup_test::nvs_commits();
    backup_test::set_fram_present(false);
    std::string error;
    Json failed(backup_export_json(error), cJSON_Delete);
    REQUIRE(!failed && !error.empty());
    REQUIRE(socket_controller_set_state("kitchen", true, error) == SocketResult::StorageError);
    REQUIRE(backup_test::nvs_commits() == flash_writes);
    backup_test::set_fram_present(true);
    const auto fram_writes = backup_test::fram_commits();
    REQUIRE(socket_controller_set_state("kitchen", true, error) == SocketResult::Ok);
    REQUIRE(error.empty() && backup_test::fram_commits() > fram_writes);
    REQUIRE(backup_test::nvs_commits() == flash_writes);
    auto healed = document();
    const auto* rows = field(field(field(healed.get(), "controllers"), "sockets"), "items");
    REQUIRE(cJSON_IsTrue(field(cJSON_GetArrayItem(rows, 0), "state")));
    boot(false);
    REQUIRE(backup_test::relay(0));
}

void fram_restore_failure()
{
    source();
    auto saved = document();
    auto before = snapshot();
    backup_test::fail_fram_commit();
    REQUIRE(restore(saved.get()) == BackupResult::StorageError);
    REQUIRE(snapshot().sections == before.sections);
    REQUIRE(!settings_restore_pending());
    for (unsigned i = 0; i < 3; ++i) {
        backup_test::fail_commit();
        REQUIRE(restore(saved.get()) == BackupResult::StorageError);
        REQUIRE(snapshot().sections == before.sections);
        REQUIRE(!settings_restore_pending());
    }
    boot(false);
    REQUIRE(backup_test::relay(0));
    REQUIRE(restore(saved.get()) == BackupResult::Ok);
    boot(false);
    REQUIRE(backup_test::relay(0));
}

void legacy_v9_storage()
{
    source();
    configure_lights();
    configure_meteo();
    configure_thermostats(thermostat_items());
    configure_security();
    arm_security(true);
    trigger_security();
    auto exported = document();
    auto old = snapshot().sections[2];
    // Reconstruct the five-module V9 fixture without tanks or irrigation.
    REQUIRE(old.size() > 40 && old[8] == 11);
    old.resize(old.size() - 16);
    old[6] = '0';
    old[7] = '9';
    old[8] = 9;
    append_record_crc(old);
    StateJournalKey key{};
    std::copy_n(old.begin() + 10, key.size(), key.begin());
    StateJournalPayload payload;
    REQUIRE(state_journal_load(key, payload) == ESP_OK && payload[0] == 4 && payload.back() == 0);
    payload[0] = 2;
    payload.pop_back();  // irrigation count
    REQUIRE(payload.back() == 0);
    payload.pop_back();  // tank count
    REQUIRE(state_journal_save(key, payload) == ESP_OK);
    REQUIRE(settings_store_set(SettingsSection::Controllers, old) == ESP_OK);
    const auto before = snapshot();
    const auto flash_writes = backup_test::nvs_commits();
    boot();
    require_controller_migration(before, flash_writes);
    REQUIRE(backup_test::relay(0) && backup_test::relay(15));
    auto restored = document();
    REQUIRE(print(field(restored.get(), "controllers"))
            == print(field(exported.get(), "controllers")));
    const auto* modules = field(restored.get(), "controllers");
    REQUIRE(cJSON_IsTrue(field(field(modules, "security"), "armed")));
    REQUIRE(cJSON_IsTrue(field(field(modules, "security"), "triggered")));
    const auto* thermostats = field(field(modules, "thermostats"), "items");
    REQUIRE(cJSON_IsTrue(field(cJSON_GetArrayItem(thermostats, 0), "enabled")));
    REQUIRE(cJSON_IsFalse(field(field(modules, "tanks"), "enabled")));
    const auto current = snapshot().sections[2];
    StateJournalKey migrated_key{};
    std::copy_n(current.begin() + 10, migrated_key.size(), migrated_key.begin());
    REQUIRE(migrated_key != key);
    REQUIRE(state_journal_load(migrated_key, payload) == ESP_OK && payload[0] == 4);
}

void legacy_v8_backup()
{
    source();
    configure_security();
    arm_security(true);
    auto old = document();
    set_legacy_version(old.get(), 8);
    boot(true, 0x445566);
    REQUIRE(restore(old.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    auto restored = document();
    REQUIRE(field(restored.get(), "version")->valueint == 10);
    const auto* modules = field(restored.get(), "controllers");
    REQUIRE(cJSON_IsTrue(field(field(modules, "security"), "armed")));
    REQUIRE(cJSON_IsFalse(field(field(modules, "tanks"), "enabled")));
    REQUIRE(cJSON_GetArraySize(field(field(modules, "tanks"), "items")) == 0);
}

void configure_tank()
{
    Json current(controller_status_json(ControllerKind::Tanks), cJSON_Delete);
    REQUIRE(current);
    auto request = parse(
        "{\"baseRevision\":" + std::to_string(field(current.get(), "revision")->valueint)
        + R"(,"enabled":true,"items":[{"id":"tank","name":"Запас воды","pumpRelayId":"rly-0/6","valveRelayId":"rly-0/7","levelInputs":["in-0/6","in-0/7","in-0/8"],"fillLevel":3}]})");
    std::string error;
    REQUIRE(controller_update(ControllerKind::Tanks, request.get(), error) == ControllerResult::Ok);
    REQUIRE(controller_tank_set_enabled("tank", true, error) == ControllerResult::Ok);
    backup_test::input(5, false);
    for (unsigned n = 0; n < 4; ++n)
        step();
    REQUIRE(backup_test::relay(5) && backup_test::relay(6));
}

void tank_clone()
{
    source();
    configure_tank();
    auto saved = document();
    const auto* tank = field(field(field(saved.get(), "controllers"), "tanks"), "items")->child;
    REQUIRE(cJSON_IsTrue(field(tank, "enabled")));
    REQUIRE(!field(tank, "levelPct") && !field(tank, "pumpActual") && !field(tank, "levelsWet"));
    boot(true, 0x445566);
    REQUIRE(restore(saved.get()) == BackupResult::Ok);
    const auto staged = snapshot();
    boot(false, 0x445566);
    REQUIRE(!backup_test::relay(5) && !backup_test::relay(6));  // No imported ON demand.
    REQUIRE(snapshot().sections == staged.sections);
    REQUIRE(backup_test::recovery_policy(5) == HardwareRelayRecovery::Controller);
    REQUIRE(backup_test::recovery_policy(6) == HardwareRelayRecovery::Controller);
    auto restored = document();
    REQUIRE(print(field(restored.get(), "controllers"))
            == print(field(saved.get(), "controllers")));
    backup_test::input(5, false);
    for (unsigned n = 0; n < 4; ++n)
        step();
    REQUIRE(backup_test::relay(5) && backup_test::relay(6));
    auto invalid = copy(saved.get());
    auto* row =
        mutable_field(mutable_field(mutable_field(invalid.get(), "controllers"), "tanks"), "items")
            ->child;
    cJSON_ReplaceItemInObject(row, "valveRelayId", cJSON_CreateString("rly-0/1"));
    unchanged_after(invalid.get(), BackupResult::Conflict);
}

void legacy_v10_tank_storage()
{
    source();
    configure_tank();
    const auto saved = document();
    auto record = snapshot().sections[2];
    REQUIRE(record.size() > 40 && record[8] == 11);
    record.resize(record.size() - 10);  // Empty irrigation config (6 bytes) and CRC.
    record[7] = '0';
    record[8] = 10;
    append_record_crc(record);
    StateJournalKey key{};
    std::copy_n(record.begin() + 10, key.size(), key.begin());
    StateJournalPayload payload;
    REQUIRE(state_journal_load(key, payload) == ESP_OK && payload[0] == 4 && payload.back() == 0);
    payload.pop_back();
    payload[0] = 3;
    REQUIRE(state_journal_save(key, payload) == ESP_OK);
    REQUIRE(settings_store_set(SettingsSection::Controllers, record) == ESP_OK);
    const auto before = snapshot();
    const auto writes = backup_test::nvs_commits();
    boot();
    require_controller_migration(before, writes);
    auto migrated = document();
    REQUIRE(print(field(saved.get(), "controllers"))
            == print(field(migrated.get(), "controllers")));

    set_legacy_version(migrated.get(), 9);
    boot(true, 0x445566);
    REQUIRE(restore(migrated.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    auto restored = document();
    REQUIRE(print(field(saved.get(), "controllers"))
            == print(field(restored.get(), "controllers")));
}

void irrigation_clone()
{
    source();
    configure_tank();
    Json current(controller_status_json(ControllerKind::Irrigation), cJSON_Delete);
    auto request = parse(
        "{\"baseRevision\":" + std::to_string(field(current.get(), "revision")->valueint)
        + R"(,"enabled":true,"items":[{"id":"garden","name":"Сад","relayId":"rly-0/8","tankId":"tank","days":[1,3,7],"startTime":"07:30","durationMinutes":12},{"id":"lawn","name":"Газон","relayId":"rly-0/9","days":[2,6],"startTime":"07:45","durationMinutes":10}]})");
    std::string error;
    REQUIRE(controller_update(ControllerKind::Irrigation, request.get(), error)
            == ControllerResult::Ok);
    REQUIRE(controller_irrigation_set_enabled("garden", true, error) == ControllerResult::Ok);
    REQUIRE(controller_irrigation_set_enabled("lawn", true, error) == ControllerResult::Ok);
    const auto saved = document();
    const auto* modules = field(saved.get(), "controllers");
    const auto* rule = field(field(modules, "irrigation"), "items")->child;
    REQUIRE(cJSON_IsTrue(field(rule, "enabled")));
    REQUIRE(!field(rule, "actual") && !field(rule, "waterAvailable")
            && !field(rule, "remainingSeconds"));
    const auto* unbound = rule->next;
    REQUIRE(text(unbound, "tankId").empty() && cJSON_IsTrue(field(unbound, "enabled")));
    auto portable = copy(saved.get());
    auto* entries = mutable_field(
        mutable_field(mutable_field(portable.get(), "controllers"), "irrigation"), "items");
    cJSON_DeleteItemFromObject(cJSON_GetArrayItem(entries, 1), "tankId");
    boot(true, 0x445566);
    REQUIRE(restore(portable.get()) == BackupResult::Ok);
    boot(false, 0x445566);
    auto restored = document();
    REQUIRE(print(modules) == print(field(restored.get(), "controllers")));
    REQUIRE(!backup_test::relay(7) && !backup_test::relay(8));
    auto invalid = copy(saved.get());
    auto* row =
        mutable_field(mutable_field(mutable_field(invalid.get(), "controllers"), "irrigation"),
                      "items")
            ->child;
    cJSON_ReplaceItemInObject(row, "tankId", cJSON_CreateString("unknown"));
    REQUIRE(restore(invalid.get()) != BackupResult::Ok);
    REQUIRE(!settings_restore_pending());
}

}  // namespace

int main(int argc, char** argv)
{
    const std::vector<std::pair<std::string, std::function<void()>>> cases = {
        {"legacy_v9_storage", legacy_v9_storage},
        {"legacy_v8_backup", legacy_v8_backup},
        {"tank_clone", tank_clone},
        {"legacy_v10_tank_storage", legacy_v10_tank_storage},
        {"irrigation_clone", irrigation_clone},
        {"defaults", defaults},
        {"clone", clone},
        {"rejection", rejection},
        {"failed_commit", failed_commit},
        {"cas", cas},
        {"pending", pending},
        {"migration", migration},
        {"migration_failure", migration_failure},
        {"corrupt_store", corrupt_store},
        {"maximum", maximum},
        {"gate", gate},
        {"allocation_failure", allocation_failure},
        {"legacy_profile", legacy_profile},
        {"legacy_backup", legacy_backup},
        {"lights_clone", lights_clone},
        {"resource_rejection", resource_rejection},
        {"legacy_v1", legacy_v1},
        {"legacy_conflict", legacy_conflict},
        {"meteo_clone", meteo_clone},
        {"meteo_rejection", meteo_rejection},
        {"legacy_v2_storage", legacy_v2_storage},
        {"legacy_v2_backup", legacy_v2_backup},
        {"maximum_meteo", maximum_meteo},
        {"thermostat_clone", thermostat_clone},
        {"thermostat_rejection", thermostat_rejection},
        {"thermostat_missing_source", thermostat_missing_source},
        {"legacy_v3_storage", legacy_v3_storage},
        {"legacy_v3_backup", legacy_v3_backup},
        {"maximum_thermostats", maximum_thermostats},
        {"thermostat_modes_clone", thermostat_modes_clone},
        {"legacy_v4_storage", legacy_v4_storage},
        {"legacy_v4_backup", legacy_v4_backup},
        {"legacy_v5_storage", legacy_v5_storage},
        {"legacy_v5_backup", legacy_v5_backup},
        {"legacy_v6_storage", legacy_v6_storage},
        {"legacy_v6_backup", legacy_v6_backup},
        {"thermostat_policy_import", thermostat_policy_import},
        {"legacy_v7_storage", legacy_v7_storage},
        {"legacy_v7_backup", legacy_v7_backup},
        {"legacy_v8_storage", legacy_v8_storage},
        {"legacy_v8_missing_fram", legacy_v8_missing_fram},
        {"legacy_v8_migration_failure", legacy_v8_migration_failure},
        {"security_clone", security_clone},
        {"security_rejection", security_rejection},
        {"security_atomic_failure", security_atomic_failure},
        {"security_entry_backup", security_entry_backup},
        {"fram_export_restore", fram_export_restore},
        {"fram_restore_failure", fram_restore_failure},
        {"fram_export_fault_recovery", fram_export_fault_recovery}};
    try {
        REQUIRE(argc == 2);
        for (auto& c : cases)
            if (c.first == argv[1]) {
                c.second();
                std::cout << "PASS FCPLCn full backup " << c.first << '\n';
                return 0;
            }
        throw std::runtime_error("Unknown case");
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
