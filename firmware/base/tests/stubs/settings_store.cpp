// Module-unit-test adapter. Keep the existing per-module fake NVS fixtures and
// failure injection; tests/backup links the real bundled store and import gate.
#include "config/settings_store.h"
#include <nvs.h>
#include <mutex>
#include <string>

namespace {
std::mutex store_mutex;
constexpr const char* spaces[] = {"fcplcn_cfg", "fcplcn_auth", "fcplcn_sockets"};
constexpr const char* keys[] = {"config", "account", "runtime"};
}  // namespace

esp_err_t settings_store_init()
{
    return ESP_OK;
}

bool settings_restore_pending()
{
    return false;
}

SettingsWriteGuard::SettingsWriteGuard() : entered_(true)
{
}

SettingsWriteGuard::~SettingsWriteGuard() = default;

esp_err_t settings_store_get(SettingsSection section, SettingsBytes& bytes)
{
    std::lock_guard<std::mutex> lock(store_mutex);
    const auto index = static_cast<std::size_t>(section);
    if (index >= 3)
        return ESP_ERR_INVALID_ARG;
    nvs_handle_t handle;
    auto result = nvs_open(spaces[index], NVS_READONLY, &handle);
    if (result != ESP_OK)
        return result;
    std::size_t length = 0;
    result = index == 0 ? nvs_get_str(handle, keys[index], nullptr, &length)
                        : nvs_get_blob(handle, keys[index], nullptr, &length);
    if (result == ESP_OK && (length == 0 || length > 8192))
        result = ESP_ERR_INVALID_SIZE;
    if (result == ESP_OK) {
        bytes.resize(length);
        result =
            index == 0
                ? nvs_get_str(handle, keys[index], reinterpret_cast<char*>(bytes.data()), &length)
                : nvs_get_blob(handle, keys[index], bytes.data(), &length);
        if (result == ESP_OK && index == 0) {
            if (bytes.back() != 0)
                result = ESP_ERR_INVALID_RESPONSE;
            else
                bytes.pop_back();
        }
    }
    nvs_close(handle);
    return result;
}

esp_err_t settings_store_set(SettingsSection section, const SettingsBytes& bytes)
{
    std::lock_guard<std::mutex> lock(store_mutex);
    const auto index = static_cast<std::size_t>(section);
    if (index >= 3 || bytes.empty())
        return ESP_ERR_INVALID_ARG;
    nvs_handle_t handle;
    auto result = nvs_open(spaces[index], NVS_READWRITE, &handle);
    if (result != ESP_OK)
        return result;
    if (index == 0) {
        const std::string value(bytes.begin(), bytes.end());
        result = nvs_set_str(handle, keys[index], value.c_str());
    } else
        result = nvs_set_blob(handle, keys[index], bytes.data(), bytes.size());
    if (result == ESP_OK)
        result = nvs_commit(handle);
    nvs_close(handle);
    return result;
}

esp_err_t settings_store_snapshot(SettingsSnapshot& snapshot)
{
    SettingsSnapshot result;
    result.generation = 1;
    for (std::size_t i = 0; i < result.sections.size(); ++i) {
        const auto error = settings_store_get(static_cast<SettingsSection>(i), result.sections[i]);
        if (error != ESP_OK && error != ESP_ERR_NVS_NOT_FOUND)
            return error;
    }
    snapshot = std::move(result);
    return ESP_OK;
}
