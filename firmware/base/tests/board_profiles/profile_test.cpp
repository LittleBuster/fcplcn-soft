/**
 * @file profile_test.cpp
 * @brief Verify compile-time first boot without changing fixed identities or persisted activation.
 */
#include "config/model.h"
#include "hardware/board_profile.h"
#include "cJSON.h"

#include <cstdlib>
#include <iostream>
#include <string_view>

#define CHECK(expression)                                                                          \
    do {                                                                                           \
        if (!(expression)) {                                                                       \
            std::cerr << "Check failed at line " << __LINE__ << ": " #expression "\n";             \
            std::exit(1);                                                                          \
        }                                                                                          \
    } while (false)

int main()
{
    const bool eeprom_boot = std::string_view(kDefaultBoardProfileId) == kFcplc080806BoardProfileId;
    const auto* current = board_profile_find(kCurrentBoardProfileId);
    const auto* eeprom = board_profile_find(kFcplc080806BoardProfileId);
    CHECK(current != nullptr && eeprom != nullptr && current != eeprom);
    CHECK(std::string_view(current->id) == "fcplcn-161608-1v0");
    CHECK(current->stateMemory->kind == BoardMemoryKind::Fram);
    CHECK(eeprom->stateMemory->kind == BoardMemoryKind::Eeprom24lc512);
    CHECK(board_profile_find(kLegacyBoardProfileId) == current);
    CHECK(board_profile_canonical_id(kLegacyBoardProfileId) == kCurrentBoardProfileId);
    CHECK(board_profile_find("unknown-profile") == nullptr);

    const HardwareConfig blank_settings{};
    CHECK(blank_settings.boardId == kDefaultBoardProfileId);
    CHECK(&board_profile_active() == (eeprom_boot ? eeprom : current));
    CHECK(board_profile_active().stateMemory->capacityBytes == (eeprom_boot ? 65536 : 8192));
    auto* profiles = board_profiles_json();
    CHECK(profiles != nullptr && cJSON_GetArraySize(profiles) == 2);
    auto* current_json = cJSON_GetArrayItem(profiles, 0);
    auto* eeprom_json = cJSON_GetArrayItem(profiles, 1);
    CHECK(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(current_json, "legacyIds")) == 1);
    CHECK(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(eeprom_json, "legacyIds")) == 0);
    CHECK(cJSON_HasObjectItem(current_json, "fram"));
    CHECK(!cJSON_HasObjectItem(eeprom_json, "fram"));
    cJSON_Delete(profiles);

    // A saved registered profile takes precedence over the compiled first-boot choice.
    const auto* saved = eeprom_boot ? current : eeprom;
    CHECK(board_profile_activate(saved->id));
    CHECK(&board_profile_active() == saved);
    CHECK(board_profile_activate(saved->id));
    CHECK(!board_profile_activate(eeprom_boot ? eeprom->id : current->id));
    std::cout << "First-boot profile " << kDefaultBoardProfileId
              << ": fixed registry, old alias and persisted activation verified\n";
}
