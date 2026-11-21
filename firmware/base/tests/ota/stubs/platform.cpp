/** @file platform.cpp @brief Host flash adapter; production OTA state machine remains unmodified.
 */
#include "platform.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "psa/crypto.h"
#include <cstring>
#include <openssl/evp.h>
#include <stdexcept>

namespace ota_test {
std::int64_t now_us = 1'000'000, begin_advance_us = 0, end_advance_us = 0;
bool no_partition = false, restore_pending = false, fail_begin = false, fail_write = false,
     fail_end = false, fail_select = false;
unsigned begins = 0, writes = 0, aborts = 0, ends = 0, selections = 0;
std::vector<unsigned char> flash;

/** @brief Reset only the fake SDK, leaving real OTA state reset to its dedicated fixture hook. */
void reset()
{
    now_us = 1'000'000;
    begin_advance_us = end_advance_us = 0;
    no_partition = restore_pending = fail_begin = fail_write = fail_end = fail_select = false;
    begins = writes = aborts = ends = selections = 0;
    flash.clear();
}
}  // namespace ota_test

/** @brief Return the fake monotonic uptime. */
std::int64_t esp_timer_get_time()
{
    return ota_test::now_us;
}

/** @brief Observe fake atomic-restore freeze. */
bool settings_restore_pending()
{
    return ota_test::restore_pending;
}

/** @brief Generate deterministic per-session token bytes. */
void esp_fill_random(void* data, std::size_t size)
{
    static unsigned counter = 0;
    auto* bytes = static_cast<unsigned char*>(data);
    for (std::size_t i = 0; i < size; ++i)
        bytes[i] = static_cast<unsigned char>(++counter);
}

/** @brief Expose the fake currently running build descriptor. */
const esp_app_desc_t* esp_app_get_description()
{
    static const auto descriptor = [] {
        esp_app_desc_t value{};
        std::strcpy(value.version, "0.1.0-base");
        value.app_elf_sha256[0] = 0x11;
        return value;
    }();
    return &descriptor;
}

/** @brief Identify the current slot, which must never receive writes. */
const esp_partition_t* esp_ota_get_running_partition()
{
    static const esp_partition_t partition{0x600000, "ota_0"};
    return &partition;
}

/** @brief Return only the inactive slot, or inject unavailable storage. */
const esp_partition_t* esp_ota_get_next_update_partition(const esp_partition_t*)
{
    static const esp_partition_t partition{0x600000, "ota_1"};
    return ota_test::no_partition ? nullptr : &partition;
}

/** @brief Enforce sequential lazy erase and record its occurrence. */
esp_err_t
esp_ota_begin(const esp_partition_t* partition, std::size_t size, esp_ota_handle_t* handle)
{
    if (!partition || std::strcmp(partition->label, "ota_1") || size != OTA_WITH_SEQUENTIAL_WRITES)
        throw std::runtime_error("OTA attempted wrong partition or bulk erase");
    ++ota_test::begins;
    *handle = 42;
    ota_test::now_us += ota_test::begin_advance_us;
    return ota_test::fail_begin ? ESP_FAIL : ESP_OK;
}

/** @brief Append bytes as the inactive-slot flash driver would. */
esp_err_t esp_ota_write(esp_ota_handle_t handle, const void* data, std::size_t length)
{
    if (handle != 42)
        throw std::runtime_error("invalid OTA handle");
    ++ota_test::writes;
    if (ota_test::fail_write)
        return ESP_FAIL;
    const auto* bytes = static_cast<const unsigned char*>(data);
    ota_test::flash.insert(ota_test::flash.end(), bytes, bytes + length);
    return ESP_OK;
}

/** @brief Count SDK resources released after cancellation or failure. */
esp_err_t esp_ota_abort(esp_ota_handle_t)
{
    ++ota_test::aborts;
    return ESP_OK;
}

/** @brief Model ESP-IDF checksum/signature validation and optional deadline expiry. */
esp_err_t esp_ota_end(esp_ota_handle_t)
{
    ++ota_test::ends;
    ota_test::now_us += ota_test::end_advance_us;
    return ota_test::fail_end ? ESP_FAIL : ESP_OK;
}

/** @brief Record only an explicit boot selection after successful full validation. */
esp_err_t esp_ota_set_boot_partition(const esp_partition_t* partition)
{
    if (!partition || std::strcmp(partition->label, "ota_1"))
        throw std::runtime_error("wrong boot partition");
    ++ota_test::selections;
    return ota_test::fail_select ? ESP_FAIL : ESP_OK;
}

/** @brief Initialize the host crypto adapter. */
psa_status_t psa_crypto_init()
{
    return PSA_SUCCESS;
}

/** @brief Start one real SHA-256 operation using OpenSSL. */
psa_status_t psa_hash_setup(psa_hash_operation_t* operation, int algorithm)
{
    if (operation->context || algorithm != PSA_ALG_SHA_256)
        return -1;
    auto* ctx = EVP_MD_CTX_new();
    operation->context = ctx;
    return ctx && EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) == 1 ? PSA_SUCCESS : -1;
}

/** @brief Feed exactly the bytes written by the production state machine. */
psa_status_t
psa_hash_update(psa_hash_operation_t* operation, const unsigned char* data, std::size_t size)
{
    return operation->context
                   && EVP_DigestUpdate(static_cast<EVP_MD_CTX*>(operation->context), data, size)
                          == 1
               ? PSA_SUCCESS
               : -1;
}

/** @brief Finish a real SHA-256 and release the adapter context like PSA Crypto. */
psa_status_t psa_hash_finish(psa_hash_operation_t* operation,
                             unsigned char* output,
                             std::size_t size,
                             std::size_t* length)
{
    unsigned count = 0;
    const auto ok =
        size >= 32 && operation->context
        && EVP_DigestFinal_ex(static_cast<EVP_MD_CTX*>(operation->context), output, &count) == 1;
    *length = count;
    EVP_MD_CTX_free(static_cast<EVP_MD_CTX*>(operation->context));
    operation->context = nullptr;
    return ok ? PSA_SUCCESS : -1;
}

/** @brief Cancel a possibly idle streaming operation without leaking host resources. */
psa_status_t psa_hash_abort(psa_hash_operation_t* operation)
{
    EVP_MD_CTX_free(static_cast<EVP_MD_CTX*>(operation->context));
    operation->context = nullptr;
    return PSA_SUCCESS;
}
