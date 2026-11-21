#include "test_platform.h"
#include "esp_mac.h"
#include "nvs.h"

#include <algorithm>
#include <cstring>
#include <map>

namespace {
using Values = std::map<std::string, std::string>;

struct Handle {
    std::string name;
    nvs_open_mode_t mode;
    Values pending;
};

std::map<std::string, Values> committed;
std::map<nvs_handle_t, Handle> handles;
nvs_handle_t next_handle = 1;
esp_err_t next_commit_error = ESP_OK;
esp_err_t next_mac_error = ESP_OK;
unsigned commits = 0;
}  // namespace

namespace test_platform {
void reset()
{
    committed.clear();
    handles.clear();
    next_handle = 1;
    next_commit_error = ESP_OK;
    next_mac_error = ESP_OK;
    commits = 0;
}

void fail_next_commit(esp_err_t error)
{
    next_commit_error = error;
}

void fail_next_mac_read(esp_err_t error)
{
    next_mac_error = error;
}

std::string stored_config()
{
    const auto ns = committed.find("fcplcn_cfg");
    if (ns == committed.end())
        return {};
    const auto value = ns->second.find("config");
    return value == ns->second.end() ? std::string{} : value->second;
}

void replace_stored_config(const std::string& value)
{
    committed["fcplcn_cfg"]["config"] = value;
}

unsigned commit_count()
{
    return commits;
}
}  // namespace test_platform

esp_err_t esp_read_mac(std::uint8_t* mac, esp_mac_type_t)
{
    if (next_mac_error != ESP_OK) {
        const auto result = next_mac_error;
        next_mac_error = ESP_OK;
        return result;
    }
    const std::uint8_t expected[6] = {0xaa, 0xbb, 0xcc, 0x11, 0x22, 0x33};
    std::copy(std::begin(expected), std::end(expected), mac);
    return ESP_OK;
}

esp_err_t nvs_open(const char* name, nvs_open_mode_t mode, nvs_handle_t* result)
{
    if (!name || !result)
        return ESP_ERR_INVALID_ARG;
    if (mode == NVS_READONLY && committed.find(name) == committed.end())
        return ESP_ERR_NVS_NOT_FOUND;
    *result = next_handle++;
    handles.emplace(*result, Handle{name, mode, {}});
    return ESP_OK;
}

esp_err_t nvs_get_str(nvs_handle_t id, const char* key, char* output, std::size_t* length)
{
    const auto handle = handles.find(id);
    if (handle == handles.end() || !key || !length)
        return ESP_ERR_INVALID_ARG;
    const auto ns = committed.find(handle->second.name);
    if (ns == committed.end())
        return ESP_ERR_NVS_NOT_FOUND;
    const auto value = ns->second.find(key);
    if (value == ns->second.end())
        return ESP_ERR_NVS_NOT_FOUND;
    const std::size_t required = value->second.size() + 1;
    if (!output) {
        *length = required;
        return ESP_OK;
    }
    if (*length < required) {
        *length = required;
        return ESP_ERR_NVS_INVALID_LENGTH;
    }
    std::memcpy(output, value->second.c_str(), required);
    *length = required;
    return ESP_OK;
}

esp_err_t nvs_set_str(nvs_handle_t id, const char* key, const char* value)
{
    const auto handle = handles.find(id);
    if (handle == handles.end() || !key || !value)
        return ESP_ERR_INVALID_ARG;
    if (handle->second.mode == NVS_READONLY)
        return ESP_ERR_NVS_READ_ONLY;
    handle->second.pending[key] = value;
    return ESP_OK;
}

esp_err_t nvs_get_blob(nvs_handle_t id, const char* key, void* output, std::size_t* length)
{
    const auto handle = handles.find(id);
    if (handle == handles.end() || !key || !length)
        return ESP_ERR_INVALID_ARG;
    const auto ns = committed.find(handle->second.name);
    if (ns == committed.end())
        return ESP_ERR_NVS_NOT_FOUND;
    const auto value = ns->second.find(key);
    if (value == ns->second.end())
        return ESP_ERR_NVS_NOT_FOUND;
    const auto required = value->second.size();
    if (!output) {
        *length = required;
        return ESP_OK;
    }
    if (*length < required) {
        *length = required;
        return ESP_ERR_NVS_INVALID_LENGTH;
    }
    std::memcpy(output, value->second.data(), required);
    *length = required;
    return ESP_OK;
}

esp_err_t nvs_set_blob(nvs_handle_t id, const char* key, const void* value, std::size_t length)
{
    const auto handle = handles.find(id);
    if (handle == handles.end() || !key || !value)
        return ESP_ERR_INVALID_ARG;
    if (handle->second.mode == NVS_READONLY)
        return ESP_ERR_NVS_READ_ONLY;
    handle->second.pending[key] = std::string(static_cast<const char*>(value), length);
    return ESP_OK;
}

esp_err_t nvs_commit(nvs_handle_t id)
{
    const auto handle = handles.find(id);
    if (handle == handles.end())
        return ESP_ERR_INVALID_ARG;
    if (next_commit_error != ESP_OK) {
        const auto result = next_commit_error;
        next_commit_error = ESP_OK;
        return result;
    }
    auto& destination = committed[handle->second.name];
    for (const auto& entry : handle->second.pending)
        destination[entry.first] = entry.second;
    handle->second.pending.clear();
    ++commits;
    return ESP_OK;
}

void nvs_close(nvs_handle_t id)
{
    handles.erase(id);
}
