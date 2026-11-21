/** @file static_cache_test.cpp @brief Check production static negotiation without ESP hardware. */
#include "web/static_cache.h"
#include <cassert>

/** @brief Exercise coding exclusions, weak validators and release-bound module cache keys. */
int main()
{
    assert(asset_encoding("") == AssetEncoding::Identity);
    assert(asset_encoding("gzip, deflate, br") == AssetEncoding::Gzip);
    assert(asset_encoding("GZIP; Q=1, identity;q=0") == AssetEncoding::Gzip);
    assert(asset_encoding("gzip;q=0, *;q=1") == AssetEncoding::Identity);
    assert(asset_encoding("gzip;q=0.1, identity;q=0.8") == AssetEncoding::Identity);
    assert(asset_encoding("gzip;q=0.8, identity;q=0.1") == AssetEncoding::Gzip);
    assert(asset_encoding("gzip;q=0, identity;q=0") == AssetEncoding::None);
    assert(asset_encoding("*;q=0") == AssetEncoding::None);
    assert(asset_encoding("gzip;q=1.001, identity;q=0") == AssetEncoding::None);
    assert(asset_encoding("gzip;q=0.1234, identity;q=0") == AssetEncoding::None);
    assert(asset_encoding("gzip;q=oops, identity;q=0") == AssetEncoding::None);
    assert(asset_encoding("br, identity") == AssetEncoding::Identity);
    assert(asset_etag_matches("W/\"current\"", "\"current\""));
    assert(asset_etag_matches("\"other\", W/\"current\"", "\"current\""));
    assert(asset_etag_matches("*", "\"current\""));
    assert(!asset_etag_matches("\"a,*,b\"", "\"current\""));
    assert(!asset_etag_matches("\"identity\"", "\"gzip\""));
    bool versioned = true;
    assert(asset_version_matches("/modules/core.js", "release", versioned) && !versioned);
    assert(asset_version_matches("/modules/core.js?v=release", "release", versioned) && versioned);
    assert(asset_version_matches("/app.js?other=x&v=release", "release", versioned) && versioned);
    assert(!asset_version_matches("/app.js?v=old", "release", versioned));
    assert(!asset_version_matches("/app.js?v=", "release", versioned));
    assert(!asset_version_matches("/app.js?v=release&v=old", "release", versioned));
}
