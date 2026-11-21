/**
 * @file static_cache.cpp
 * @brief Allocation-free coding, validator and release-token matching for static HTTP assets.
 */
#include "web/static_cache.h"

namespace {
/**
 * @brief Remove HTTP optional whitespace from the ends of a borrowed token.
 * @param[in] value Header or query token.
 * @return Subview without surrounding SP or HTAB.
 */
std::string_view trim(std::string_view value)
{
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t'))
        value.remove_prefix(1);
    while (!value.empty() && (value.back() == ' ' || value.back() == '\t'))
        value.remove_suffix(1);
    return value;
}

/**
 * @brief Compare ASCII coding/parameter names without depending on process locale.
 * @param[in] left First borrowed token.
 * @param[in] right Second borrowed token.
 * @return True when lengths and case-folded ASCII characters match.
 */
bool equal_ascii(std::string_view left, std::string_view right)
{
    if (left.size() != right.size())
        return false;
    for (std::size_t index = 0; index < left.size(); ++index) {
        const auto lower = [](char value) {
            return value >= 'A' && value <= 'Z' ? value + ('a' - 'A') : value;
        };
        if (lower(left[index]) != lower(right[index]))
            return false;
    }
    return true;
}

/**
 * @brief Parse an HTTP qvalue into integer thousandths without float conversion.
 * @param[in] value Trimmed parameter text.
 * @return Quality 0..1000, or zero for malformed/out-of-range precision.
 */
int quality(std::string_view value)
{
    if (value.empty() || (value.front() != '0' && value.front() != '1'))
        return 0;
    const bool one = value.front() == '1';
    if (value.size() == 1)
        return one ? 1000 : 0;
    if (value[1] != '.' || value.size() > 5)
        return 0;
    int fraction = 0;
    int scale = 100;
    for (std::size_t index = 2; index < value.size(); ++index) {
        if (value[index] < '0' || value[index] > '9' || (one && value[index] != '0'))
            return 0;
        fraction += (value[index] - '0') * scale;
        scale /= 10;
    }
    return one ? 1000 : fraction;
}
}  // namespace

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Select an available static representation using Accept-Encoding quality values.
 * @param[in] acceptEncoding Borrowed complete header; empty means identity only.
 * @return Gzip or Identity, or None when both are explicitly unacceptable.
 * @endcond
 */
AssetEncoding asset_encoding(std::string_view acceptEncoding)
{
    int gzip = -1, identity = -1, wildcard = -1;
    while (!acceptEncoding.empty()) {
        const auto separator = acceptEncoding.find(',');
        auto entry = trim(acceptEncoding.substr(0, separator));
        acceptEncoding = separator == std::string_view::npos ? std::string_view{}
                                                             : acceptEncoding.substr(separator + 1);
        const auto semicolon = entry.find(';');
        const auto coding = trim(entry.substr(0, semicolon));
        int preference = 1000;
        entry =
            semicolon == std::string_view::npos ? std::string_view{} : entry.substr(semicolon + 1);
        while (!entry.empty()) {
            const auto next = entry.find(';');
            const auto parameter = trim(entry.substr(0, next));
            const auto equals = parameter.find('=');
            if (equals != std::string_view::npos
                && equal_ascii(trim(parameter.substr(0, equals)), "q"))
                preference = quality(trim(parameter.substr(equals + 1)));
            entry = next == std::string_view::npos ? std::string_view{} : entry.substr(next + 1);
        }
        if (equal_ascii(coding, "gzip"))
            gzip = preference;
        else if (equal_ascii(coding, "identity"))
            identity = preference;
        else if (coding == "*")
            wildcard = preference;
    }
    if (gzip < 0)
        gzip = wildcard > 0 ? wildcard : 0;
    if (identity < 0)
        identity = wildcard == 0 ? 0 : 1000;
    if (gzip > 0 && gzip >= identity)
        return AssetEncoding::Gzip;
    if (identity > 0)
        return AssetEncoding::Identity;
    return AssetEncoding::None;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Compare GET/HEAD cache validators against the selected representation.
 * @param[in] ifNoneMatch Borrowed validator list; quoted commas are not list separators.
 * @param[in] selectedEtag Quoted strong ETag of the chosen identity or gzip bytes.
 * @return True for an exact weak/strong validator or wildcard match.
 * @endcond
 */
bool asset_etag_matches(std::string_view ifNoneMatch, std::string_view selectedEtag)
{
    while (!ifNoneMatch.empty()) {
        bool quoted = false;
        std::size_t separator = 0;
        for (; separator < ifNoneMatch.size(); ++separator) {
            if (ifNoneMatch[separator] == '"')
                quoted = !quoted;
            else if (ifNoneMatch[separator] == ',' && !quoted)
                break;
        }
        auto tag = trim(ifNoneMatch.substr(0, separator));
        ifNoneMatch = separator == ifNoneMatch.size() ? std::string_view{}
                                                      : ifNoneMatch.substr(separator + 1);
        if (tag == "*")
            return true;
        if (tag.substr(0, 2) == "W/")
            tag.remove_prefix(2);
        if (tag == selectedEtag)
            return true;
    }
    return false;
}

/**
 * @cond FCPLCN_SOURCE_CONTRACTS
 * @brief Reject module URLs bound to any release other than the installed asset graph.
 * @param[in] uri Request URI including its optional query string.
 * @param[in] installedVersion Current complete-graph release token.
 * @param[out] versioned True when at least one explicit v parameter is present.
 * @return True for an unversioned URI or when every v parameter matches exactly.
 * @endcond
 */
bool asset_version_matches(std::string_view uri, std::string_view installedVersion, bool& versioned)
{
    versioned = false;
    const auto queryStart = uri.find('?');
    auto query =
        queryStart == std::string_view::npos ? std::string_view{} : uri.substr(queryStart + 1);
    while (!query.empty()) {
        const auto ampersand = query.find('&');
        const auto parameter = query.substr(0, ampersand);
        const auto equals = parameter.find('=');
        if (parameter.substr(0, equals) == "v") {
            versioned = true;
            if (equals == std::string_view::npos
                || parameter.substr(equals + 1) != installedVersion)
                return false;
        }
        query =
            ampersand == std::string_view::npos ? std::string_view{} : query.substr(ampersand + 1);
    }
    return true;
}
