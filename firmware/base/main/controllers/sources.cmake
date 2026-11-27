# Shared production sources: the firmware and native controller/backup tests use one list.
set(FCPLCN_CONTROLLER_SOURCES
    "${CMAKE_CURRENT_LIST_DIR}/socket_controller.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_model.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_storage.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_states.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_switches.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_meteo.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_thermostat.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_tank.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_irrigation.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/irrigation_water.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_status.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/controller_security.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/security_sync.cpp"
)
