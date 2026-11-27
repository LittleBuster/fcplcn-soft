/**
 * @file management_mqtt.cpp
 * @brief Private request validation with independent sequence and exact last-reply replay.
 */
#include "network/management_mqtt.h"
#include "config/model.h"
#include "config/settings_json.h"
#include "platform/operation_context.h"
#include <cmath>
#include <memory>

namespace {
using Json = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

/**
 * @brief Read a bounded control-free string from a strict JSON envelope.
 * @param[in] root Borrowed request object.
 * @param[in] name Case-sensitive field name.
 * @param[out] value Copied text on success.
 * @param[in] maximum Maximum accepted byte length.
 * @return True for nonempty bounded control-free text.
 */
bool string_field(const cJSON* root, const char* name, std::string& value, std::size_t maximum)
{
    const auto* item = cJSON_GetObjectItemCaseSensitive(root, name);
    if (!cJSON_IsString(item) || item->valuestring == nullptr)
        return false;
    value = item->valuestring;
    if (value.empty() || value.size() > maximum)
        return false;
    for (const auto ch : value)
        if (static_cast<unsigned char>(ch) < 32 || ch == 127)
            return false;
    return true;
}

/**
 * @brief Check an unambiguous ASCII correlation identifier.
 * @param[in] value Borrowed identifier.
 * @return True for ASCII letters, digits, hyphens and underscores only.
 */
bool request_identifier(const std::string& value)
{
    for (const unsigned char ch : value)
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
              || ch == '-' || ch == '_'))
            return false;
    return !value.empty();
}

/**
 * @brief Read a finite nonnegative integral JSON number.
 * @param[in] root Borrowed object.
 * @param[in] name Case-sensitive field name.
 * @param[out] value Accepted integer as a double.
 * @param[in] maximum Inclusive upper bound.
 * @return True for an integral value in range.
 */
bool number_field(const cJSON* root, const char* name, double& value, double maximum)
{
    const auto* item = cJSON_GetObjectItemCaseSensitive(root, name);
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble) || item->valuedouble < 0
        || item->valuedouble > maximum || std::floor(item->valuedouble) != item->valuedouble)
        return false;
    value = item->valuedouble;
    return true;
}

/**
 * @brief Allocate the ordinary private diagnostic body.
 * @param[in] message Failure description copied into the response.
 * @return Owned object for cJSON_Delete(), or nullptr on allocation failure.
 */
cJSON* diagnostic(const char* message)
{
    auto* value = cJSON_CreateObject();
    if (value)
        cJSON_AddStringToObject(value, "error", message);
    return value;
}

/**
 * @brief Encode a bounded private object or array response.
 * @param[in] request Request correlation metadata.
 * @param[in] boot Current local boot identifier.
 * @param[in] status HTTP-compatible response status.
 * @param[in] data Transferred JSON body ownership.
 * @return Complete JSON envelope, or empty text on size/allocation failure.
 */
