#pragma once

#include <cstddef>
#include <map>
#include <string>
#include "esp_err.h"

struct httpd_req_t {
    std::map<std::string, std::string> headers;
    // Deliberately not copied: ESP-IDF requires the header owner to keep it alive.
    const char* response_cookie = nullptr;
    bool fail_header = false;
};

std::size_t httpd_req_get_hdr_value_len(httpd_req_t*, const char*);
esp_err_t httpd_req_get_hdr_value_str(httpd_req_t*, const char*, char*, std::size_t);
esp_err_t httpd_resp_set_hdr(httpd_req_t*, const char*, const char*);
