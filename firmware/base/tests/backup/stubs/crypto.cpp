#include <algorithm>
#include <climits>
#include <cstring>
#include <cstdint>
#include <openssl/evp.h>
#include "esp_http_server.h"
#include "esp_random.h"
#include "psa/crypto.h"

namespace {
std::uint64_t random_state = 0xf123456789abcdefULL;
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
