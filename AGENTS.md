# FCPLCn

The product is **FCPLCn**, expanded as **Future City PLC Next**. Preserve this exact spelling and capitalization in user-facing firmware and web interface text.

The canonical identity lives in `config/product.json`. Reuse it for firmware metadata, boot logs, web page titles, headers, About/device information, API identity, and release artifact names. Use `fcplcn` for technical identifiers that require lowercase (for example package names, hostnames, MQTT prefixes, and discovery identifiers). Device-specific suffixes and protocol schemas are defined with their corresponding features.

The firmware platform is ESP-IDF 6.1, C++ and ESP32-S3 N16R8. The main home automation software runs on a Linux mini-PC and is written in TypeScript for Node.js; its browser interface uses TypeScript/Preact. Each PLC also retains a local service web interface. Build and test commands are documented in `tools/firmware/README.md`.

Keep ESP-IDF build directories in an ASCII path: the verified build root is `~/esp/build/fcplcn/`. GCC specs processing in this SDK corrupts Cyrillic build paths. The source workspace may retain its current path.

## Architecture requirements

The current architecture uses a Linux mini-PC with the local MQTT broker and central TypeScript application. All PLC devices connect to this broker over the LAN. Only the Linux mini-PC communicates with the user's own cloud/VPS; PLC devices do not connect directly to the cloud or hold its credentials.

Each PLC must preserve its local configuration and control logic if the mini-PC, broker, LAN, or other devices become unavailable. Thermoregulation and other autonomous equipment control loops always execute in C++ on the responsible PLC. The mini-PC changes setpoints, modes, profiles and high-level scenarios; it does not perform each control step of these loops. Autonomous loops require local sensors and outputs or an explicitly designed local reserve and fault policy. Relevant local profiles, schedules and confirmed settings persist on the PLC.

The current architecture proposal is documented in `docs/architecture/CONCEPT.md`. It supersedes the earlier alternatives involving a PLC coordinator or direct PLC-to-VPS connections. Functions that depend on remote data require explicit freshness checks and failure policies. Do not assume automatic gateway failover or replay old commands after reconnect.
