/**
 * @file static_cache.h
 * @brief Portable HTTP negotiation for version-bound embedded service assets.
 */
#pragma once
#include <string_view>

/** @brief Representation accepted by the request's coding preferences. */
enum class AssetEncoding {
    None,  ///< Neither available representation is acceptable; return HTTP 406.
    Identity,  ///< Original UTF-8 bytes without a content coding.
    Gzip  ///< Precompressed deterministic gzip bytes.
};

/**
 * @brief Select an available static representation using Accept-Encoding quality values.
 * @param[in] acceptEncoding Borrowed complete header; empty means identity only.
 * @return Gzip or Identity, or None when both are explicitly unacceptable.
 */
AssetEncoding asset_encoding(std::string_view acceptEncoding);

/**
 * @brief Compare GET/HEAD cache validators against the selected representation.
 * @param[in] ifNoneMatch Borrowed validator list; quoted commas are not list separators.
 * @param[in] selectedEtag Quoted strong ETag of the chosen identity or gzip bytes.
 * @return True for an exact weak/strong validator or wildcard match.
 */
bool asset_etag_matches(std::string_view ifNoneMatch, std::string_view selectedEtag);

/**
 * @brief Reject module URLs bound to any release other than the installed asset graph.
 * @param[in] uri Request URI including its optional query string.
 * @param[in] installedVersion Current complete-graph release token.
 * @param[out] versioned True when at least one explicit v parameter is present.
 * @return True for an unversioned URI or when every v parameter matches exactly.
 */
bool asset_version_matches(std::string_view uri,
                           std::string_view installedVersion,
                           bool& versioned);
