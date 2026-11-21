cmake_minimum_required(VERSION 3.22)
project(fcplcn_base_auth_tests LANGUAGES C CXX)

find_package(OpenSSL 3.0 REQUIRED COMPONENTS Crypto)
find_package(Threads REQUIRED)
enable_testing()

option(FCPLCN_AUTH_SANITIZERS "Run auth tests with ASan and UBSan" ON)
get_filename_component(FCPLCN_BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.." REALPATH)
set(FCPLCN_CJSON_DIR "${FCPLCN_BASE_DIR}/managed_components/espressif__cjson/cJSON" CACHE PATH "Managed cJSON directory")
add_library(fcplcn_auth_json STATIC "${FCPLCN_CJSON_DIR}/cJSON.c")
target_include_directories(fcplcn_auth_json PUBLIC "${FCPLCN_CJSON_DIR}")

add_executable(fcplcn_base_auth_tests
    ../../main/security/auth.cpp
    platform.cpp
    ../stubs/settings_store.cpp
    test_auth.cpp
)
target_compile_features(fcplcn_base_auth_tests PRIVATE cxx_std_17)
target_include_directories(fcplcn_base_auth_tests PRIVATE stubs ../../main .)
target_link_libraries(fcplcn_base_auth_tests PRIVATE OpenSSL::Crypto Threads::Threads fcplcn_auth_json)
target_compile_options(fcplcn_base_auth_tests PRIVATE -Wall -Wextra -Werror)

if(FCPLCN_AUTH_SANITIZERS)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        message(FATAL_ERROR "ASan/UBSan auth tests require Clang or GCC")
    endif()
    target_compile_options(fcplcn_base_auth_tests PRIVATE
        -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(fcplcn_base_auth_tests PRIVATE -fsanitize=address,undefined)
endif()

add_test(NAME fcplcn_auth_lifecycle COMMAND fcplcn_base_auth_tests)
add_test(NAME fcplcn_auth_corrupt_record COMMAND fcplcn_base_auth_tests corrupt)
set_tests_properties(fcplcn_auth_lifecycle fcplcn_auth_corrupt_record PROPERTIES TIMEOUT 30)