std::string reply(const ManagementRequest& request, std::string_view boot, int status, cJSON* data)
{
    Json body(data, cJSON_Delete);
    Json root(cJSON_CreateObject(), cJSON_Delete);
    if (!root || !body || (!cJSON_IsObject(body.get()) && !cJSON_IsArray(body.get())))
        return {};
    if (!cJSON_AddNumberToObject(root.get(), "schemaVersion", 1)
        || !cJSON_AddStringToObject(root.get(), "requestId", request.requestId.c_str())
        || !cJSON_AddStringToObject(root.get(), "bootId", std::string(boot).c_str())
        || !cJSON_AddNumberToObject(root.get(), "sequence", request.sequence)
        || !cJSON_AddNumberToObject(root.get(), "status", status)
        || !cJSON_AddItemToObject(root.get(), "data", body.get()))
        return {};
    body.release();
    char* text = cJSON_PrintUnformatted(root.get());
    if (!text)
        return {};
    std::string result(text);
    cJSON_free(text);
    return result.size() <= kManagementMaxReplyBytes ? result : std::string{};
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Validate a complete request and cache its non-replayed outcome.
 * @param[in] payload Complete bounded JSON envelope.
 * @param[in] retained Preserved RETAIN flag; retained requests never execute.
 * @param[in] bootId Current device boot identifier.
 * @param[in] uptimeMs Monotonic time for envelope validation.
 * @param[in] dispatch Business dispatcher for accepted new sequences.
 * @param[in] generation Optional live connection-generation observation.
 * @param[in] expectedGeneration Connection that accepted the queued request.
 * @return Owned private reply and deferred work only for a newly executed request.
 * @endcond
 */
ManagementOutcome ManagementProtocol::process(std::string_view payload,
                                              bool retained,
                                              std::string_view bootId,
                                              std::int64_t uptimeMs,
                                              const ManagementDispatcher& dispatch,
                                              const std::atomic<std::uint64_t>* generation,
                                              std::uint64_t expectedGeneration)
{
    ManagementRequest request;
    const auto rejected = [&](int status, const char* message) {
        return ManagementOutcome{reply(request, bootId, status, diagnostic(message)), {}};
    };
    if (payload.empty() || payload.size() > kManagementMaxRequestBytes
        || !supported_json_text(payload))
        return rejected(400, "Некорректный размер или JSON запроса");
    const std::string complete(payload);
    Json json(cJSON_ParseWithLengthOpts(complete.c_str(), complete.size() + 1, nullptr, true),
              cJSON_Delete);
    if (!json
        || !settings_json_fields(json.get(),
                                 {"schemaVersion",
                                  "requestId",
                                  "bootId",
                                  "sequence",
                                  "expiresAtUptimeMs",
                                  "method",
                                  "path"},
                                 {"body"}))
        return rejected(400, "Некорректный конверт запроса");
    double version = 0, next = 0, deadline = 0;
    if (!number_field(json.get(), "schemaVersion", version, 1) || version != 1
        || !string_field(json.get(), "requestId", request.requestId, 64)
        || !request_identifier(request.requestId)
        || !string_field(json.get(), "bootId", request.bootId, 96)
        || !number_field(json.get(), "sequence", next, UINT32_MAX) || next < 1
        || !number_field(json.get(), "expiresAtUptimeMs", deadline, 9'007'199'254'740'991.0)
        || !string_field(json.get(), "method", request.method, 4)
        || !string_field(json.get(), "path", request.path, 96))
        return rejected(400, "Некорректные поля запроса");
    request.sequence = static_cast<std::uint32_t>(next);
    request.expiresAtUptimeMs = static_cast<std::int64_t>(deadline);
    request.body = cJSON_GetObjectItemCaseSensitive(json.get(), "body");
    if (retained)
        return rejected(409, "Retained-запросы управления запрещены");
    if (request.bootId != bootId)
        return rejected(409, "PLC перезапущен: обновите состояние");
    if (deadline <= uptimeMs || deadline > uptimeMs + 60'000
        || (generation && generation->load() != expectedGeneration))
        return rejected(409, "Срок запроса истёк или соединение сменилось");
    if ((request.method != "GET" && request.method != "POST") || request.path.front() != '/'
        || request.path.find('?') != std::string::npos
        || request.path.find('#') != std::string::npos
        || (request.body && !cJSON_IsObject(request.body))
        || (request.method == "GET" && request.body))
        return rejected(400, "Неподдерживаемый метод, путь или тело запроса");
    const auto previous = sequence_.load();
    if (request.sequence < previous)
        return rejected(409, "Устаревший номер запроса");
    if (request.sequence == previous) {
        if (complete != last_request_ || last_reply_.empty())
            return rejected(409, "Конфликт номера запроса");
        return {last_reply_, {}};
    }
    OperationContext constraints{request.expiresAtUptimeMs * 1000, generation, expectedGeneration};
    ScopedOperationContext scope(constraints);
    if (!operation_permitted())
        return rejected(409, "Срок запроса истёк или соединение сменилось");
    sequence_.store(request.sequence);
    last_request_ = complete;
    last_reply_.clear();
    auto routed = dispatch(request);
    if (!routed.data)
        routed = {500, diagnostic("Не удалось подготовить ответ"), {}};
    auto encoded = reply(request, bootId, routed.status, routed.data);
    if (encoded.empty()) {
        encoded = reply(request,
                        bootId,
                        503,
                        diagnostic("Ответ превышает лимит 64 КиБ или недостаточно памяти"));
    }
    last_reply_ = encoded;
    return {std::move(encoded), routed.deferred};
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Read the independent management sequence high-water mark.
 * @return Last accepted sequence, initially zero; safe for heartbeat reads.
 * @endcond
 */
std::uint32_t ManagementProtocol::sequence() const
{
    return sequence_.load();
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS @brief Drop all partial bytes and their total-time budget. *
 * @endcond
 */
void ManagementFragments::reset()
{
    payload_.clear();
    total_ = 0;
    started_ms_ = 0;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Report whether a bounded fragment sequence has begun.
 * @return True while a partial message is being assembled.
 * @endcond
 */
bool ManagementFragments::active() const
{
    return total_ != 0;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Assemble contiguous nonretained fragments within five seconds.
 * @param[in] bytes Current SDK fragment bytes.
 * @param[in] offset Absolute offset within the complete message.
 * @param[in] total Advertised complete payload length.
 * @param[in] retained Any retained fragment invalidates the whole message.
 * @param[in] nowMs Current monotonic uptime.
 * @param[out] completed Complete owned message exactly when true is returned.
 * @return True only once for a fully assembled valid message; malformed input clears state.
 * @endcond
 */
bool ManagementFragments::append(std::string_view bytes,
                                 std::size_t offset,
                                 std::size_t total,
                                 bool retained,
                                 std::int64_t nowMs,
                                 std::string& completed)
{
    completed.clear();
    if (offset == 0) {
        reset();
        if (!retained && total > 0 && total <= kManagementMaxRequestBytes) {
            total_ = total;
            started_ms_ = nowMs;
            payload_.reserve(total);
        }
    }
    if (retained || !active() || total != total_ || bytes.empty() || offset != payload_.size()
        || offset > total || bytes.size() > total - offset || nowMs < started_ms_
        || nowMs - started_ms_ > 5000) {
        reset();
        return false;
    }
    payload_.append(bytes.data(), bytes.size());
    if (payload_.size() != total_)
        return false;
    completed = std::move(payload_);
    reset();
    return true;
}
