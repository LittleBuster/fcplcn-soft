#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

// Test adapter, not the target mbedTLS implementation.
using psa_status_t = int;
constexpr psa_status_t PSA_SUCCESS = 0;
constexpr int PSA_ALG_SHA_256 = 1;
#define PSA_ALG_PBKDF2_HMAC(hash) (100 + (hash))
constexpr int PSA_KEY_DERIVATION_INPUT_COST = 1;
constexpr int PSA_KEY_DERIVATION_INPUT_SALT = 2;
constexpr int PSA_KEY_DERIVATION_INPUT_PASSWORD = 3;

struct psa_key_derivation_operation_t {
    unsigned step = 0;
    std::uint64_t count = 0;
    std::vector<unsigned char> salt;
    std::vector<unsigned char> password;
};

#define PSA_KEY_DERIVATION_OPERATION_INIT                                                          \
    {                                                                                              \
    }

psa_status_t psa_crypto_init();
psa_status_t psa_key_derivation_setup(psa_key_derivation_operation_t*, int);
psa_status_t psa_key_derivation_input_integer(psa_key_derivation_operation_t*, int, std::uint64_t);
psa_status_t psa_key_derivation_input_bytes(psa_key_derivation_operation_t*,
                                            int,
                                            const unsigned char*,
                                            std::size_t);
psa_status_t
psa_key_derivation_output_bytes(psa_key_derivation_operation_t*, unsigned char*, std::size_t);
psa_status_t psa_key_derivation_abort(psa_key_derivation_operation_t*);
