idf_component_register(
    SRCS
        "board_gpio.cpp"
        "board_profile.cpp"
        "chip_temperature.cpp"
        "ds3231.cpp"
        "eeprom.cpp"
        "ethernet_w5500.cpp"
        "fram.cpp"
        "hardware_io.cpp"
        "meteo_codec.cpp"
        "rtc_codec.cpp"
        "sensor_ports.cpp"
        "state_memory.cpp"
    INCLUDE_DIRS "."
    REQUIRES esp_eth
    PRIV_REQUIRES platform esp_driver_gpio esp_driver_i2c esp_driver_spi esp_driver_tsens
                  esp_timer espressif__cjson espressif__w5500 espressif__onewire_bus esp-idf-lib__dht
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
target_compile_definitions(${COMPONENT_LIB} PUBLIC FCPLCN_BOOT_BOARD_ID="${FCPLCN_BOOT_BOARD_ID}")
