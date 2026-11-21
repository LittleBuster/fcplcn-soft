cmake_minimum_required(VERSION 3.22)
project(fcplcn_state_memory_tests LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
get_filename_component(FCPLCN_BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.." REALPATH)
set(FCPLCN_CJSON_DIR "${FCPLCN_BASE_DIR}/managed_components/espressif__cjson/cJSON" CACHE PATH "Managed cJSON source directory")
if(NOT EXISTS "${FCPLCN_CJSON_DIR}/cJSON.c")
    message(FATAL_ERROR "Configure firmware/base or set FCPLCN_CJSON_DIR to the managed cJSON directory")
endif()
find_package(Threads REQUIRED)
add_library(fcplcn_memory_cjson STATIC "${FCPLCN_CJSON_DIR}/cJSON.c")
target_include_directories(fcplcn_memory_cjson PUBLIC "${FCPLCN_CJSON_DIR}")
add_executable(fcplcn_state_memory_tests memory_test.cpp
    "${FCPLCN_BASE_DIR}/main/hardware/board_profile.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/fram.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/eeprom.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/state_memory.cpp"
    "${FCPLCN_BASE_DIR}/main/config/state_journal.cpp")
target_include_directories(fcplcn_state_memory_tests PRIVATE ../hardware_io/stubs "${FCPLCN_BASE_DIR}/main")
target_compile_options(fcplcn_state_memory_tests PRIVATE -Wall -Wextra -Werror)
target_link_libraries(fcplcn_state_memory_tests PRIVATE fcplcn_memory_cjson Threads::Threads)
option(FCPLCN_TEST_SANITIZERS "Enable AddressSanitizer and UndefinedBehaviorSanitizer" ON)
if(FCPLCN_TEST_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    foreach(target fcplcn_memory_cjson fcplcn_state_memory_tests)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    endforeach()
    target_link_options(fcplcn_state_memory_tests PRIVATE -fsanitize=address,undefined)
endif()
enable_testing()
foreach(case fram_dispatch eeprom_dispatch eeprom_bounds eeprom_page_wrap eeprom_busy
             eeprom_timeout eeprom_errors eeprom_transport_deadline eeprom_verify eeprom_unchanged eeprom_concurrent
             journal_roundtrip journal_power_cut journal_busy_disconnect journal_integrity journal_commit_ack_loss)
    add_test(NAME "fcplcn_memory_${case}" COMMAND fcplcn_state_memory_tests "${case}")
    set_tests_properties("fcplcn_memory_${case}" PROPERTIES TIMEOUT 20)
endforeach()
