/** @file crypto.h @brief OpenSSL-backed host adapter for the SDK streaming hash API. */
#pragma once
#include <cstddef>
using psa_status_t = int;
inline constexpr psa_status_t PSA_SUCCESS = 0;
inline constexpr int PSA_ALG_SHA_256 = 1;

struct psa_hash_operation_t {
    void* context;
};

#define PSA_HASH_OPERATION_INIT {nullptr}
psa_status_t psa_crypto_init();
psa_status_t psa_hash_setup(psa_hash_operation_t*, int);
psa_status_t psa_hash_update(psa_hash_operation_t*, const unsigned char*, std::size_t);
psa_status_t psa_hash_finish(psa_hash_operation_t*, unsigned char*, std::size_t, std::size_t*);
psa_status_t psa_hash_abort(psa_hash_operation_t*);
