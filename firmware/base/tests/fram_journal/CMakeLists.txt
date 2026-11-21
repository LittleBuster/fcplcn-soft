cmake_minimum_required(VERSION 3.22)
project(fcplcn_fram_journal_tests LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
add_executable(fcplcn_fram_journal_tests
    fram_journal_test.cpp
    ../../main/config/state_journal.cpp
)
target_include_directories(fcplcn_fram_journal_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/stubs"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../main"
)
target_compile_options(fcplcn_fram_journal_tests PRIVATE -Wall -Wextra -Werror)
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(fcplcn_fram_journal_tests PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(fcplcn_fram_journal_tests PRIVATE -fsanitize=address,undefined)
endif()
enable_testing()
foreach(case blank roundtrip key_miss corruption power_cuts protected_retries read_failures write_readback bounds generation_exhaustion)
    add_test(NAME fcplcn_fram_journal_${case} COMMAND fcplcn_fram_journal_tests ${case})
    set_tests_properties(fcplcn_fram_journal_${case} PROPERTIES TIMEOUT 15)
endforeach()
