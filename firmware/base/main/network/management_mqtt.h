/**
 * @file management_mqtt.h
 * @brief Bounded private MQTT request protocol, replay cache and fragment assembly.
 */
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include "cJSON.h"

inline constexpr std::size_t kManagementMaxRequestBytes =
    40 * 1024;  ///< Maximum full request envelope.
inline constexpr std::size_t kManagementMaxReplyBytes =
    64 * 1024;  ///< Maximum complete private reply.

/** @brief Validated borrowed request, alive only during synchronous dispatch. */
struct ManagementRequest {
    std::string requestId;  ///< ASCII correlation identifier assigned by the hub.
    std::string bootId;  ///< Expected current local boot identifier.
    std::string method;  ///< Exact GET or POST operation.
    std::string path;  ///< Relative allowlisted service path without /api/v1.
    std::uint32_t sequence = 0;  ///< Independent monotonic management sequence.
    std::int64_t expiresAtUptimeMs = 0;  ///< Absolute monotonic acceptance deadline.
    const cJSON* body = nullptr;  ///< Borrowed optional JSON object during dispatch.
};

/** @brief Deferred service changes performed after the private reply send attempt. */
struct ManagementDeferred {
    bool networkApply = false;  ///< Schedule saved network settings after the reply attempt.
    bool timeApply = false;  ///< Apply saved timezone/NTP settings after the reply attempt.
    bool reboot = false;  ///< Notify a previously reserved delayed reboot worker.
};

/** @brief Owned business result; the protocol consumes data with cJSON_Delete(). */
struct ManagementRouteResult {
    int status = 200;  ///< HTTP-compatible route outcome.
    cJSON* data = nullptr;  ///< Transferred object/array body, including private backup fields.
    ManagementDeferred deferred;  ///< Newly accepted post-reply service work.
};

/** @brief Encoded private reply and non-replayed deferred work. */
struct ManagementOutcome {
    std::string payload;  ///< Bounded encoded private response; never retained or logged.
    ManagementDeferred deferred;  ///< Empty for cached duplicate replies.
};

/// Synchronous business dispatcher transferring result-body ownership to the protocol.
using ManagementDispatcher = std::function<ManagementRouteResult(const ManagementRequest&)>;

/** @brief Serialize management requests on one worker and retain only its last complete reply. */
class ManagementProtocol {
public:
    /** @brief Validate and dispatch one nonretained request, or return its exact cached reply.
     * @param[in] payload Complete bounded JSON envelope.
     * @param[in] retained Preserved MQTT RETAIN flag; retained requests never execute.
     * @param[in] bootId Current device boot identifier.
     * @param[in] uptimeMs Current monotonic time for envelope validation.
     * @param[in] dispatch Business dispatcher called only for an accepted new sequence.
     * @param[in] generation Optional live connection generation for post-lock cancellation.
     * @param[in] expectedGeneration Generation that accepted the queued payload.
     * @return Owned reply bytes and deferred work for new successful mutations only.
     */
    ManagementOutcome process(std::string_view payload,
                              bool retained,
                              std::string_view bootId,
                              std::int64_t uptimeMs,
                              const ManagementDispatcher& dispatch,
                              const std::atomic<std::uint64_t>* generation = nullptr,
                              std::uint64_t expectedGeneration = 0);
    /** @brief Read the last accepted sequence without taking a business-operation lock.
     * @return Independent management sequence, initially zero.
     */
    std::uint32_t sequence() const;

private:
    std::atomic<std::uint32_t> sequence_{0};
    std::string last_request_;
    std::string last_reply_;
};

/** @brief Assemble one contiguous MQTT payload with a fixed byte and total-time budget. */
class ManagementFragments {
public:
    /** @brief Clear partial input after disconnect, topic change, timeout or malformed offsets. */
    void reset();
    /** @brief Check whether a management message is currently being assembled.
     * @return True while a bounded partial payload is buffered.
     */
    bool active() const;
    /** @brief Append one fragment and transfer complete payload on success.
     * @param[in] bytes Current fragment bytes.
     * @param[in] offset Absolute payload offset from ESP-MQTT.
     * @param[in] total Complete advertised payload size.
     * @param[in] retained RETAIN flag; any retained fragment invalidates the entire request.
     * @param[in] nowMs Current monotonic uptime.
     * @param[out] completed Owned complete payload only when true is returned.
     * @return True exactly once for a complete nonretained message.
     */
    bool append(std::string_view bytes,
                std::size_t offset,
                std::size_t total,
                bool retained,
                std::int64_t nowMs,
                std::string& completed);

private:
    std::string payload_;
    std::size_t total_ = 0;
    std::int64_t started_ms_ = 0;
};
