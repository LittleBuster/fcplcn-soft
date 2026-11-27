cmake_minimum_required(VERSION 3.22)
project(fcplcn_rtc_tests LANGUAGES C CXX)

get_filename_component(FCPLCN_BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.." REALPATH)
set(FCPLCN_CJSON_DIR "${FCPLCN_BASE_DIR}/managed_components/espressif__cjson/cJSON" CACHE PATH "Managed cJSON source directory")
if(NOT EXISTS "${FCPLCN_CJSON_DIR}/cJSON.c")
    message(FATAL_ERROR "Configure firmware/base first or pass -DFCPLCN_CJSON_DIR=/absolute/path/to/cJSON")
endif()
find_package(Threads REQUIRED)
add_library(fcplcn_rtc_cjson STATIC "${FCPLCN_CJSON_DIR}/cJSON.c")
target_include_directories(fcplcn_rtc_cjson PUBLIC "${FCPLCN_CJSON_DIR}")
add_executable(fcplcn_rtc_tests
    rtc_test.cpp stubs/platform.cpp
    "${FCPLCN_BASE_DIR}/main/time/rtc_clock.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/rtc_codec.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/ds3231.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/board_profile.cpp")
target_compile_features(fcplcn_rtc_tests PRIVATE cxx_std_17)
target_include_directories(fcplcn_rtc_tests PRIVATE stubs "${FCPLCN_BASE_DIR}/main")
target_compile_options(fcplcn_rtc_tests PRIVATE -Wall -Wextra -Werror)
target_link_libraries(fcplcn_rtc_tests PRIVATE fcplcn_rtc_cjson Threads::Threads)
option(FCPLCN_RTC_SANITIZERS "Enable native AddressSanitizer and UndefinedBehaviorSanitizer" ON)
if(FCPLCN_RTC_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    foreach(target fcplcn_rtc_cjson fcplcn_rtc_tests)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    endforeach()
    target_link_options(fcplcn_rtc_tests PRIVATE -fsanitize=address,undefined)
endif()
enable_testing()
foreach(case codec boot_osf read_faults write_confirm write_faults concurrent)
    add_test(NAME "fcplcn_rtc_${case}" COMMAND fcplcn_rtc_tests "${case}")
    set_tests_properties("fcplcn_rtc_${case}" PROPERTIES TIMEOUT 30)
endforeach()
