/**
 * @file backup_mock.cjs
 * @brief Validate simulated backup envelopes and migrate supported controller document versions.
 */
'use strict';
const {
  validLegacyThermostatDurations,
  withoutLegacyThermostatDurations,
} = require('./thermostat_policy.cjs');
const crypto = require('node:crypto');
const { emptySecurity } = require('./security_mock.cjs');
const { normalizeBoardId } = require('./board_profiles_mock.cjs');

function verifier(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 20000;
  return {
    username,
    algorithm: 'PBKDF2-HMAC-SHA256',
    iterations,
    salt,
    hash: crypto
      .pbkdf2Sync(password, Buffer.from(salt, 'hex'), iterations, 32, 'sha256')
      .toString('hex'),
  };
}
function verifyPassword(account, password) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 128 || password.includes('\0'))
    return false;
  const derived = crypto.pbkdf2Sync(
    password,
    Buffer.from(account.salt, 'hex'),
    account.iterations,
    32,
    'sha256',
  );
  return crypto.timingSafeEqual(derived, Buffer.from(account.hash, 'hex'));
}
function text(value, max, required = false) {
  return (
    typeof value === 'string' &&
    Buffer.from(value).toString() === value &&
    Buffer.byteLength(value) <= max &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    (!required || Boolean(value.trim()))
  );
}
function object(value, required, optional = []) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function ipv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
  const bytes = value.split('.').map(Number);
  return bytes.every((byte) => byte <= 255)
    ? bytes.reduce((result, byte) => (result * 256 + byte) >>> 0, 0)
    : null;
}
function subnet(ip, mask) {
  ip = ipv4(ip);
  mask = ipv4(mask);
  if (ip === null || mask === null || !mask) return false;
  const inverse = ~mask >>> 0,
    host = ip & inverse;
  return (
    inverse >= 3 &&
    (inverse & (inverse + 1)) === 0 &&
    ip >>> 24 > 0 &&
    ip >>> 24 < 224 &&
    host !== 0 &&
    host >>> 0 !== inverse
  );
}
function hostname(value, optional) {
  return (
    text(value, 253) &&
    (value === ''
      ? optional
      : /^[a-zA-Z0-9.-]+$/.test(value) && !value.startsWith('.') && !value.endsWith('.'))
  );
}
function wifiPassword(value) {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    Buffer.from(value).toString() === value &&
    (value === '' || (Buffer.byteLength(value) >= 8 && Buffer.byteLength(value) <= 63))
  );
}
function validSettings(config) {
  if (
    !object(config, ['device', 'hardware', 'wifi', 'ethernet', 'linux', 'time']) ||
    !object(config.device, ['name']) ||
    !text(config.device.name, 64, true) ||
    !object(config.hardware, ['boardId']) ||
    !text(config.hardware.boardId, 64, true) ||
    !object(config.wifi, ['enabled', 'ap', 'sta']) ||
    typeof config.wifi.enabled !== 'boolean' ||
    !object(config.wifi.ap, ['enabled', 'ssid', 'password', 'channel', 'ip', 'netmask']) ||
    !object(config.wifi.sta, ['enabled', 'ssid', 'password']) ||
    !object(config.ethernet, ['enabled', 'dhcp', 'ip', 'netmask', 'gateway', 'dns']) ||
    !object(config.linux, ['host', 'port', 'username', 'password']) ||
    !object(config.time, ['timezone', 'ntpEnabled', 'ntpServer'])
  )
    return false;
  const { wifi, ethernet, linux, time } = config;
  if (
    ![wifi.ap.enabled, wifi.sta.enabled, ethernet.enabled, ethernet.dhcp, time.ntpEnabled].every(
      (value) => typeof value === 'boolean',
    )
  )
    return false;
  const ap = wifi.enabled && wifi.ap.enabled,
    sta = wifi.enabled && wifi.sta.enabled;
  if (
    (!ethernet.enabled && !ap && !sta) ||
    !text(wifi.ap.ssid, 32, ap) ||
    !text(wifi.sta.ssid, 32, sta) ||
    !wifiPassword(wifi.ap.password) ||
    !wifiPassword(wifi.sta.password) ||
    !Number.isInteger(wifi.ap.channel) ||
    wifi.ap.channel < 1 ||
    wifi.ap.channel > 11 ||
    !subnet(wifi.ap.ip, wifi.ap.netmask)
  )
    return false;
  if (!['ip', 'netmask', 'gateway', 'dns'].every((key) => typeof ethernet[key] === 'string'))
    return false;
  if (ethernet.enabled && !ethernet.dhcp) {
    if (
      !subnet(ethernet.ip, ethernet.netmask) ||
      ipv4(ethernet.gateway) === null ||
      ipv4(ethernet.dns) === null
    )
      return false;
    const ip = ipv4(ethernet.ip),
      mask = ipv4(ethernet.netmask),
      gateway = ipv4(ethernet.gateway);
    if (gateway !== 0 && (gateway & mask) !== (ip & mask)) return false;
    const common = ipv4(wifi.ap.netmask) & mask;
    if (ap && (ipv4(wifi.ap.ip) & common) === (ip & common)) return false;
  }
  return (
    hostname(linux.host, true) &&
    Number.isInteger(linux.port) &&
    linux.port >= 1 &&
    linux.port <= 65535 &&
    text(linux.username, 128) &&
    text(linux.password, 128) &&
    text(time.timezone, 96, true) &&
    hostname(time.ntpServer, !time.ntpEnabled)
  );
}

