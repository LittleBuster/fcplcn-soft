# Native RTC tests

Run from the repository root:

```sh
tools/firmware/test-base-rtc
```

The launcher builds with ASan/UBSan by default in `~/esp/build/fcplcn/base-rtc`.
Use `FCPLCN_RTC_BUILD_DIR` to select another build directory, or pass CMake
arguments such as `-DFCPLCN_RTC_SANITIZERS=OFF`.

Tests compile the actual `main/time/rtc_codec.cpp`, `main/time/rtc_clock.cpp`, `main/hardware/board_profile.cpp`
and managed cJSON source. They cover every day of 2000–2099, BCD/calendar/AM/PM
validation, OSF preservation, firmware date limits, freshness, missing hardware,
write/readback ordering, transaction failures and concurrent access. Each CTest
case starts in a separate process to obtain fresh production static state.

Only the register bus, monotonic timer, logging and FreeRTOS task creation are
mocked. Tasks are recorded without starting threads; tests invoke polling
explicitly. Host threads exercise the driver's mutex separately. No system time
is changed and `main/time/time_service.cpp` is not linked. This model cannot validate real
I²C electrical behavior, battery switching, oscillator accuracy or ESP scheduling.
