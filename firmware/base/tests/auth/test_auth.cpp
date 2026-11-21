#include "security/auth.h"
#include "platform.h"

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <openssl/evp.h>
#include <vector>

namespace {
void require(bool value, const char* description)
{
    if (!value) {
        std::cerr << "FAILED: " << description << '\n';
        std::exit(1);
    }
}

std::string login(const std::string& username, const std::string& password, bool secure = false)
{
    httpd_req_t request;
    AuthCookie cookie;
    require(auth_login(&request, username, password, cookie, secure) == AuthResult::Ok, "login");
    require(request.response_cookie == cookie.value.data(), "caller-owned cookie lifetime");
    const std::string header = request.response_cookie;
    require(header.find("HttpOnly") != std::string::npos
                && header.find("SameSite=Strict") != std::string::npos
                && header.find("Path=/") != std::string::npos,
            "cookie flags");
    require((header.find("; Secure") != std::string::npos) == secure, "conditional Secure");
    return header.substr(0, header.find(';'));
}

bool check(const std::string& cookie)
{
    httpd_req_t request;
    request.headers["Cookie"] = cookie;
    return auth_check_request(&request);
}
}  // namespace

int main(int argc, char** argv)
{
    using namespace auth_test;
    if (argc > 1 && std::string(argv[1]) == "corrupt") {
        storage["account"] = std::vector<unsigned char>(128, 0);
        require(auth_init() != ESP_OK, "corrupt record fails closed");
        require(auth_get_username().empty(), "corrupt init remains unauthenticated");
        require(storage["account"] == std::vector<unsigned char>(128, 0),
                "corrupt record is not reset to defaults");
        std::cout << "FCPLCn auth corrupt-record case passed\n";
        return 0;
    }

    require(auth_init() == ESP_OK, "first initialization");
    require(auth_get_username() == "admin", "English default username");
    require(storage["account"].size() == 128, "single serialized NVS record");
    unsigned char expected[32];
    const auto& record = storage["account"];
    require(PKCS5_PBKDF2_HMAC("", 0, record.data() + 16, 16, 20000, EVP_sha256(), 32, expected)
                == 1,
            "expected PBKDF2");
    require(std::memcmp(expected, record.data() + 32, 32) == 0,
            "empty password stored as salted PBKDF2");

    const auto first = login("admin", "");
    require(check(first), "session accepted");
    require(!check("fcplcn_session=00"), "short cookie rejected");
    require(!check(first + "; " + first), "duplicate cookie rejected");

    httpd_req_t request;
    AuthCookie cookie;
    require(auth_login(&request, std::string("\xc0\xaf", 2), "", cookie)
                == AuthResult::InvalidInput,
            "invalid UTF-8 rejected");
    require(auth_login(&request, std::string(65, 'a'), "", cookie) == AuthResult::InvalidInput,
            "username byte limit");
    require(auth_login(&request, "admin", std::string(129, 'a'), cookie)
                == AuthResult::InvalidInput,
            "password byte limit");

    require(auth_change_user("", "оператор", std::nullopt) == AuthResult::Ok,
            "UTF-8 rename without password update");
    require(auth_get_username() == "оператор", "UTF-8 username round-trips");
    require(!check(first), "rename invalidates old session");
    const auto renamed = login("оператор", "", true);
    require(check(renamed), "renamed user keeps empty password");

    require(auth_change_user("", "оператор", std::string("secret")) == AuthResult::Ok,
            "set new password");
    require(!check(renamed), "password change invalidates session");
    const auto protected_cookie = login("оператор", "secret");
    require(check(protected_cookie), "new password accepted");
    auto saved = storage["account"];
    require(auth_change_user("wrong", "other", std::nullopt) == AuthResult::InvalidCredentials,
            "wrong current password rejected");
    require(storage["account"] == saved && auth_get_username() == "оператор",
            "rejected update preserves account");
    require(check(protected_cookie), "rejected update preserves session");

    require(auth_change_user("secret", "admin", std::string("")) == AuthResult::Ok,
            "explicit password clearing");
    require(auth_change_user("", "admin", std::nullopt) == AuthResult::Ok,
            "reset sessions before limit test");
    std::vector<std::string> sessions;
    for (int i = 0; i < 5; ++i) {
        now_us += 100;
        sessions.push_back(login("admin", ""));
    }
    require(!check(sessions[0]), "four-session cap evicts LRU");
    for (int i = 1; i < 5; ++i)
        require(check(sessions[i]), "remaining sessions valid");

    httpd_req_t logout_request;
    logout_request.headers["Cookie"] = sessions[1];
    AuthCookie clear;
    require(auth_logout(&logout_request, clear, true) == ESP_OK, "logout succeeds");
    require(!check(sessions[1]) && check(sessions[2]), "logout revokes only selected session");
    require(std::string(clear.value.data()).find("Max-Age=0") != std::string::npos,
            "logout cookie cleared");

    const auto expiring = login("admin", "");
    now_us += 8LL * 60 * 60 * 1000000 + 1;
    require(!check(expiring), "eight-hour monotonic expiry");
    const auto before = now_us;
    for (int i = 0; i < 3; ++i) {
        require(auth_login(&request, "admin", "wrong", cookie) == AuthResult::InvalidCredentials,
                "failed attempt");
    }
    require(now_us == before, "no blocking throttling sleep");
    require(auth_login(&request, "admin", "", cookie) == AuthResult::RateLimited,
            "backoff enforced");
    now_us += 1000001;
    require(auth_login(&request, "admin", "", cookie) == AuthResult::Ok, "login after backoff");

    saved = storage["account"];
    fail_next_commit = true;
    require(auth_change_user("", "new", std::string("notcommitted")) == AuthResult::StorageError,
            "write failure reported");
    require(storage["account"] == saved && auth_get_username() == "admin",
            "failed write preserves active account");
    login("admin", "");
    std::cout << "FCPLCn auth lifecycle, validation, PBKDF2, cookies, sessions, expiry, "
                 "backoff and NVS failure cases passed\n";
}
