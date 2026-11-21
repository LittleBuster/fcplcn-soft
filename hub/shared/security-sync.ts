/** @file Ephemeral LAN security authority and authorized iButton source events; never retained. */
export const SECURITY_LEASE_MS = 4000;
export interface SecurityLeaseInput {
  hubEpoch: string;
  modeRevision: number;
  touchArmed: boolean;
  busy: boolean;
}
export interface SecurityCommandFence {
  hubEpoch: string;
  modeRevision: number;
  leaseSequence: number;
}
export interface SecurityLeasePacket extends SecurityLeaseInput {
  schemaVersion: 1;
  bootId: string;
  leaseSequence: number;
  expiresAtUptimeMs: number;
}
export interface SecurityTouchPacket extends SecurityCommandFence {
  schemaVersion: 1;
  bootId: string;
  eventSequence: number;
  eventAtUptimeMs: number;
  value: boolean;
  keyId: string;
  keyName: string;
  localApplied: boolean;
}
export interface SecurityTouchEvent extends SecurityTouchPacket {
  deviceId: string;
}

const uint32 = (value: unknown, minimum = 0): value is number =>
  Number.isInteger(value) && (value as number) >= minimum && (value as number) <= 0xffff_ffff;
const safeTime = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  new TextEncoder().encode(value).length <= maximum &&
  !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key));
const fenceFields = (value: Record<string, unknown>) =>
  text(value.hubEpoch, 96) && uint32(value.modeRevision) && uint32(value.leaseSequence, 1);
const inputFields = (value: Record<string, unknown>) =>
  text(value.hubEpoch, 96) &&
  uint32(value.modeRevision) &&
  typeof value.touchArmed === 'boolean' &&
  typeof value.busy === 'boolean';

/** @brief A fence must fit the exact current authority context; arbitrary JSON extensions are refused. */
export function isSecurityCommandFence(value: unknown): value is SecurityCommandFence {
  return (
    object(value) &&
    keys(value, ['hubEpoch', 'modeRevision', 'leaseSequence']) &&
    fenceFields(value)
  );
}
export function isSecurityLeaseInput(value: unknown): value is SecurityLeaseInput {
  return (
    object(value) &&
    keys(value, ['hubEpoch', 'modeRevision', 'touchArmed', 'busy']) &&
    inputFields(value)
  );
}
export function isSecurityLeasePacket(value: unknown): value is SecurityLeasePacket {
  return (
    object(value) &&
    keys(value, [
      'schemaVersion',
      'bootId',
      'hubEpoch',
      'leaseSequence',
      'modeRevision',
      'expiresAtUptimeMs',
      'touchArmed',
      'busy',
    ]) &&
    inputFields(value) &&
    value.schemaVersion === 1 &&
    text(value.bootId, 96) &&
    uint32(value.leaseSequence, 1) &&
    safeTime(value.expiresAtUptimeMs)
  );
}
export function isSecurityTouchPacket(value: unknown): value is SecurityTouchPacket {
  return (
    object(value) &&
    keys(value, [
      'schemaVersion',
      'bootId',
      'hubEpoch',
      'leaseSequence',
      'modeRevision',
      'eventSequence',
      'eventAtUptimeMs',
      'value',
      'keyId',
      'keyName',
      'localApplied',
    ]) &&
    fenceFields(value) &&
    value.schemaVersion === 1 &&
    text(value.bootId, 96) &&
    uint32(value.eventSequence, 1) &&
    safeTime(value.eventAtUptimeMs) &&
    typeof value.value === 'boolean' &&
    text(value.keyId, 32) &&
    text(value.keyName, 96) &&
    typeof value.localApplied === 'boolean'
  );
}
