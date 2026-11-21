#include "platform.h"

#include <algorithm>
#include <climits>
#include <cstring>
#include <openssl/evp.h>

#include "esp_http_server.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "nvs.h"
#include "psa/crypto.h"

namespace auth_test {
std::int64_t now_us = 1000000;
std::map<std::string, std::vector<unsigned char>> storage;
bool fail_next_commit = false;
}  // namespace auth_test

namespace {
std::map<std::string, std::vector<unsigned char>> pending;
std::uint64_t random_state = 0xf123456789abcdefULL;
}  // namespace

std::int64_t esp_timer_get_time()
{
    return auth_test::now_us;
}

void esp_fill_random(void* output, std::size_t length)
{
    auto* bytes = static_cast<unsigned char*>(output);
    for (std::size_t i = 0; i < length; ++i) {
        random_state ^= random_state << 13;
        random_state ^= random_state >> 7;
        random_state ^= random_state << 17;
        bytes[i] = static_cast<unsigned char>(random_state >> 24);
    }
}

std::size_t httpd_req_get_hdr_value_len(httpd_req_t* request, const char* name)
{
    const auto found = request->headers.find(name);
    return found == request->headers.end() ? 0 : found->second.size();
}

esp_err_t httpd_req_get_hdr_value_str(httpd_req_t* request,
                                      const char* name,
                                      char* output,
                                      std::size_t length)
{
    const auto found = request->headers.find(name);
    if (found == request->headers.end())
        return ESP_FAIL;
    if (length <= found->second.size())
        return ESP_ERR_INVALID_SIZE;
    std::memcpy(output, found->second.c_str(), found->second.size() + 1);
    return ESP_OK;
}

esp_err_t httpd_resp_set_hdr(httpd_req_t* request, const char* name, const char* value)
{
    if (request->fail_header)
        return ESP_FAIL;
    if (std::string(name) == "Set-Cookie")
        request->response_cookie = value;
    return ESP_OK;
}

esp_err_t nvs_open(const char* name, nvs_open_mode_t, nvs_handle_t* handle)
{
    if (std::string(name) != "fcplcn_auth")
        return ESP_ERR_INVALID_ARG;
    *handle = 1;
    return ESP_OK;
}

esp_err_t nvs_get_blob(nvs_handle_t, const char* key, void* output, std::size_t* length)
{
    const auto found = auth_test::storage.find(key);
    if (found == auth_test::storage.end())
        return ESP_ERR_NVS_NOT_FOUND;
    if (!output) {
        *length = found->second.size();
        return ESP_OK;
    }
    if (*length < found->second.size()) {
        *length = found->second.size();
        return ESP_ERR_NVS_INVALID_LENGTH;
    }
    std::memcpy(output, found->second.data(), found->second.size());
    *length = found->second.size();
    return ESP_OK;
}

esp_err_t nvs_set_blob(nvs_handle_t, const char* key, const void* input, std::size_t length)
{
    const auto* bytes = static_cast<const unsigned char*>(input);
    pending[key] = std::vector<unsigned char>(bytes, bytes + length);
    return ESP_OK;
}

esp_err_t nvs_get_str(nvs_handle_t handle, const char* key, char* output, std::size_t* length)
{
    return nvs_get_blob(handle, key, output, length);
}

esp_err_t nvs_set_str(nvs_handle_t handle, const char* key, const char* value)
{
    return nvs_set_blob(handle, key, value, std::strlen(value) + 1);
}

esp_err_t nvs_commit(nvs_handle_t)
{
    if (auth_test::fail_next_commit) {
        auth_test::fail_next_commit = false;
        pending.clear();
        return ESP_FAIL;
    }
    for (const auto& entry : pending)
        auth_test::storage[entry.first] = entry.second;
    pending.clear();
    return ESP_OK;
}

void nvs_close(nvs_handle_t)
{
}

psa_status_t psa_crypto_init()
{
    return PSA_SUCCESS;
}

psa_status_t psa_key_derivation_setup(psa_key_derivation_operation_t* operation, int algorithm)
{
    if (algorithm != PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256))
        return -1;
    operation->step = 0;
    return PSA_SUCCESS;
}

psa_status_t psa_key_derivation_input_integer(psa_key_derivation_operation_t* operation,
                                              int step,
                                              std::uint64_t count)
{
    if (step != PSA_KEY_DERIVATION_INPUT_COST || operation->step != 0)
        return -1;
    operation->step = 1;
    operation->count = count;
    return PSA_SUCCESS;
}

psa_status_t psa_key_derivation_input_bytes(psa_key_derivation_operation_t* operation,
                                            int step,
                                            const unsigned char* data,
                                            std::size_t length)
{
    if (step == PSA_KEY_DERIVATION_INPUT_SALT && operation->step == 1) {
        operation->salt.assign(data, data + length);
        operation->step = 2;
    } else if (step == PSA_KEY_DERIVATION_INPUT_PASSWORD && operation->step == 2) {
        operation->password.assign(data, data + length);
        operation->step = 3;
    } else {
        return -1;
    }
    return PSA_SUCCESS;
}

psa_status_t psa_key_derivation_output_bytes(psa_key_derivation_operation_t* operation,
                                             unsigned char* output,
                                             std::size_t length)
{
    if (operation->step != 3 || operation->count > INT_MAX || operation->password.size() > INT_MAX
        || operation->salt.size() > INT_MAX || length > INT_MAX) {
        return -1;
    }
    const char* password = operation->password.empty()
                               ? ""
                               : reinterpret_cast<const char*>(operation->password.data());
    return PKCS5_PBKDF2_HMAC(password,
                             static_cast<int>(operation->password.size()),
                             operation->salt.data(),
                             static_cast<int>(operation->salt.size()),
                             static_cast<int>(operation->count),
                             EVP_sha256(),
                             static_cast<int>(length),
                             output)
                   == 1
               ? PSA_SUCCESS
               : -1;
}

psa_status_t psa_key_derivation_abort(psa_key_derivation_operation_t* operation)
{
    std::fill(operation->password.begin(), operation->password.end(), 0);
    operation->password.clear();
    operation->salt.clear();
    return PSA_SUCCESS;
}
