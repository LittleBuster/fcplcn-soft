include("${CMAKE_CURRENT_LIST_DIR}/controllers/sources.cmake")

idf_component_register(
    SRCS
        "main.cpp"
        "config/model.cpp"
        "config/config.cpp"
        "config/settings_store.cpp"
        "config/state_journal.cpp"
        "config/backup.cpp"
        "security/auth.cpp"
        ${FCPLCN_CONTROLLER_SOURCES}
        "network/network.cpp"
        "network/socket_mqtt.cpp"
        "network/mqtt_telemetry.cpp"
        "network/management_mqtt.cpp"
        "network/management_routes.cpp"
        "sensors/meteo_sensors.cpp"
        "sensors/ibutton.cpp"
        "sensors/sensor_worker.cpp"
        "time/rtc_clock.cpp"
        "time/time_service.cpp"
        "system/system_metrics.cpp"
        "system/firmware_update.cpp"
        "system/recovery_mode.cpp"
        "web/web_server.cpp"
        "web/static_cache.cpp"
    INCLUDE_DIRS "."
    PRIV_REQUIRES hardware platform esp_wifi esp_netif esp_event esp_eth
             esp_system esp_timer esp_psram spi_flash nvs_flash mbedtls esp_http_server app_update
             espressif__cjson espressif__mqtt
)

get_filename_component(FCPLCN_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../.." REALPATH)
target_include_directories(${COMPONENT_LIB} PRIVATE
    "${FCPLCN_GENERATED_INCLUDE_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/generated")

set(FCPLCN_WEB_DIR "${CMAKE_CURRENT_LIST_DIR}/../web")
set(FCPLCN_WEB_MANIFEST "${FCPLCN_WEB_DIR}/assets.json")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${FCPLCN_WEB_MANIFEST}")
file(READ "${FCPLCN_WEB_MANIFEST}" FCPLCN_WEB_MANIFEST_JSON)
string(JSON FCPLCN_WEB_FILE_COUNT LENGTH "${FCPLCN_WEB_MANIFEST_JSON}")
if(FCPLCN_WEB_FILE_COUNT LESS 1)
    message(FATAL_ERROR "FCPLCn web asset manifest must not be empty")
endif()
math(EXPR FCPLCN_WEB_LAST_FILE "${FCPLCN_WEB_FILE_COUNT} - 1")
set(FCPLCN_WEB_INPUTS "${FCPLCN_WEB_MANIFEST}")
foreach(FCPLCN_WEB_INDEX RANGE 0 ${FCPLCN_WEB_LAST_FILE})
    string(JSON FCPLCN_WEB_FILE GET "${FCPLCN_WEB_MANIFEST_JSON}" ${FCPLCN_WEB_INDEX})
    list(APPEND FCPLCN_WEB_INPUTS "${FCPLCN_WEB_DIR}/${FCPLCN_WEB_FILE}")
endforeach()
set(FCPLCN_ASSET_HEADER "${CMAKE_CURRENT_BINARY_DIR}/generated/web_assets.h")
add_custom_command(
    OUTPUT "${FCPLCN_ASSET_HEADER}"
    COMMAND "${PYTHON}" "${CMAKE_CURRENT_LIST_DIR}/../tools/embed_web.py"
            "${FCPLCN_WEB_DIR}" "${FCPLCN_ROOT}/config/product.json" "${FCPLCN_ASSET_HEADER}"
    DEPENDS ${FCPLCN_WEB_INPUTS}
            "${FCPLCN_ROOT}/config/product.json" "${CMAKE_CURRENT_LIST_DIR}/../tools/embed_web.py"
    VERBATIM
)
add_custom_target(fcplcn_web_assets DEPENDS "${FCPLCN_ASSET_HEADER}")
add_dependencies(${COMPONENT_LIB} fcplcn_web_assets)
target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
