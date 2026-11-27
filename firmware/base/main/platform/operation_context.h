/**
 * @file operation_context.h
 * @brief Task-local delivery deadline and connection-generation cancellation for remote work.
 * @details Local HTTP and autonomous tasks have no context and preserve their existing behavior.
 */
#pragma once
#include <atomic>
#include <cstdint>
#include "esp_timer.h"

/** @brief Borrowed constraints whose lifetime is bounded by ScopedOperationContext. */
struct OperationContext {
    std::int64_t deadlineUs = 0;  ///< Absolute monotonic acceptance deadline.
    const std::atomic<std::uint64_t>* generation = nullptr;  ///< MQTT lifecycle generation.
    std::uint64_t expectedGeneration = 0;  ///< Connection that accepted this request.
};

/// Current task's borrowed constraints; null preserves local HTTP/autonomous behavior.
inline thread_local const OperationContext* active_operation_context = nullptr;

/** @brief Test remote delivery constraints after a mutation lock has been acquired.
 * @return True for local work or an unexpired request from the same connection generation.
 */
inline bool operation_permitted()
{
    const auto* context = active_operation_context;
    return context == nullptr
           || ((context->deadlineUs == 0 || esp_timer_get_time() < context->deadlineUs)
               && (context->generation == nullptr
                   || context->generation->load() == context->expectedGeneration));
}

/** @brief Install borrowed task-local constraints for one synchronous business operation. */
class ScopedOperationContext {
public:
    /** @brief Save the prior context and activate the supplied constraints.
     * @param[in] context Constraints that outlive this scope.
     */
    explicit ScopedOperationContext(const OperationContext& context)
        : previous_(active_operation_context)
    {
        active_operation_context = &context;
    }

    /** @brief Restore the previous task-local context without affecting another task. */
    ~ScopedOperationContext()
    {
        active_operation_context = previous_;
    }

    ScopedOperationContext(const ScopedOperationContext&) = delete;
    ScopedOperationContext& operator=(const ScopedOperationContext&) = delete;

private:
    const OperationContext* previous_;  ///< Context of an optional enclosing operation.
};