/** @brief Expand older backup versions with the same default module/mode migration as firmware. */
function backupControllers(document) {
  return {
    irrigation:
      document.version >= 10 ? document.controllers.irrigation : { enabled: false, items: [] },
    tanks: document.version >= 9 ? document.controllers.tanks : { enabled: false, items: [] },
    sockets: document.controllers.sockets,
    lights: document.version >= 2 ? document.controllers.lights : { enabled: false, items: [] },
    meteo: document.version >= 3 ? document.controllers.meteo : { enabled: false, items: [] },
    thermostats:
      document.version >= 4
        ? {
            ...document.controllers.thermostats,
            items: document.controllers.thermostats.items.map((item) => ({
              ...(document.version === 6 ? withoutLegacyThermostatDurations(item) : item),
              ...(document.version === 4 ? { inputId: '', enabled: true } : {}),
            })),
          }
        : { enabled: false, items: [] },
    security:
      document.version >= 8
        ? document.controllers.security
        : Object.fromEntries(Object.entries(emptySecurity()).filter(([key]) => key !== 'revision')),
  };
}
/** @brief Validate the whole simulated restore before staging any settings or account changes. */
function validateBackup(document, activeBoardId, controllers, profiles) {
  if (
    !object(
      document,
      ['format', 'version', 'product', 'boardId', 'config', 'user', 'controllers'],
      ['sourceDeviceId'],
    ) ||
    document.format !== 'fcplcn-config' ||
    ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(document.version) ||
    document.product !== 'FCPLCn'
  ) {
    return { status: 400, error: 'Неподдерживаемый формат резервной копии' };
  }
  if (
    normalizeBoardId(document.boardId, profiles) !== activeBoardId ||
    normalizeBoardId(document.config?.hardware?.boardId, profiles) !== activeBoardId
  )
    return { status: 409, error: 'Профиль резервной копии не совпадает с активной платой' };
  if (
    !validSettings(document.config) ||
    !object(
      document.controllers,
      document.version === 1
        ? ['sockets']
        : document.version === 2
          ? ['sockets', 'lights']
          : document.version === 3
            ? ['sockets', 'lights', 'meteo']
            : document.version >= 10
              ? ['sockets', 'lights', 'meteo', 'thermostats', 'security', 'tanks', 'irrigation']
              : document.version >= 9
                ? ['sockets', 'lights', 'meteo', 'thermostats', 'security', 'tanks']
                : document.version >= 8
                  ? ['sockets', 'lights', 'meteo', 'thermostats', 'security']
                  : ['sockets', 'lights', 'meteo', 'thermostats'],
    ) ||
    (document.version === 4 &&
      (!object(document.controllers.thermostats, ['enabled', 'items']) ||
        !Array.isArray(document.controllers.thermostats.items) ||
        document.controllers.thermostats.items.some(
          (item) =>
            !object(item, ['id', 'name', 'meteoId', 'relayId', 'mode', 'setpointC', 'hysteresisC']),
        ))) ||
    (document.version === 5 &&
      (!object(document.controllers.thermostats, ['enabled', 'items']) ||
        !Array.isArray(document.controllers.thermostats.items) ||
        document.controllers.thermostats.items.some(
          (item) =>
            !object(item, [
              'id',
              'name',
              'meteoId',
              'relayId',
              'inputId',
              'enabled',
              'mode',
              'setpointC',
              'hysteresisC',
            ]),
        ))) ||
    (document.version === 6 &&
      (!object(document.controllers.thermostats, ['enabled', 'items']) ||
        !Array.isArray(document.controllers.thermostats.items) ||
        document.controllers.thermostats.items.some(
          (item) =>
            !object(item, [
              'id',
              'name',
              'meteoId',
              'relayId',
              'inputId',
              'enabled',
              'mode',
              'setpointC',
              'hysteresisC',
              'minOnSeconds',
              'minOffSeconds',
            ]) || !validLegacyThermostatDurations(item, true),
        ))) ||
    controllers.validateRestore(backupControllers(document))
  ) {
    return { status: 400, error: 'Резервная копия содержит неполные или некорректные настройки' };
  }
  const user = document.user;
  if (
    !object(user, ['username', 'algorithm', 'iterations', 'salt', 'hash']) ||
    !text(user.username, 64, true) ||
    user.algorithm !== 'PBKDF2-HMAC-SHA256' ||
    !Number.isInteger(user.iterations) ||
    user.iterations < 20000 ||
    user.iterations > 1000000 ||
    typeof user.salt !== 'string' ||
    !/^[0-9a-fA-F]{32}$/.test(user.salt) ||
    typeof user.hash !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(user.hash) ||
    ('sourceDeviceId' in document && !text(document.sourceDeviceId, 128, true))
  )
    return { status: 400, error: 'Некорректная учётная запись в резервной копии' };
  return null;
}
module.exports = { verifier, verifyPassword, validateBackup, backupControllers, text };
