cmake_minimum_required(VERSION 3.22)
project(fcplcn_base_config_tests LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

get_filename_component(FCPLCN_BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/.." REALPATH)
get_filename_component(FCPLCN_REPO_DIR "${FCPLCN_BASE_DIR}/../.." REALPATH)
set(FCPLCN_CJSON_DIR "" CACHE PATH "Directory containing the actual managed cJSON.c and cJSON.h")
if(NOT FCPLCN_CJSON_DIR)
    foreach(candidate
            "${FCPLCN_BASE_DIR}/managed_components/espressif__cjson/cJSON"
            "${FCPLCN_BASE_DIR}/managed_components/espressif__cjson"
            "${FCPLCN_REPO_DIR}/tools/firmware/esp32s3-smoke/managed_components/espressif__cjson/cJSON"
            "${FCPLCN_REPO_DIR}/tools/firmware/esp32s3-smoke/managed_components/espressif__cjson")
        if(EXISTS "${candidate}/cJSON.c" AND EXISTS "${candidate}/cJSON.h")
            set(FCPLCN_CJSON_DIR "${candidate}")
            break()
        endif()
    endforeach()
endif()
if(NOT EXISTS "${FCPLCN_CJSON_DIR}/cJSON.c" OR NOT EXISTS "${FCPLCN_CJSON_DIR}/cJSON.h")
    message(FATAL_ERROR "Managed cJSON source is unavailable. Configure/build firmware/base once or set -DFCPLCN_CJSON_DIR=/absolute/path/to/component")
endif()

find_package(Threads REQUIRED)
add_library(fcplcn_cjson STATIC "${FCPLCN_CJSON_DIR}/cJSON.c")
target_include_directories(fcplcn_cjson PUBLIC "${FCPLCN_CJSON_DIR}")

add_executable(fcplcn_config_tests
    config_test.cpp
    stubs/platform.cpp
    stubs/settings_store.cpp
    "${FCPLCN_BASE_DIR}/main/config/model.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/board_profile.cpp"
    "${FCPLCN_BASE_DIR}/main/config/config.cpp"
)
target_include_directories(fcplcn_config_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/config/stubs"
    "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
    "${FCPLCN_BASE_DIR}/main"
)
target_link_libraries(fcplcn_config_tests PRIVATE fcplcn_cjson Threads::Threads)
target_compile_options(fcplcn_config_tests PRIVATE -Wall -Wextra -Werror)

enable_testing()
add_test(NAME fcplcn_base_config COMMAND fcplcn_config_tests)
set_tests_properties(fcplcn_base_config PROPERTIES TIMEOUT 15)
