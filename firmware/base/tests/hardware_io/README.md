# FCPLCn hardware I/O native checks

Run `tools/firmware/test-base-hardware-io` on the Mac. It compiles the actual
`main/hardware/hardware_io.cpp` and board registry with fake ESP-IDF I²C/GPIO/task adapters.
The default ASCII build directory is `~/esp/build/fcplcn/base-hardware-io`;
AddressSanitizer and UndefinedBehaviorSanitizer are enabled.

Twenty-two isolated cases exercise the real driver with ASan/UBSan. They cover
safe OFF-before-output initialization; confirmed relay writes and raw inputs;
both bounded I²C scans; concurrent relay/RTC access; full MCP reset; BANK/SEQOP
and profile-register drift; corrupted GPIO/OLAT observations; partial repairs,
lost acknowledgements and silently ignored writes; retry backoff; and per-chip
isolation. The fake follows the Microchip register maps and IOCON aliasing,
including BANK=0 byte-mode A/B alternation and BANK=1 byte-mode repetition.

MCP GPPU registers remain zero: the TLP2363 inputs use external 10 kΩ pull-ups
before their 470 Ω/100 nF filters. Tests check this at initialization and after
reset recovery, and inject an unwanted GPPU setting to verify its removal.

Buffered outputs recover the last confirmed RAM image for all 16 channels.
Failed or expired ON commands never become a future recovery request, while OFF
revokes the old ON even when the device NACKs. Controller-owned outputs clear ON
on invalidation or observations older than 300 ms and require a new controller
decision. Tests also reject unconfirmed intermediate OFF snapshots during the
locked OFF-profile/desired-image repair and retain unknown inputs until full
readback succeeds. A deterministic virtual clock drives the ordinary worker;
the fake FreeRTOS adapter does not start a background task.

Register-map behavior is based on Microchip's [MCP23017 data sheet, table 3-1
and section 3.2.1](https://ww1.microchip.com/downloads/en/DeviceDoc/20001952C.pdf).

F-RAM cases compile the real `hardware/fram.cpp` and shared I²C memory adapter.
They exercise 16-bit big-endian addresses across byte 255, the last byte of the
8192-byte FM24CL64B-GTR, rejection of wrapping/invalid ranges before bus access,
bounded chunks, missing devices, partial read/write failures and serialization
with relay operations. The F-RAM is U9 at address `0x50` on GPIO4/GPIO5; its
A0–A2 and WP pins are grounded. Record checksums and interrupted-write recovery
are verified by the state-journal tests rather than by the byte driver.

This verifies software state and bus transactions. It does not prove PCB wiring,
electrical isolation, relay polarity, sensor readings, or real FreeRTOS timing.
