idf_component_register(
    SRCS "runtime_supervisor.cpp"
    INCLUDE_DIRS "."
    REQUIRES esp_timer
    PRIV_REQUIRES esp_system espressif__cjson
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
target_include_directories(${COMPONENT_LIB} PRIVATE "${FCPLCN_GENERATED_INCLUDE_DIR}")
