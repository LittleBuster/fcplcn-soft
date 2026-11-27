/** @file ota_test.cpp @brief Real OTA state-machine tests with fault-injected inactive flash. */
#include "system/firmware_update.h"
#include "platform/operation_context.h"
#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "platform.h"
#include <algorithm>
#include <array>
#include <cstring>
#include <functional>
#include <iostream>
#include <memory>
#include <openssl/evp.h>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;
#define REQUIRE(condition)                                                                         \
    do {                                                                                           \
        if (!(condition))                                                                          \
            throw std::runtime_error(std::string(__func__) + ":" + std::to_string(__LINE__)        \
                                     + ": " #condition);                                           \
    } while (false)
bool reboot_allowed = true;
unsigned reservations = 0;

/** @brief Count nonactuating reboot-worker reservations. */
bool reserve_reboot()
{
    ++reservations;
    return reboot_allowed;
}

/** @brief Return one borrowed JSON member. */
const cJSON* field(const cJSON* value, const char* key)
{
    return cJSON_GetObjectItemCaseSensitive(value, key);
}

/** @brief Read a required response string. */
std::string string(const cJSON* value, const char* key)
{
    const auto* item = field(value, key);
    REQUIRE(cJSON_IsString(item));
    return item->valuestring;
}

/** @brief Reset the production session and fake platform between independent cases. */
void reset()
{
    firmware_update_test_reset();
    ota_test::reset();
    reboot_allowed = true;
    reservations = 0;
}

/** @brief Make a fake target app whose descriptor follows the actual ESP-IDF prefix ABI. */
std::vector<unsigned char> image(std::size_t size = 16000)
{
    std::vector<unsigned char> bytes(size, 0x5a);
    esp_image_header_t header{};
    header.magic = ESP_IMAGE_HEADER_MAGIC;
    header.segment_count = 1;
    header.chip_id = ESP_CHIP_ID_ESP32S3;
    esp_image_segment_header_t segment{0x3c000000, static_cast<std::uint32_t>(size - 32)};
    esp_app_desc_t descriptor{};
    descriptor.magic_word = ESP_APP_DESC_MAGIC_WORD;
    std::strcpy(descriptor.project_name, "FCPLCn");
    std::strcpy(descriptor.version, "0.1.0-base");
    descriptor.app_elf_sha256[0] = 0x22;
    std::memcpy(bytes.data(), &header, sizeof(header));
    std::memcpy(bytes.data() + sizeof(header), &segment, sizeof(segment));
    std::memcpy(bytes.data() + sizeof(header) + sizeof(segment), &descriptor, sizeof(descriptor));
    return bytes;
}

/** @brief Compute the user's declared whole-file hash independently from production streaming. */
std::string sha(const std::vector<unsigned char>& bytes)
{
    std::array<unsigned char, 32> digest{};
    unsigned size = 0;
    REQUIRE(EVP_Digest(bytes.data(), bytes.size(), digest.data(), &size, EVP_sha256(), nullptr)
            == 1);
    static constexpr char digits[] = "0123456789abcdef";
    std::string result;
    for (const auto value : digest) {
        result.push_back(digits[value >> 4]);
        result.push_back(digits[value & 15]);
    }
    return result;
}

/** @brief Encode one request chunk using a separate standard Base64 implementation. */
std::string base64(const unsigned char* data, std::size_t size)
{
    std::string result((size + 2) / 3 * 4 + 1, '\0');
    result.resize(EVP_EncodeBlock(
        reinterpret_cast<unsigned char*>(result.data()), data, static_cast<int>(size)));
    return result;
}

/** @brief Own the result data while checking an exact expected service status. */
Json call(const char* method,
          const char* path,
          const cJSON* body = nullptr,
          int expected = 200,
          bool* reboot = nullptr)
{
    auto result = firmware_update_request(method, path, body, reserve_reboot);
    Json data(result.data, cJSON_Delete);
    if (result.status != expected) {
        const auto* error = field(data.get(), "error");
        throw std::runtime_error(
            std::string(path) + " status=" + std::to_string(result.status)
            + (cJSON_IsString(error) ? std::string(" ") + error->valuestring : ""));
    }
    if (reboot)
        *reboot = result.reboot;
    return data;
}

/** @brief Declare one upload without writing any flash. */
std::string
begin_upload(const std::vector<unsigned char>& bytes, int expected = 200, std::string digest = "")
{
    Json body(cJSON_CreateObject(), cJSON_Delete);
    cJSON_AddNumberToObject(body.get(), "size", bytes.size());
    cJSON_AddStringToObject(body.get(), "sha256", (digest.empty() ? sha(bytes) : digest).c_str());
    auto result = call("POST", "/firmware/begin", body.get(), expected);
    return expected == 200 ? string(result.get(), "uploadId") : "";
}

/** @brief Send a selected byte range with an explicitly controlled offset. */
Json chunk(const std::string& id,
           const std::vector<unsigned char>& bytes,
           std::size_t offset,
           std::size_t size,
           int expected = 200)
{
    Json body(cJSON_CreateObject(), cJSON_Delete);
    cJSON_AddStringToObject(body.get(), "uploadId", id.c_str());
    cJSON_AddNumberToObject(body.get(), "offset", offset);
    cJSON_AddStringToObject(body.get(), "data", base64(bytes.data() + offset, size).c_str());
    return call("POST", "/firmware/chunk", body.get(), expected);
}

/** @brief Make a session-only body for finish/abort. */
Json session(const std::string& id)
{
    Json body(cJSON_CreateObject(), cJSON_Delete);
    cJSON_AddStringToObject(body.get(), "uploadId", id.c_str());
    return body;
}

/** @brief Upload all bytes in bounded, strictly sequential production-sized chunks. */
void upload(const std::string& id, const std::vector<unsigned char>& bytes)
{
    for (std::size_t offset = 0; offset < bytes.size();) {
        const auto size = std::min(kFirmwareChunkBytes, bytes.size() - offset);
        auto result = chunk(id, bytes, offset, size);
        REQUIRE(field(result.get(), "received")->valuedouble == offset + size);
        offset += size;
    }
}

/** @brief Exercise verified same-version update, build fingerprint, slots and commit ordering. */
void happy()
{
    auto bytes = image();
    const auto before = call("GET", "/firmware");
    REQUIRE(string(before.get(), "runningPartition") == "ota_0");
    REQUIRE(string(before.get(), "imageId").substr(0, 2) == "11");
    const auto id = begin_upload(bytes);
    REQUIRE(ota_test::begins == 0 && firmware_update_busy());
    upload(id, bytes);
    REQUIRE(ota_test::flash == bytes && ota_test::selections == 0);
    auto body = session(id);
    bool reboot = false;
    auto result = call("POST", "/firmware/finish", body.get(), 200, &reboot);
    REQUIRE(reboot && reservations == 1 && ota_test::ends == 1 && ota_test::selections == 1);
    REQUIRE(string(result.get(), "imageId").substr(0, 2) == "22");
    REQUIRE(string(result.get(), "targetPartition") == "ota_1");
    auto status = call("GET", "/firmware");
    REQUIRE(string(status.get(), "state") == "ready"
            && cJSON_IsTrue(field(status.get(), "pendingReboot")));
    call("POST", "/firmware/abort", body.get(), 409);
    call("POST", "/firmware/finish", body.get(), 409);
    begin_upload(bytes, 409);
    REQUIRE(ota_test::selections == 1);
}

/** @brief Reject invalid declarations, unavailable storage, duplicate begins and restore freeze. */
void declarations()
{
    auto bytes = image();
    begin_upload(bytes, 400, "123");
    begin_upload(std::vector<unsigned char>(287, 0), 400);
    Json oversized(cJSON_CreateObject(), cJSON_Delete);
    cJSON_AddNumberToObject(oversized.get(), "size", 0x600001);
    cJSON_AddStringToObject(oversized.get(), "sha256", sha(bytes).c_str());
    call("POST", "/firmware/begin", oversized.get(), 400);
    ota_test::no_partition = true;
    begin_upload(bytes, 503);
    ota_test::no_partition = false;
    ota_test::restore_pending = true;
    begin_upload(bytes, 409);
    ota_test::restore_pending = false;
    begin_upload(bytes);
    begin_upload(bytes, 409);
    REQUIRE(ota_test::begins == 0);
}

/** @brief Reject corrupt prefix, full image, wrong chip/project and tooling images before erase. */
void identity()
{
    for (unsigned variant = 0; variant < 5; ++variant) {
        reset();
        auto bytes = image();
        if (variant == 0)
            bytes[0] = 0;
        if (variant == 1)
            bytes[12] = 0;
        if (variant == 2)
            bytes[32] = 0;
        if (variant == 3)
            bytes[80] = 'X';
        if (variant == 4)
            std::strcpy(reinterpret_cast<char*>(bytes.data() + 48), "0.1.0-tooling-check");
        const auto id = begin_upload(bytes);
        chunk(id, bytes, 0, kFirmwareChunkBytes, 400);
        REQUIRE(ota_test::begins == 0 && ota_test::writes == 0 && ota_test::selections == 0);
    }
}

/** @brief Reject malformed/noncanonical/oversized Base64 and foreign session IDs. */
void chunks()
{
    auto bytes = image();
    const auto id = begin_upload(bytes);
    for (const auto* invalid : {"AB==", "AA=A", "@@@@", "AAAA\n", ""}) {
        auto body = session(id);
        cJSON_AddNumberToObject(body.get(), "offset", 0);
        cJSON_AddStringToObject(body.get(), "data", invalid);
        call("POST", "/firmware/chunk", body.get(), 400);
    }
    chunk("foreign", bytes, 0, 1000, 409);
    chunk(id, bytes, 0, kFirmwareChunkBytes + 1, 400);
    REQUIRE(ota_test::begins == 0);
}

/** @brief Refuse skipped/duplicate chunks rather than writing an ambiguous offset twice. */
void ordering()
{
    auto bytes = image();
    const auto id = begin_upload(bytes);
    chunk(id, bytes, 1, 1000, 409);
    chunk(id, bytes, 0, 1000);
    chunk(id, bytes, 0, 1000, 409);
    REQUIRE(ota_test::flash.size() == 1000 && ota_test::writes == 1);
}

/** @brief A wrong full-file digest never reaches SDK end or changes the boot selector. */
void hash_mismatch()
{
    auto bytes = image();
    const auto id = begin_upload(bytes, 200, std::string(64, '0'));
    upload(id, bytes);
    call("POST", "/firmware/finish", session(id).get(), 400);
    REQUIRE(ota_test::ends == 0 && ota_test::selections == 0 && ota_test::aborts == 1);
    REQUIRE(!firmware_update_busy());
}

/** @brief Flash begin/write/SDK validation/selector faults all leave success unconfirmed. */
void flash_faults()
{
    for (unsigned variant = 0; variant < 4; ++variant) {
        reset();
        auto bytes = image();
        const auto id = begin_upload(bytes);
        ota_test::fail_begin = variant == 0;
        ota_test::fail_write = variant == 1;
        ota_test::fail_end = variant == 2;
        ota_test::fail_select = variant == 3;
        if (variant < 2)
            chunk(id, bytes, 0, kFirmwareChunkBytes, 503);
        else {
            upload(id, bytes);
            call("POST", "/firmware/finish", session(id).get(), variant == 2 ? 400 : 503);
        }
        REQUIRE(!firmware_update_busy());
        REQUIRE(ota_test::selections == (variant == 3 ? 1u : 0u));
    }
}

/** @brief The independent polling path releases abandoned handles and allows a new upload. */
void expiry()
{
    auto bytes = image();
    const auto id = begin_upload(bytes);
    chunk(id, bytes, 0, 1000);
    ota_test::now_us += 60'000'001;
    firmware_update_poll();
    REQUIRE(!firmware_update_busy() && ota_test::aborts == 1);
    chunk(id, bytes, 1000, 1000, 409);
    auto status = call("GET", "/firmware");
    REQUIRE(string(status.get(), "state") == "error");
    const auto next = begin_upload(bytes);
    REQUIRE(next != id);
}

/** @brief Remote request expiry prevents both chunk writes and the final boot selection. */
void deadline()
{
    auto bytes = image();
    const auto id = begin_upload(bytes);
    OperationContext context{ota_test::now_us - 1, nullptr, 0};
    {
        ScopedOperationContext scope(context);
        chunk(id, bytes, 0, 1000, 409);
    }
    REQUIRE(ota_test::begins == 0);
    upload(id, bytes);
    context.deadlineUs = ota_test::now_us + 1000;
    ota_test::end_advance_us = 1001;
    {
        ScopedOperationContext scope(context);
        call("POST", "/firmware/finish", session(id).get(), 409);
    }
    REQUIRE(ota_test::ends == 1 && ota_test::selections == 0);
    reset();
    const auto interrupted = begin_upload(bytes);
    context.deadlineUs = ota_test::now_us + 1000;
    ota_test::begin_advance_us = 1001;
    {
        ScopedOperationContext scope(context);
        chunk(interrupted, bytes, 0, 1000, 409);
    }
    REQUIRE(ota_test::begins == 1 && ota_test::aborts == 1 && ota_test::writes == 0);
    REQUIRE(!firmware_update_busy());
    begin_upload(bytes);
}

/** @brief Reboot-worker allocation and reboot/restore reservations fail safely and can recover. */
void reboot_gate()
{
    auto bytes = image();
    REQUIRE(firmware_update_prepare_restart());
    begin_upload(bytes, 409);
    firmware_update_cancel_restart();
    const auto id = begin_upload(bytes);
    REQUIRE(!firmware_update_prepare_restart());
    upload(id, bytes);
    reboot_allowed = false;
    call("POST", "/firmware/finish", session(id).get(), 503);
    REQUIRE(ota_test::ends == 0 && ota_test::selections == 0 && firmware_update_busy());
    reboot_allowed = true;
    call("POST", "/firmware/finish", session(id).get());
}

/** @brief An incomplete or explicitly aborted upload never selects an image. */
void incomplete()
{
    auto bytes = image();
    const auto id = begin_upload(bytes);
    chunk(id, bytes, 0, 1000);
    call("POST", "/firmware/finish", session(id).get(), 409);
    call("POST", "/firmware/abort", session(id).get());
    REQUIRE(ota_test::aborts == 1 && ota_test::selections == 0 && !firmware_update_busy());
    chunk(id, bytes, 1000, 1000, 409);
}
}  // namespace

/** @brief Run one isolated named production-service regression under ASan/UBSan. */
int main(int argc, char** argv)
{
    try {
        REQUIRE(argc == 2);
        reset();
        const std::vector<std::pair<std::string, std::function<void()>>> cases{
            {"happy", happy},
            {"begin", declarations},
            {"identity", identity},
            {"chunks", chunks},
            {"ordering", ordering},
            {"hash", hash_mismatch},
            {"flash", flash_faults},
            {"expiry", expiry},
            {"deadline", deadline},
            {"reboot", reboot_gate},
            {"incomplete", incomplete}};
        const auto found = std::find_if(cases.begin(), cases.end(), [&](const auto& item) {
            return item.first == argv[1];
        });
        REQUIRE(found != cases.end());
        found->second();
        firmware_update_test_reset();
        std::cout << "OTA " << argv[1] << " passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        firmware_update_test_reset();
        return 1;
    }
}
