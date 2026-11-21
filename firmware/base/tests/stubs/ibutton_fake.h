#pragma once
#include "sensors/ibutton.h"

namespace ibutton_fake {
void reset();
void key(std::string_view address);
void candidate(std::string_view address);
void release();
void fail(std::string_view error);
void reading(const IbuttonReading& value);
void scan(const std::vector<std::string>& addresses);
void scan(const IbuttonScanSnapshot& value);
std::string configured();
unsigned scan_calls();
}  // namespace ibutton_fake
