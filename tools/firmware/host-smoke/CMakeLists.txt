cmake_minimum_required(VERSION 3.20)
project(fcplcn_host_toolchain_smoke LANGUAGES CXX)

# This executable validates the native build environment, not firmware behavior.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Threads REQUIRED)

add_executable(fcplcn_host_toolchain_smoke main.cpp)
target_link_libraries(fcplcn_host_toolchain_smoke PRIVATE Threads::Threads)
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(fcplcn_host_toolchain_smoke PRIVATE
        -Wall -Wextra -Wpedantic -Werror)
endif()

enable_testing()
add_test(NAME fcplcn_host_toolchain_smoke COMMAND fcplcn_host_toolchain_smoke)
