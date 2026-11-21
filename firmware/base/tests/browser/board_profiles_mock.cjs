/**
 * @file board_profiles_mock.cjs
 * @brief Resolve trusted canonical board identities and their explicit legacy aliases.
 */
'use strict';
const canonicalBoardId = 'fcplcn-161608-1v0';
const legacyBoardId = 'wifi-relay-16-r2-stack';
const eepromBoardId = 'fcplc-080806-3v1';
const framProfile = Object.freeze({
  model: 'FM24CL64B-GTR',
  i2cBus: 'io-expanders',
  address: 0x50,
  capacityBytes: 8192,
});

const eepromProfile = Object.freeze({
  type: 'eeprom',
  model: '24LC512-I/SM',
  i2cBus: 'io-expanders',
  address: 0x50,
  capacityBytes: 65536,
  pageSizeBytes: 128,
  writeCycleTimeoutMs: 10,
});
const eepromBoardProfile = Object.freeze({
  boardId: eepromBoardId,
  boardName: 'FCPLC-080806-3v1',
  legacyIds: [],
  mcu: 'esp32s3',
  flashBytes: 16 * 1024 * 1024,
  psramBytes: 8 * 1024 * 1024,
  stateMemory: eepromProfile,
  capabilities: {
    ethernet: false,
    relays: 8,
    inputs: 8,
    i2cBuses: 2,
    sensorPorts: 8,
    rs485: false,
    stateMemory: true,
    fram: false,
    eeprom: true,
  },
  driversImplemented: {
    ethernet: false,
    relays: true,
    inputs: true,
    leds: true,
    sensorPorts: true,
    rs485: false,
    stateMemory: true,
    fram: false,
    eeprom: true,
  },
});

// Alias resolution is exact and comes only from the selected mock registry.
// Unknown IDs must never be treated as the current board by prefix/name.
function normalizeBoardId(id, profiles) {
  if (typeof id !== 'string') return null;
  const profile =
    profiles.find((profile) => profile.boardId === id) ||
    profiles.find((profile) => Array.isArray(profile.legacyIds) && profile.legacyIds.includes(id));
  return profile?.boardId || null;
}
module.exports = {
  canonicalBoardId,
  legacyBoardId,
  eepromBoardId,
  normalizeBoardId,
  framProfile,
  eepromProfile,
  eepromBoardProfile,
};
