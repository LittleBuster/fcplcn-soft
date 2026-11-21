idf_component_register(
    SRCS "smoke_main.cpp"
    INCLUDE_DIRS "."
    REQUIRES esp_system spi_flash esp_psram esp_eth esp_http_server esp_driver_uart
)

get_filename_component(FCPLCN_IDENTITY_FILE
    "${CMAKE_CURRENT_LIST_DIR}/../../../../config/product.json" REALPATH)
file(READ "${FCPLCN_IDENTITY_FILE}" FCPLCN_IDENTITY_JSON)
string(JSON FCPLCN_PRODUCT_NAME GET "${FCPLCN_IDENTITY_JSON}" name)
string(JSON FCPLCN_PRODUCT_FULL_NAME GET "${FCPLCN_IDENTITY_JSON}" fullName)
string(JSON FCPLCN_PRODUCT_ID GET "${FCPLCN_IDENTITY_JSON}" id)
configure_file(product_identity.h.in generated/product_identity.h @ONLY)
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
