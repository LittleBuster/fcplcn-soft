/**
 * @file board_profiles_mock.cjs
 * @brief Resolve trusted canonical board identities and their explicit legacy aliases.
 */
'use strict';
const canonicalBoardId = 'fcplcn-161608-1v0';
const legacyBoardId = 'wifi-relay-16-r2-stack';
const framProfile = Object.freeze({
  model: 'FM24CL64B-GTR',
  i2cBus: 'io-expanders',
  address: 0x50,
  capacityBytes: 8192,
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
module.exports = { canonicalBoardId, legacyBoardId, normalizeBoardId, framProfile };
