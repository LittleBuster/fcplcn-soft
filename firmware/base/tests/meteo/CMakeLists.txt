cmake_minimum_required(VERSION 3.22)
project(fcplcn_meteo_tests LANGUAGES C CXX)
get_filename_component(FCPLCN_BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.." REALPATH)
set(FCPLCN_CJSON_DIR "${FCPLCN_BASE_DIR}/managed_components/espressif__cjson/cJSON" CACHE PATH "Managed cJSON source directory")
find_package(Threads REQUIRED)
add_library(fcplcn_meteo_json STATIC "${FCPLCN_CJSON_DIR}/cJSON.c")
target_include_directories(fcplcn_meteo_json PUBLIC "${FCPLCN_CJSON_DIR}")
add_executable(fcplcn_meteo_tests meteo_test.cpp
    "${FCPLCN_BASE_DIR}/main/hardware/meteo_codec.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/sensor_ports.cpp"
    "${FCPLCN_BASE_DIR}/main/sensors/meteo_sensors.cpp"
    "${FCPLCN_BASE_DIR}/main/sensors/ibutton.cpp"
    "${FCPLCN_BASE_DIR}/main/sensors/sensor_worker.cpp"
    "${FCPLCN_BASE_DIR}/main/hardware/board_profile.cpp")
target_compile_features(fcplcn_meteo_tests PRIVATE cxx_std_17)
target_compile_definitions(fcplcn_meteo_tests PRIVATE FCPLCN_METEO_SENSORS_TESTING=1)
target_include_directories(fcplcn_meteo_tests PRIVATE stubs ../rtc/stubs
    "${FCPLCN_BASE_DIR}/main" "${FCPLCN_BASE_DIR}/main/platform")
target_compile_options(fcplcn_meteo_tests PRIVATE -Wall -Wextra -Werror)
target_link_libraries(fcplcn_meteo_tests PRIVATE fcplcn_meteo_json Threads::Threads)
option(FCPLCN_METEO_SANITIZERS "Enable native AddressSanitizer and UndefinedBehaviorSanitizer" ON)
if(FCPLCN_METEO_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    foreach(target fcplcn_meteo_json fcplcn_meteo_tests)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    endforeach()
    target_link_options(fcplcn_meteo_tests PRIVATE -fsanitize=address,undefined)
endif()
enable_testing()
foreach(case codec multiwire dht scan_disabled read_faults conversion_timeout stale reconfigure parasite fair_ports ibutton_codec ibutton_touch ibutton_faults ibutton_scan ibutton_stale ibutton_rebind ibutton_during_conversion ibutton_crc ibutton_multiple ibutton_scan_cancel ibutton_enrollment_release)
    add_test(NAME fcplcn_meteo_${case} COMMAND fcplcn_meteo_tests ${case})
    set_tests_properties(fcplcn_meteo_${case} PROPERTIES TIMEOUT 30)
endforeach()
