/**
 * @file settings_json.h
 * @brief Strict JSON-object field validation for complete backup schemas.
 */
#pragma once
#include <cstring>
#include <initializer_list>
#include "cJSON.h"

/**
 * @brief Validate an object's exact allowed keys and required members.
 * @param[in] object Borrowed cJSON object; nullptr/nonobjects are rejected.
 * @param[in] required Required case-sensitive keys, each present exactly once.
 * @param[in] optional Additional permitted keys, each present at most once.
 * @return True for a valid field set. Value types are checked by the section codec.
 * @note Pure, thread-safe and allocation-free. Borrowed JSON must not be mutated concurrently.
 * @details Complete backups reject unknown or duplicate keys rather than silently dropping
 * unsupported future settings. Partial public configuration patches use separate parsers.
 */
inline bool settings_json_fields(const cJSON* object,
                                 std::initializer_list<const char*> required,
                                 std::initializer_list<const char*> optional = {})
{
    if (!cJSON_IsObject(object))
        return false;
    for (const auto* item = object->child; item != nullptr; item = item->next) {
        if (item->string == nullptr)
            return false;
        bool found = false;
        for (auto key : required)
            found = found || std::strcmp(key, item->string) == 0;
        for (auto key : optional)
            found = found || std::strcmp(key, item->string) == 0;
        if (!found)
            return false;
        for (const auto* previous = object->child; previous != item; previous = previous->next)
            if (previous->string != nullptr && std::strcmp(previous->string, item->string) == 0)
                return false;
    }
    for (auto key : required)
        if (cJSON_GetObjectItemCaseSensitive(object, key) == nullptr)
            return false;
    return true;
}
