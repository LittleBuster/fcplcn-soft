cmake_minimum_required(VERSION 3.22)
project(fcplcn_system_metrics_tests LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
get_filename_component(FCPLCN_BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.." REALPATH)
set(FCPLCN_CJSON_DIR "${FCPLCN_BASE_DIR}/managed_components/espressif__cjson/cJSON" CACHE PATH "Managed cJSON source directory")
if(NOT EXISTS "${FCPLCN_CJSON_DIR}/cJSON.c")
    message(FATAL_ERROR "Managed cJSON is unavailable. Configure firmware/base or pass -DFCPLCN_CJSON_DIR=/absolute/path/to/cJSON")
endif()

find_package(Threads REQUIRED)
add_library(fcplcn_metrics_cjson STATIC "${FCPLCN_CJSON_DIR}/cJSON.c")
target_include_directories(fcplcn_metrics_cjson PUBLIC "${FCPLCN_CJSON_DIR}")
add_executable(fcplcn_metrics_tests
    metrics_test.cpp
    stubs/driver.cpp
    "${FCPLCN_BASE_DIR}/main/system/system_metrics.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/chip_temperature.cpp"
)
target_include_directories(fcplcn_metrics_tests PRIVATE stubs "${FCPLCN_BASE_DIR}/main")
target_link_libraries(fcplcn_metrics_tests PRIVATE fcplcn_metrics_cjson Threads::Threads)
target_compile_options(fcplcn_metrics_tests PRIVATE -Wall -Wextra -Werror)

option(FCPLCN_TEST_SANITIZERS "Enable native AddressSanitizer and UndefinedBehaviorSanitizer" ON)
if(FCPLCN_TEST_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    foreach(target fcplcn_metrics_cjson fcplcn_metrics_tests)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    endforeach()
    target_link_options(fcplcn_metrics_tests PRIVATE -fsanitize=address,undefined)
endif()

enable_testing()
# Each case gets fresh production static state without modifying the module.
foreach(case before_init install_failure enable_failure retry read_failure zero idempotent concurrent_reads)
    add_test(NAME "fcplcn_metrics_${case}" COMMAND fcplcn_metrics_tests "${case}")
    set_tests_properties("fcplcn_metrics_${case}" PROPERTIES TIMEOUT 15)
endforeach()
