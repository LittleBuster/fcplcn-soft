/**
 * @file ui_test.cjs
 * @brief Serve isolated API fixtures and exercise the shipped browser UI with Playwright.
 */
'use strict';

// Exercise the shipped browser assets against an HTTP mock of the API contract.
// The production config/model code is covered independently by test-base-config.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHardwareMock } = require('./hardware_mock.cjs');
const { fixedUtcOffsetMinutes } = require('./irrigation_mock.cjs');
const { createControllersMock } = require('./controllers_mock.cjs');
const { createStaticAssets } = require('./static_assets.cjs');
const { createFirmwareMock } = require('./firmware_mock.cjs');
const {
  verifier,
  verifyPassword,
  validateBackup,
  backupControllers,
  text: validText,
} = require('./backup_mock.cjs');
const {
  canonicalBoardId,
  legacyBoardId,
  normalizeBoardId,
  framProfile,
  eepromBoardId,
  eepromBoardProfile,
} = require('./board_profiles_mock.cjs');

const repository = path.resolve(__dirname, '../../../..');
const assets = path.join(repository, 'firmware/base/web');
const artifacts = path.join(__dirname, '.artifacts');
const product = JSON.parse(fs.readFileSync(path.join(repository, 'config/product.json'), 'utf8'));
const defaultProfiles = [
  {
    boardId: canonicalBoardId,
    boardName: 'FCPLCN-161608-1v0',
    legacyIds: [legacyBoardId],
    mcu: 'ESP32-S3-WROOM-1U N16R8',
    flashBytes: 16 * 1024 * 1024,
    psramBytes: 8 * 1024 * 1024,
    fram: { ...framProfile },
    stateMemory: { type: 'fram', ...framProfile, pageSizeBytes: 0, writeCycleTimeoutMs: 0 },
    capabilities: {
      ethernet: true,
      relays: 16,
      inputs: 16,
      i2cBuses: 2,
      sensorPorts: 8,
      rs485: true,
      fram: true,
      stateMemory: true,
      eeprom: false,
    },
    driversImplemented: {
      ethernet: true,
      relays: true,
      inputs: true,
      leds: true,
      sensorPorts: true,
      rs485: false,
      fram: true,
      stateMemory: true,
      eeprom: false,
    },
  },
  eepromBoardProfile,
];
/**
 * @brief Create one isolated simulated PLC and its HTTP server.
 * @note Interactive mode only adds desktop controls; all network and GPIO actions remain virtual.
 */
function createMock({
  interactive = false,
  profiles = defaultProfiles,
  boardId = canonicalBoardId,
  statePath,
  deviceId,
  mac = 'AA:BB:CC:11:22:33',
  managementToken,
  initialBackup,
  initialFirmware,
  sessionNow = Date.now,
} = {}) {
  const registry = JSON.parse(JSON.stringify(profiles));
  const account = verifier('admin', '');
  const identity = deviceId || (interactive ? 'fcplcn-simulator' : 'fcplcn-test');
  let session = '';
  // Only the desktop simulator needs concurrent browser sessions. Keep the ordinary
  // fixture's deterministic session unchanged; production auth remains C++-owned.
  const simulatorSessions = new Map();
  const sessionLifetimeMs = 8 * 60 * 60 * 1000;
  const requestToken = (request) =>
    String(request.headers.cookie || '')
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith('session='))
      ?.slice('session='.length) || '';
  function expireSimulatorSessions() {
    const now = sessionNow();
    for (const [token, entry] of simulatorSessions)
      if (now >= entry.expiresAt) simulatorSessions.delete(token);
    return now;
  }
  function revokeSessions() {
    session = '';
    simulatorSessions.clear();
  }
  function createSimulatorSession(previous) {
    const now = expireSimulatorSessions();
    // A browser re-login rotates its own token, leaving other browsers signed in.
    simulatorSessions.delete(previous);
    if (simulatorSessions.size >= 4) {
      const oldest = [...simulatorSessions].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      simulatorSessions.delete(oldest[0]);
    }
    const token = crypto.randomBytes(32).toString('hex');
    simulatorSessions.set(token, { expiresAt: now + sessionLifetimeMs, lastUsed: now });
    return token;
  }
  function simulatorAuthenticated(token) {
    const now = expireSimulatorSessions();
    const entry = simulatorSessions.get(token);
    if (!entry) return false;
    entry.lastUsed = now;
    return true;
  }
  let rebootCount = 0;
  let rebootRequests = 0;
  let configRequests = 0;
  let rebootTimer;
  let lastConfigPatch;
  let lastConfigResponse;
  let timeRequests = 0;
  let backupRequests = 0;
  let restoreRequests = 0;
  let restorePending = false;
  let bootTime = Date.now();
  let clockOffset = 0;
  let clockSource = 'ntp';
  let chipTemperatureC = 43.5;
  const firmware = createFirmwareMock({
    product: product.name,
    version: interactive ? '0.1.0-base-sim' : '0.1.0-base',
    initial: initialFirmware,
  });
  const faults = {
    sta: '',
    ethernet: '',
    linux: '',
    registry: '',
    config: '',
    reboot: '',
    restore: '',
  };
  const passwords = { 'wifi.ap': '', 'wifi.sta': '', linux: '' };
  const config = {
    revision: 1,
    device: { name: 'FCPLCn' },
    hardware: { boardId },
    wifi: {
      enabled: true,
      ap: {
        enabled: true,
        ssid: 'FCPLCn-A1B2C3',
        passwordSet: false,
        channel: 1,
        ip: '192.168.4.1',
        netmask: '255.255.255.0',
      },
      sta: { enabled: false, ssid: '', passwordSet: false },
    },
    ethernet: {
      enabled: true,
      dhcp: true,
      ip: '192.168.1.50',
      netmask: '255.255.255.0',
      gateway: '192.168.1.1',
      dns: '192.168.1.1',
    },
    linux: { host: '', port: 1883, username: '', passwordSet: false },
    time: { timezone: 'UTC-7', ntpEnabled: true, ntpServer: 'pool.ntp.org' },
    user: { username: account.username },
  };
  let activeBoardId = config.hardware.boardId;

  function merge(target, patch, secrets, prefix = '') {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'baseRevision' && !prefix) continue;
      if (key === 'password' && Object.hasOwn(secrets, prefix) && typeof value === 'string') {
        target.passwordSet = value.length > 0;
        secrets[prefix] = value;
        continue;
      }
      if (
        !Object.hasOwn(target, key) ||
        key === 'passwordSet' ||
        typeof value !== typeof target[key] ||
        value === null ||
        Array.isArray(value)
      ) {
        throw Object.assign(new Error('Неизвестное поле или неверный тип настройки'), {
          status: 400,
        });
      }
      if (typeof value === 'object')
        merge(target[key], value, secrets, prefix ? `${prefix}.${key}` : key);
      else target[key] = value;
    }
  }

  const localOffsetMinutes = () => fixedUtcOffsetMinutes(config.time.timezone);
  function localTime(unixTime) {
    const minutes = localOffsetMinutes() || 0;
    return (
      new Date(unixTime * 1000 + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ') +
      (minutes ? ` UTC${minutes >= 0 ? '+' : '-'}${Math.abs(minutes) / 60}` : ' UTC')
    );
  }

  const unixTime = () => (interactive ? Math.floor((Date.now() + clockOffset) / 1000) : 1794480000);
  const hardware = createHardwareMock({
    interactive,
    unixTime,
    localTime,
    profile: () => registry.find((item) => item.boardId === activeBoardId),
  });
  const controllers = createControllersMock({
    hardware,
    statePath,
    irrigationClock: () => (unixTime() + localOffsetMinutes() * 60) * 1000,
    boardId: activeBoardId,
    normalizeId: (id) => normalizeBoardId(id, registry),
  });
  const { sockets, lights, meteo, thermostats, security } = controllers.modules;
  hardware.setStateStorageSource(() => controllers.exportSettings());

  /** @brief Export saved settings and secrets; UI drafts never enter this document. */
  function backupDocument() {
    const settings = JSON.parse(JSON.stringify(config));
    delete settings.revision;
    delete settings.user;
    for (const [target, key] of [
      [settings.wifi.ap, 'wifi.ap'],
      [settings.wifi.sta, 'wifi.sta'],
      [settings.linux, 'linux'],
    ]) {
      delete target.passwordSet;
      target.password = passwords[key];
    }
    return {
      format: 'fcplcn-config',
      version: 10,
      product: product.name,
      boardId: config.hardware.boardId,
      sourceDeviceId: identity,
      config: settings,
      user: { ...account },
      controllers: controllers.exportSettings(),
    };
  }

  /** @brief Finish an already-staged restore and invalidate the simulated session on reboot. */
  function applyBackup(document) {
    const restored = JSON.parse(JSON.stringify(document.config));
    for (const [target, key] of [
      [restored.wifi.ap, 'wifi.ap'],
      [restored.wifi.sta, 'wifi.sta'],
      [restored.linux, 'linux'],
    ]) {
      passwords[key] = target.password;
      target.passwordSet = Boolean(target.password);
      delete target.password;
    }
    restored.revision = config.revision + 1;
    restored.user = { username: document.user.username };
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, restored);
    Object.assign(account, document.user);
    controllers.applyRestore();
    activeBoardId = config.hardware.boardId;
    bootTime = Date.now();
    hardware.reboot();
    controllers.reboot();
    revokeSessions();
    restorePending = false;
    rebootTimer = undefined;
  }

  // The LAN hub demo reuses this model with a private loopback transport. Ordinary browser
  // fixtures retain their normal login behavior and never enable this transport implicitly.
  if (initialBackup) {
    const issue = validateBackup(initialBackup, activeBoardId, controllers, registry);
    if (issue) {
      controllers.close();
      throw new Error(issue.error);
    }
    applyBackup(JSON.parse(JSON.stringify(initialBackup)));
  }

  const staticAssets = createStaticAssets({
    directory: assets,
    productPath: path.join(repository, 'config/product.json'),
    extras: interactive
      ? {
          'simulator-inputs.js': fs.readFileSync(
            path.join(__dirname, 'simulator-inputs.js'),
            'utf8',
          ),
        }
      : {},
    transform(file, source) {
      let data = source;
      if (interactive && file === 'index.html') {
        data = data
          .toString()
          .replace(
            '<div class="shell">',
            `<div class="shell"><aside class="notice warning simulator-banner" role="note"><strong>Симулятор FCPLCn на компьютере.</strong> GPIO, реле, входы, I²C, RTC, сети, MQTT и перезапуск имитируются. Найденные I²C-адреса — демонстрационные. ${statePath ? 'Настройки и состояния контроллеров сохраняются между запусками; остальные настройки — до остановки симулятора.' : 'Настройки сохраняются до остановки симулятора.'} Оборудование и настройки Mac не изменяются.</aside>`,
          );
        data = data.replace(
          '</body>',
          '<section class="shell notice" aria-label="Охрана симулятора"><strong>Охрана — только демонстрация</strong><p id="simulator-security-status">После входа здесь доступны контакты iButton и датчики.</p><div id="simulator-security-keys" class="button-row"></div><div id="simulator-security-zones" class="button-row"></div></section><section id="simulator-input-tools" class="shell notice simulator-buttons" aria-label="Кнопки симулятора"><strong>Кнопки симулятора — только демонстрация</strong><p id="simulator-input-status">После входа здесь появятся кнопки входов, назначенных розеткам, свету или термостатам. Нажатие даёт LOW, отпускание — HIGH; автоматика входов для них отключена.</p><div id="simulator-input-buttons" class="button-row"></div></section><section class="shell notice" aria-label="Температуры симулятора"><strong>Температура — только демонстрация</strong><p id="simulator-temperature-status">Сохраните метеоточку, чтобы менять виртуальную температуру и наблюдать автономную работу термостата.</p><div id="simulator-temperatures"></div></section><section class="shell notice" aria-label="Вода в баках симулятора"><strong>Баки — только демонстрация</strong><p id="simulator-tanks-status">Сохраните бак и назначьте входы, чтобы менять виртуальные уровни воды.</p><div id="simulator-tanks"></div></section><script src="/simulator-inputs.js" defer></script></body>',
        );
      }
      if (interactive && file === 'style.css')
        data = data.toString() + '\n.simulator-banner { margin-top: 20px; }\n';
      return data;
    },
  });

  const server = http.createServer(async (request, response) => {
    const json = (data, status = 200) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(data));
    };
    try {
      const simulatorRequest = interactive && request.url.startsWith('/__simulator/');
      if (!request.url.startsWith('/api/v1/') && !simulatorRequest) {
        if (request.url === '/favicon.ico') {
          response.writeHead(204);
          response.end();
          return;
        }
        staticAssets.serve(request, response);
        return;
      }
      const chunks = [];
      let bodyBytes = 0;
      for await (const chunk of request) {
        bodyBytes += chunk.length;
        if (
          bodyBytes >
          (request.url === '/api/v1/config/restore'
            ? 32768
            : request.url === '/api/v1/firmware/chunk'
              ? 24 * 1024
              : 8192)
        )
          return json({ error: 'Слишком большой запрос' }, 413);
        chunks.push(chunk);
      }
      let data;
      try {
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        data = body ? JSON.parse(body) : {};
      } catch (_) {
        return json({ error: 'Некорректный JSON' }, 400);
      }
      if (request.url === '/api/v1/login' && request.method === 'POST') {
        if (data.username !== account.username || !verifyPassword(account, data.password)) {
          return json({ error: 'Неверный логин или пароль' }, 401);
        }
        const token = interactive
          ? createSimulatorSession(requestToken(request))
          : (session = 'fcplcn-ui-test-session');
        response.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json({ ok: true, username: account.username });
      }
      const trustedManagement =
        typeof managementToken === 'string' &&
        managementToken.length >= 32 &&
        request.headers['x-fcplcn-management-token'] === managementToken;
      if (
        !trustedManagement &&
        !(interactive
          ? simulatorAuthenticated(requestToken(request))
          : session &&
            String(request.headers.cookie || '')
              .split(';')
              .some((cookie) => cookie.trim() === `session=${session}`))
      ) {
        return json({ error: 'Требуется вход' }, 401);
      }
      if (restorePending && request.method === 'POST')
        return json({ error: 'Восстановление принято, ожидается перезагрузка' }, 503);
      if (request.url === '/api/v1/firmware' || request.url.startsWith('/api/v1/firmware/')) {
        if (request.method === 'POST' && rebootTimer)
          return json({ error: 'Перезагрузка уже запланирована' }, 409);
        const result = firmware.route(request.method, request.url.slice('/api/v1'.length), data);
        if (result.status === 200 && request.url === '/api/v1/firmware/finish') {
          rebootCount++;
          rebootTimer = setTimeout(() => {
            bootTime = Date.now();
            activeBoardId = config.hardware.boardId;
            firmware.reboot();
            hardware.reboot();
            controllers.reboot();
            revokeSessions();
            rebootTimer = undefined;
          }, 1000).unref();
        }
        return json(result.data, result.status);
      }
      if (
        request.method === 'POST' &&
        ['receiving', 'ready'].includes(firmware.snapshot().state) &&
        request.url !== '/api/v1/logout'
      )
        return json({ error: 'Дождитесь завершения обновления прошивки' }, 409);
      if (simulatorRequest && request.url === '/__simulator/security' && request.method === 'GET')
        return json(controllers.securityDemo());
      if (simulatorRequest && request.url === '/__simulator/ibutton' && request.method === 'POST') {
        const result = await controllers.simulateIbutton(data);
        return json(result.data, result.status);
      }
      if (
        simulatorRequest &&
        request.url === '/__simulator/security-zone' &&
        request.method === 'POST'
      ) {
        const result = await controllers.simulateSecurityZone(data);
        return json(result.data, result.status);
      }
      if (simulatorRequest && request.url === '/__simulator/tanks' && request.method === 'GET')
        return json({ tanks: controllers.simulatedTanks() });
      if (simulatorRequest && request.url === '/__simulator/tank' && request.method === 'POST') {
        const result = controllers.simulateTankLevel(data);
        return json(result.data, result.status);
      }
      if (simulatorRequest && request.url === '/__simulator/inputs' && request.method === 'GET')
        return json({ inputs: controllers.simulatedInputs() });
      if (simulatorRequest && request.url === '/__simulator/input' && request.method === 'POST') {
        const result = controllers.simulateInput(data);
        return json(result.data, result.status);
      }
      if (
        simulatorRequest &&
        request.url === '/__simulator/temperatures' &&
        request.method === 'GET'
      )
        return json({ temperatures: controllers.simulatedTemperatures() });
      if (
        simulatorRequest &&
        request.url === '/__simulator/temperature' &&
        request.method === 'POST'
      ) {
        const result = controllers.simulateTemperature(data);
        return json(result.data, result.status);
      }
      if (request.url === '/api/v1/config' && request.method === 'GET') return json(config);
      if (request.url === '/api/v1/config/backup' && request.method === 'GET') {
        backupRequests++;
        return json(backupDocument());
      }
      if (request.url === '/api/v1/config/restore' && request.method === 'POST') {
        restoreRequests++;
        if (data.baseRevision !== config.revision)
          return json({ error: 'Конфигурация изменена. Обновите настройки.' }, 409);
        const error = validateBackup(data.document, activeBoardId, controllers, registry);
        if (error) return json({ error: error.error }, error.status);
        if (faults.restore || rebootTimer)
          return json({ error: faults.restore || 'Перезагрузка уже запланирована' }, 503);
        const document = JSON.parse(JSON.stringify(data.document));
        document.boardId = activeBoardId;
        document.config.hardware.boardId = activeBoardId;
        restorePending = true;
        try {
          await controllers.stageRestore(backupControllers(document));
        } catch (error) {
          restorePending = false;
          return json({ error: error.message }, 503);
        }
        rebootCount++;
        rebootTimer = setTimeout(() => applyBackup(document), 1000).unref();
        return json({ ok: true, rebootRequired: true });
      }
      if (request.url === '/api/v1/controllers' && request.method === 'GET') {
        const result = controllers.get();
        return json(result.data, result.status);
      }
      const controllerRoute =
        /^\/api\/v1\/controllers\/(sockets|lights|meteo|thermostats|security|tanks|irrigation)(\/(?:state|scan|enabled|armed))?$/.exec(
          request.url,
        );
      if (controllerRoute) {
        if (controllerRoute[2] === '/armed') {
          if (controllerRoute[1] !== 'security' || request.method !== 'POST')
            return json({ error: 'Not found' }, 404);
          const result = await security.armed(data);
          return json(result.data, result.status);
        }
        const module = controllers.modules[controllerRoute[1]];
        if (controllerRoute[2] === '/enabled') {
          if (
            !['thermostats', 'tanks', 'irrigation'].includes(controllerRoute[1]) ||
            request.method !== 'POST'
          )
            return json({ error: 'Not found' }, 404);
          const result = await module.enabled(data);
          return json(result.data, result.status);
        }
        if (controllerRoute[2] === '/scan') {
          if (!['meteo', 'security'].includes(controllerRoute[1]) || request.method !== 'POST')
            return json({ error: 'Not found' }, 404);
          const result = await module.scan(data);
          return json(result.data, result.status);
        }
        if (
          ['meteo', 'thermostats', 'tanks', 'irrigation'].includes(controllerRoute[1]) &&
          controllerRoute[2]
        )
          return json({ error: 'Not found' }, 404);
        const result =
          controllerRoute[2] && request.method === 'POST'
            ? await module.state(data)
            : request.method === 'POST'
              ? await module.save(data)
              : module.get();
        return json(result.data, result.status);
      }
      if (request.url === '/api/v1/hardware' && request.method === 'GET') {
        const result = await hardware.get();
        return json(result.data, result.status);
      }
      if (request.url === '/api/v1/hardware/relay' && request.method === 'POST') {
        const result = await controllers.relay(data);
        return json(result.data, result.status);
      }
      if (request.url === '/api/v1/hardware/scan' && request.method === 'POST')
        return json(hardware.scan());
      if (request.url === '/api/v1/board-profiles' && request.method === 'GET') {
        return faults.registry ? json({ error: faults.registry }, 503) : json(registry);
      }
      if (request.url === '/api/v1/status' && request.method === 'GET') {
        const unixTime = interactive ? Math.floor((Date.now() + clockOffset) / 1000) : 1794480000;
        const staConnected =
          interactive &&
          config.wifi.enabled &&
          config.wifi.sta.enabled &&
          Boolean(config.wifi.sta.ssid) &&
          !faults.sta;
        const ethernetUp = config.ethernet.enabled && !faults.ethernet;
        return json({
          product,
          firmwareVersion: firmware.snapshot().version,
          uptimeSec: interactive ? Math.floor((Date.now() - bootTime) / 1000) : 150,
          device: { name: config.device.name, id: identity, mac },
          hardware: {
            ...registry.find((profile) => profile.boardId === activeBoardId),
            boardId: activeBoardId,
            configuredBoardId: config.hardware.boardId,
            rebootRequired: config.hardware.boardId !== activeBoardId,
          },
          system: {
            chipTemperatureC:
              interactive && Number.isFinite(chipTemperatureC)
                ? Number(
                    (chipTemperatureC + Math.sin((Date.now() - bootTime) / 45000) * 1.2).toFixed(1),
                  )
                : chipTemperatureC,
          },
          stateStorage: hardware.stateStorageSnapshot(),
          wifi: {
            enabled: config.wifi.enabled,
            ap: {
              enabled: config.wifi.enabled && config.wifi.ap.enabled,
              ssid: config.wifi.ap.ssid,
              ip: config.wifi.ap.ip,
              clients: 1,
            },
            sta: {
              enabled: config.wifi.enabled && config.wifi.sta.enabled,
              connected: staConnected,
              ssid: config.wifi.sta.ssid,
              ip: staConnected ? '192.168.1.51' : '',
              rssi: staConnected ? -48 : null,
              error: faults.sta,
            },
          },
          ethernet: {
            ...config.ethernet,
            linkUp: ethernetUp,
            mac: 'AA:BB:CC:11:22:34',
            error: faults.ethernet,
          },
          time: {
            unixTime,
            localTime: interactive ? localTime(unixTime) : '12.11.2026 12:00:00',
            valid: true,
            source: interactive ? clockSource : 'manual',
            externalRtcPresent: true,
            externalRtcValid: hardware.snapshot().rtc.valid,
            externalRtcModel: 'DS3231MZ+',
          },
          linux: {
            ...config.linux,
            connected:
              interactive &&
              Boolean(config.linux.host) &&
              (ethernetUp || staConnected) &&
              !faults.linux,
            error: faults.linux,
          },
        });
      }
      if (request.url === '/api/v1/config' && request.method === 'POST') {
        configRequests++;
        if (
          !data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          Object.keys(data).some(
            (key) =>
              !['baseRevision', 'device', 'hardware', 'wifi', 'ethernet', 'linux', 'time'].includes(
                key,
              ),
          )
        ) {
          return json({ error: 'Неизвестное поле настройки' }, 400);
        }
        if (data.baseRevision !== config.revision)
          return json({ error: 'Конфигурация изменена. Обновите настройки.' }, 409);
        if (
          'hardware' in data &&
          (!data.hardware ||
            typeof data.hardware !== 'object' ||
            Array.isArray(data.hardware) ||
            ('boardId' in data.hardware && typeof data.hardware.boardId !== 'string'))
        ) {
          return json({ error: 'Некорректный аппаратный профиль.' }, 400);
        }
        if (
          'device' in data &&
          (!data.device ||
            Object.keys(data.device).some((key) => key !== 'name') ||
            !validText(data.device.name, 64, true))
        ) {
          return json({ error: 'Некорректное имя устройства' }, 400);
        }
        const proposed = JSON.parse(JSON.stringify(config));
        const nextPasswords = { ...passwords };
        const patch = JSON.parse(JSON.stringify(data));
        if (patch.hardware?.boardId)
          patch.hardware.boardId =
            normalizeBoardId(patch.hardware.boardId, registry) || patch.hardware.boardId;
        merge(proposed, patch, nextPasswords);
        if (!registry.some((profile) => profile.boardId === proposed.hardware.boardId))
          return json({ error: 'Неизвестный аппаратный профиль.' }, 400);
        if (
          !proposed.ethernet.enabled &&
          !(proposed.wifi.enabled && (proposed.wifi.ap.enabled || proposed.wifi.sta.enabled))
        ) {
          return json({ error: 'Оставьте включённым хотя бы один сетевой интерфейс.' }, 400);
        }
        if (faults.config) return json({ error: faults.config }, 500);
        const changed =
          JSON.stringify(proposed) !== JSON.stringify(config) ||
          JSON.stringify(nextPasswords) !== JSON.stringify(passwords);
        const hardwareChanged = proposed.hardware.boardId !== config.hardware.boardId;
        lastConfigPatch = data;
        if (changed) {
          merge(config, patch, passwords);
          config.revision++;
        }
        lastConfigResponse = {
          ok: true,
          revision: config.revision,
          networkRestart:
            changed && !hardwareChanged && Boolean(data.wifi || data.ethernet || data.linux),
          rebootRequired: config.hardware.boardId !== activeBoardId,
        };
        return json(lastConfigResponse);
      }
      if (request.url === '/api/v1/user' && request.method === 'POST') {
        if (!verifyPassword(account, data.currentPassword))
          return json({ error: 'Неверный текущий пароль' }, 403);
        if (
          !validText(data.username, 64, true) ||
          ('newPassword' in data &&
            (typeof data.newPassword !== 'string' ||
              Buffer.byteLength(data.newPassword) > 128 ||
              data.newPassword.includes('\0') ||
              Buffer.from(data.newPassword).toString() !== data.newPassword))
        ) {
          return json({ error: 'Некорректный логин или пароль' }, 400);
        }
        account.username = data.username;
        config.user.username = data.username;
        if ('newPassword' in data)
          Object.assign(account, verifier(data.username, data.newPassword));
        revokeSessions();
        return json({ ok: true, reauthenticate: true });
      }
      if (request.url === '/api/v1/time' && request.method === 'POST') {
        if (interactive) {
          if (
            !Number.isInteger(data.unixTime) ||
            data.unixTime < 1704067200 ||
            data.unixTime > 4102444799
          )
            return json({ error: 'Некорректное время' }, 400);
          if (data.timezone !== config.time.timezone)
            return json({ error: 'Часовой пояс изменился. Обновите настройки.' }, 409);
          clockOffset = data.unixTime * 1000 - Date.now();
          clockSource = 'manual';
        }
        assert.equal(data.timezone, config.time.timezone);
        assert.equal(Number.isInteger(data.unixTime), true);
        timeRequests++;
        return json({ ok: true, revision: config.revision });
      }
      if (request.url === '/api/v1/reboot' && request.method === 'POST') {
        rebootRequests++;
        if (faults.reboot) return json({ error: faults.reboot }, 500);
        rebootCount++;
        if (!interactive) {
          hardware.reboot();
          controllers.reboot();
        }
        if (interactive && !rebootTimer)
          rebootTimer = setTimeout(() => {
            bootTime = Date.now();
            activeBoardId = config.hardware.boardId;
            hardware.reboot();
            controllers.reboot();
            firmware.reboot();
            revokeSessions();
            rebootTimer = undefined;
          }, 1000).unref();
        return json({ ok: true });
      }
      if (request.url === '/api/v1/logout' && request.method === 'POST') {
        if (interactive) {
          simulatorSessions.delete(requestToken(request));
          response.setHeader(
            'Set-Cookie',
            'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
          );
        } else session = '';
        return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      json({ error: error.message }, error.status || 500);
    }
  });
  server.once('close', () => {
    if (rebootTimer) clearTimeout(rebootTimer);
    controllers.close();
  });
  return {
    server,
    config,
    firmware,
    setFaults(value) {
      Object.assign(faults, value);
    },
    setChipTemperature(value) {
      chipTemperatureC = value;
    },
    hardware,
    controllers,
    sockets,
    lights,
    meteo,
    thermostats,
    security,
    setHardwareFaults(value) {
      hardware.setFaults(value);
    },
    setHardwareInputs(value) {
      hardware.setInputs(value);
    },
    setSocketsFaults(value) {
      sockets.setFaults(value);
    },
    setLightsFaults(value) {
      lights.setFaults(value);
    },
    setMeteoFault(portId, error) {
      controllers.setMeteoFault(portId, error);
    },
    setMeteoTemperature(id, temperatureC, options) {
      controllers.setMeteoTemperature(id, temperatureC, options);
    },
    get activeBoardId() {
      return activeBoardId;
    },
    get lastConfigPatch() {
      return lastConfigPatch;
    },
    get lastConfigResponse() {
      return lastConfigResponse;
    },
    get configRequests() {
      return configRequests;
    },
    get rebootRequests() {
      return rebootRequests;
    },
    get rebootCount() {
      return rebootCount;
    },
    get timeRequests() {
      return timeRequests;
    },
    get backupRequests() {
      return backupRequests;
    },
    get restoreRequests() {
      return restoreRequests;
    },
    get restorePending() {
      return restorePending;
    },
  };
}

async function openNetwork(page, view) {
  await page.locator('#tab-network').click();
  const back = page.locator('[data-network-back]:visible');
  if (await back.count()) await back.first().click();
  await page.locator(`#network-open-${view}`).click();
  await page.locator(`#panel-${view}`).waitFor({ state: 'visible' });
}

/** @brief Exercise delayed replies at bootstrap, draft editing, and session boundaries. */
async function checkAsyncLifecycle(browser) {
  const mock = createMock();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext();
  const page = await context.newPage();
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const bootstrapSeen = deferred(),
    bootstrapRelease = deferred();
  const releases = [bootstrapRelease];
  let holdBootstrap = true,
    heldSave = null;
  const settled = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  try {
    await page.route('**/api/v1/config', async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && holdBootstrap) {
        holdBootstrap = false;
        const response = await route.fetch();
        bootstrapSeen.resolve();
        await bootstrapRelease.promise;
        return route.fulfill({ response });
      }
      if (request.method() === 'POST' && heldSave) {
        const hold = heldSave;
        heldSave = null;
        const response = await route.fetch();
        hold.seen.resolve();
        await hold.release.promise;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${mock.server.address().port}`);
    await bootstrapSeen.promise;
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    const bootstrapResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/v1/config') && response.status() === 401,
    );
    bootstrapRelease.resolve();
    await bootstrapResponse;
    await settled();
    assert.equal(
      await page.locator('#app-view').isVisible(),
      true,
      'Obsolete bootstrap 401 cannot end the successful login',
    );
    const invalidPatch = JSON.parse(
      `{"baseRevision":${mock.config.revision},"wifi":{"__proto__":{"fcplcnTestPollution":true}}}`,
    );
    assert.equal(
      (
        await page.request.post(`http://127.0.0.1:${mock.server.address().port}/api/v1/config`, {
          data: invalidPatch,
        })
      ).status(),
      400,
    );
    assert.equal(
      Object.hasOwn(Object.prototype, 'fcplcnTestPollution'),
      false,
      'Unknown patch keys cannot mutate shared prototypes',
    );
    const apiUrl = `http://127.0.0.1:${mock.server.address().port}/api/v1`;
    assert.equal(
      (await page.request.get(`${apiUrl}/logout`)).status(),
      404,
      'Read requests cannot end a session',
    );
    assert.equal((await page.request.get(`${apiUrl}/config`)).status(), 200);
    assert.equal(
      (
        await page.request.post(`${apiUrl}/user`, { data: { currentPassword: '', username: '' } })
      ).status(),
      400,
    );
    const cookie = (await context.cookies()).find((entry) => entry.name === 'session');
    assert.equal(
      (
        await page.request.get(`${apiUrl}/config`, {
          headers: { Cookie: `session=${cookie.value}-suffix` },
        })
      ).status(),
      401,
      'Cookie tokens must match exactly',
    );

    await page.locator('#tab-hub').click();
    await page.locator('#linux-host').fill('saved-hub.local');
    const editSave = { seen: deferred(), release: deferred() };
    releases.push(editSave.release);
    heldSave = editSave;
    await page.locator('#hub-form button[type=submit]').click();
    await editSave.seen.promise;
    await page.locator('#linux-host').fill('newer-draft.local');
    const firstResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
    editSave.release.resolve();
    await firstResponse;
    await settled();
    assert.equal(mock.config.linux.host, 'saved-hub.local');
    assert.equal(
      await page.locator('#linux-host').inputValue(),
      'newer-draft.local',
      'Edits made during save remain a draft',
    );
    assert.match(await page.locator('[data-save-state="hub"]').textContent(), /несохранённые/);
    const secondResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
    await page.locator('#hub-form button[type=submit]').click();
    assert.equal((await secondResponse).status(), 200);
    await page.waitForFunction(
      () => document.querySelector('[data-save-state="hub"]').textContent === '',
    );
    assert.equal(
      mock.config.linux.host,
      'newer-draft.local',
      'The retained draft can save with the updated revision',
    );

    await page.locator('#linux-host').fill('previous-session.local');
    const oldSave = { seen: deferred(), release: deferred() };
    releases.push(oldSave.release);
    heldSave = oldSave;
    await page.locator('#hub-form button[type=submit]').click();
    await oldSave.seen.promise;
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#logout').click();
    await page.locator('#login-view').waitFor({ state: 'visible' });
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-hub').click();
    await page.locator('#linux-host').fill('current-session-draft.local');
    const oldResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
    oldSave.release.resolve();
    await oldResponse;
    await settled();
    assert.equal(
      await page.locator('#linux-host').inputValue(),
      'current-session-draft.local',
      'A previous-session save cannot overwrite the new session',
    );
    assert.match(await page.locator('[data-save-state="hub"]').textContent(), /несохранённые/);
    console.log(
      'FCPLCn asynchronous UI checks passed: obsolete bootstrap, edits during save, previous-session reply.',
    );
  } finally {
    for (const release of releases) release.resolve();
    await context.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}

async function checkBoardSelection(browser) {
  // This extra profile exists only in this test invocation. Both supported
  // physical boards remain in the default registry; the UI must use the API list.
  const testProfile = {
    ...defaultProfiles[0],
    boardId: 'test-only-board-profile',
    boardName: 'Test-only board profile',
    legacyIds: [],
  };
  const mock = createMock({ interactive: true, profiles: [...defaultProfiles, testProfile] });
  mock.setFaults({ registry: 'Registry temporarily unavailable' });
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const configResponse = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
  const rebootResponse = () =>
    page.waitForResponse((response) => response.url().endsWith('/api/v1/reboot'));
  try {
    await page.goto(`http://127.0.0.1:${mock.server.address().port}`);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-system').click();
    await page.locator('#hardware-profiles-error').waitFor({ state: 'visible' });
    assert.match(
      await page.locator('#hardware-profiles-error').textContent(),
      /Registry temporarily unavailable/,
    );
    assert.equal(await page.locator('#hardware-board-id').isDisabled(), true);
    assert.equal(await page.locator('#hardware-save').isDisabled(), true);
    assert.equal(
      mock.configRequests,
      0,
      'No empty profile may be submitted when registry loading fails',
    );
    assert.equal(mock.activeBoardId, defaultProfiles[0].boardId);

    mock.setFaults({ registry: '' });
    await page.locator('#hardware-reload').click();
    await page.waitForFunction(() => !document.getElementById('hardware-board-id').disabled);
    assert.equal(await page.locator('#hardware-board-id option').count(), 3);
    assert.equal(await page.locator('#hardware-board-id').inputValue(), defaultProfiles[0].boardId);

    const unknown = await page.request.post(
      `http://127.0.0.1:${mock.server.address().port}/api/v1/config`,
      {
        data: { baseRevision: mock.config.revision, hardware: { boardId: 'not-in-registry' } },
      },
    );
    assert.equal(unknown.status(), 400);
    assert.equal(mock.config.revision, 1);
    await page.locator('#hardware-board-id').selectOption(testProfile.boardId);
    await page.locator('#tab-hub').click();
    await page.locator('#linux-host').fill('gateway-before-reboot.local');
    await page.waitForTimeout(5200);
    assert.equal(
      await page.locator('#hardware-board-id').inputValue(),
      testProfile.boardId,
      'Polling preserves dirty hardware selection',
    );
    const savedHub = configResponse();
    await page.locator('#hub-form button[type=submit]').click();
    assert.equal((await savedHub).status(), 200);
    await page
      .locator('#notice')
      .getByText(/Настройки хаба сохранены/)
      .waitFor();
    assert.equal(mock.config.linux.host, 'gateway-before-reboot.local');
    assert.equal(
      await page.locator('#hardware-board-id').inputValue(),
      testProfile.boardId,
      'Saving another form preserves hardware selection',
    );
    assert.match(
      await page.locator('[data-save-state="hardware"]').textContent(),
      /Есть несохранённые изменения/,
    );

    await page.locator('#linux-host').fill('unsaved-gateway.local');
    await page.locator('#tab-system').click();
    const requestsBeforeCancel = mock.configRequests;
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('#hardware-save').click();
    assert.equal(
      mock.configRequests,
      requestsBeforeCancel,
      'Cancel discarding other edits before any config request',
    );
    assert.equal(mock.rebootRequests, 0);
    assert.equal(await page.locator('#linux-host').inputValue(), 'unsaved-gateway.local');
    assert.equal(await page.locator('#hardware-board-id').inputValue(), testProfile.boardId);

    mock.setFaults({ config: 'Test flash save failure' });
    page.once('dialog', (dialog) => dialog.accept());
    const failedSave = configResponse();
    await page.locator('#hardware-save').click();
    assert.equal((await failedSave).status(), 500);
    await page.locator('#notice').getByText('Test flash save failure', { exact: true }).waitFor();
    assert.equal(mock.config.hardware.boardId, defaultProfiles[0].boardId);
    assert.equal(mock.rebootRequests, 0, 'Failed config save must not reboot');
    assert.equal(await page.locator('#hardware-board-id').inputValue(), testProfile.boardId);
    assert.equal(
      await page.locator('#linux-host').inputValue(),
      'unsaved-gateway.local',
      'Failed hardware save preserves another form',
    );

    mock.setFaults({ config: '' });
    mock.config.revision++;
    page.once('dialog', (dialog) => dialog.accept());
    const staleSave = configResponse();
    await page.locator('#hardware-save').click();
    assert.equal((await staleSave).status(), 409);
    await page
      .locator('#notice')
      .getByText(/Конфигурация изменена/)
      .waitFor();
    assert.equal(mock.rebootRequests, 0, 'Stale revision must not reboot');
    assert.equal(await page.locator('#hardware-board-id').inputValue(), testProfile.boardId);
    assert.equal(await page.locator('#linux-host').inputValue(), 'unsaved-gateway.local');

    // The user explicitly reloads after the conflict, then selects the profile.
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#reload-config').click();
    await page
      .locator('#notice')
      .getByText('Сохранённые настройки загружены.', { exact: true })
      .waitFor();
    await page.locator('#hardware-board-id').selectOption(testProfile.boardId);
    mock.setFaults({ reboot: 'Test reboot scheduling failure' });
    const hardwareSave = configResponse();
    const rejectedReboot = rebootResponse();
    await page.locator('#hardware-save').click();
    assert.equal((await hardwareSave).status(), 200);
    assert.equal((await rejectedReboot).status(), 500);
    await page.locator('#hardware-reboot-notice').waitFor({ state: 'visible' });
    assert.match(
      await page.locator('#hardware-reboot-notice').textContent(),
      /test-only-board-profile/,
    );
    assert.equal(mock.lastConfigResponse.rebootRequired, true);
    assert.equal(mock.lastConfigResponse.networkRestart, false);
    assert.equal(mock.config.hardware.boardId, testProfile.boardId);
    assert.equal(
      mock.activeBoardId,
      defaultProfiles[0].boardId,
      'Saved profile is not active before reboot',
    );
    assert.equal(await page.locator('#status-board-id').textContent(), defaultProfiles[0].boardId);
    assert.equal(
      await page.locator('#status-board-name').textContent(),
      defaultProfiles[0].boardName,
    );

    mock.setFaults({ reboot: '' });
    const revisionBeforeReboot = mock.config.revision;
    const noOpSave = configResponse();
    const acceptedReboot = rebootResponse();
    await page.locator('#hardware-save').click();
    assert.equal((await noOpSave).status(), 200);
    assert.equal((await acceptedReboot).status(), 200);
    assert.equal(
      mock.config.revision,
      revisionBeforeReboot,
      'Saving the same profile does not increment revision',
    );
    assert.equal(mock.rebootCount, 1);
    await page.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(
      mock.activeBoardId,
      testProfile.boardId,
      'Virtual reboot activates the saved profile',
    );
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-system').click();
    await page.waitForFunction(
      (id) => document.getElementById('hardware-board-id').value === id,
      testProfile.boardId,
    );
    assert.equal(await page.locator('#status-board-id').textContent(), testProfile.boardId);
    assert.equal(await page.locator('#status-board-name').textContent(), testProfile.boardName);
    assert.equal(await page.locator('#hardware-reboot-notice').isVisible(), false);
    const foreignActiveBackup = await (
      await page.request.get(`http://127.0.0.1:${mock.server.address().port}/api/v1/config/backup`)
    ).json();
    foreignActiveBackup.boardId = legacyBoardId;
    foreignActiveBackup.config.hardware.boardId = legacyBoardId;
    const foreignRestore = await page.request.post(
      `http://127.0.0.1:${mock.server.address().port}/api/v1/config/restore`,
      {
        data: { baseRevision: mock.config.revision, document: foreignActiveBackup },
      },
    );
    assert.equal(
      foreignRestore.status(),
      409,
      'The current board alias cannot resolve to a different registered active profile',
    );
    assert.equal(mock.activeBoardId, testProfile.boardId);
    assert.equal(mock.restorePending, false);
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn hardware selection checks passed: registry failure/retry, two physical boards and an extra test-only profile, unknown ID, dirty forms/polling, cancelled discard, save failure, stale CAS, pending active/configured status, failed reboot and virtual activation.',
    );
  } finally {
    await context.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}

async function checkHardware(browser) {
  const mock = createMock({ interactive: true });
  // Fixed raw signals make assertions independent of demo animation/time.
  mock.setHardwareInputs(Array.from({ length: 16 }, (_, i) => i % 2 === 0));
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${mock.server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const card = (id) => page.locator(`[data-channel-id="${id}"]`);
  const relay = (id) => page.locator(`[data-relay-id="${id}"]`);
  const badge = (id) => card(id).locator('.channel-state');
  const waitText = async (locator, expected) => {
    await locator.getByText(expected, { exact: true }).waitFor();
  };
  try {
    assert.equal((await context.request.get(`${url}/api/v1/hardware`)).status(), 401);
    await page.goto(url);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-hardware').click();
    await relay('rly-0/1').waitFor();
    await waitText(badge('rly-0/1'), 'Выключено');
    assert.equal(await relay('rly-0/1').getAttribute('aria-pressed'), 'false');
    assert.match(await relay('rly-0/1').getAttribute('aria-label'), /Включить.*rly-0\/1/);
    assert.equal(await page.locator('#hardware-relays [data-channel-id]').count(), 16);
    assert.equal(await page.locator('#hardware-inputs [data-channel-id]').count(), 16);
    assert.equal(await page.locator('#hardware-sensors strong').count(), 8);
    await waitText(badge('in-0/1'), 'HIGH');
    await waitText(badge('in-0/2'), 'LOW');
    assert.match(await page.locator('#hardware-pin-map').textContent(), /rs485-dir/);
    assert.match(await page.locator('#hardware-pin-map').textContent(), /sens-0\/8/);
    assert.match(await page.locator('#hardware-rtc-binding').textContent(), /io-expanders.*0x68/);
    await waitText(page.locator('#hardware-rtc-status'), 'Время установлено');
    await waitText(page.locator('#hardware-fram-status'), 'Исправна');
    assert.equal(await page.locator('#hardware-fram-title').textContent(), 'Память FRAM');
    assert.equal(await page.locator('#hardware-fram-model').textContent(), 'FM24CL64B-GTR');
    assert.match(await page.locator('#hardware-fram-binding').textContent(), /io-expanders.*0x50/);
    assert.match(await page.locator('#hardware-fram-used').textContent(), /512\s*Б.*8\s*КиБ.*6,25/);
    assert.match(await page.locator('#hardware-fram-free').textContent(), /7,5\s*КиБ/);
    assert.match(await page.locator('#hardware-fram-payload').textContent(), /^\d+\s*Б$/);
    assert.deepEqual(
      await page
        .locator('#hardware-fram-progress')
        .evaluate((element) => ({ value: element.value, max: element.max })),
      { value: 512, max: 8192 },
    );
    assert.equal(await page.locator('#hardware-fram-progress').isVisible(), true);

    mock.setHardwareFaults({ relayDelayMs: 250 });
    const write = page.waitForResponse((response) => response.url().endsWith('/hardware/relay'));
    await relay('rly-0/1').click();
    assert.equal(
      await badge('rly-0/1').textContent(),
      'Выключено',
      'No optimistic ON before hardware confirmation',
    );
    assert.equal(
      await relay('rly-0/1').getAttribute('aria-pressed'),
      'false',
      'Pending switch retains the last confirmed state',
    );
    assert.equal(await relay('rly-0/1').getAttribute('aria-busy'), 'true');
    assert.equal(await relay('rly-0/1').isDisabled(), true);
    assert.equal((await write).status(), 200);
    await waitText(badge('rly-0/1'), 'Включено');
    assert.equal(await relay('rly-0/1').getAttribute('aria-pressed'), 'true');
    assert.notEqual(await relay('rly-0/1').getAttribute('aria-busy'), 'true');
    assert.match(await relay('rly-0/1').getAttribute('aria-label'), /Выключить.*rly-0\/1/);
    assert.equal(mock.hardware.snapshot().relays[0].value, true);

    const writesBeforeKeyboard = mock.hardware.relayRequests;
    const keyboardWrite = page.waitForResponse((response) =>
      response.url().endsWith('/hardware/relay'),
    );
    await relay('rly-0/4').focus();
    await relay('rly-0/4').press('Space');
    assert.equal((await keyboardWrite).status(), 200);
    await waitText(badge('rly-0/4'), 'Включено');
    assert.equal(
      mock.hardware.relayRequests,
      writesBeforeKeyboard + 1,
      'One Space key activates the native button once',
    );
    assert.equal(await relay('rly-0/4').getAttribute('aria-pressed'), 'true');

    mock.setHardwareFaults({
      relayWrite: 'Test MCP write failure',
      relayDelayMs: 0,
      getDelayMs: 500,
    });
    const rejected = page.waitForResponse((response) => response.url().endsWith('/hardware/relay'));
    await relay('rly-0/2').click();
    assert.equal((await rejected).status(), 503);
    assert.notEqual(
      await relay('rly-0/2').getAttribute('aria-pressed'),
      'true',
      'Failed write cannot confirm ON',
    );
    await card('rly-0/2')
      .locator('.field-error')
      .getByText(/Test MCP write failure/)
      .waitFor();
    assert.equal(
      await relay('rly-0/2').getAttribute('aria-pressed'),
      'mixed',
      'Failed command remains unknown until a fresh readback',
    );
    assert.equal(await relay('rly-0/2').getAttribute('data-state'), 'unknown');
    assert.equal(await relay('rly-0/2').isDisabled(), true);
    mock.setHardwareFaults({ getDelayMs: 0 });
    await waitText(badge('rly-0/2'), 'Выключено');
    assert.equal(await relay('rly-0/2').getAttribute('aria-pressed'), 'false');
    assert.equal(mock.hardware.snapshot().relays[1].value, false);
    assert.match(
      await card('rly-0/2').locator('.field-error').textContent(),
      /Команда не подтверждена/,
    );
    mock.setHardwareFaults({ relayWrite: '', poll: 'Test I2C API unavailable' });
    await page
      .locator('#hardware-error')
      .getByText(/Test I2C API unavailable/)
      .waitFor();
    await waitText(badge('rly-0/1'), 'Нет данных');
    assert.equal(
      await relay('rly-0/1').getAttribute('aria-pressed'),
      'mixed',
      'Unknown hardware state is distinct from confirmed OFF',
    );
    assert.equal(await relay('rly-0/1').isDisabled(), true);
    await waitText(badge('in-0/1'), 'Нет данных');
    await waitText(page.locator('#hardware-fram-status'), 'Нет данных');
    assert.equal(await page.locator('#hardware-fram-progress').isVisible(), false);
    assert.equal(await page.locator('#hardware-fram-used').textContent(), 'Нет данных');
    mock.setHardwareFaults({ poll: '', rtc: 'RTC oscillator stopped' });
    await waitText(badge('rly-0/1'), 'Включено');
    await waitText(page.locator('#hardware-rtc-status'), 'Время недостоверно');
    assert.equal(await page.locator('#hardware-rtc-time').textContent(), 'Нет данных');
    mock.setHardwareFaults({ rtc: '' });
    await waitText(page.locator('#hardware-rtc-status'), 'Время установлено');

    mock.setHardwareFaults({ fram: 'missing' });
    await waitText(page.locator('#hardware-fram-status'), 'Нет связи');
    assert.equal(await page.locator('#hardware-fram-progress').isVisible(), false);
    assert.equal(await page.locator('#hardware-fram-payload').textContent(), '—');
    assert.equal(await page.locator('#hardware-fram-error').isVisible(), true);
    mock.setHardwareFaults({ fram: 'corrupt' });
    await waitText(page.locator('#hardware-fram-status'), 'Ошибка данных');
    assert.equal(await page.locator('#hardware-fram-payload').textContent(), '—');
    mock.setHardwareFaults({ fram: '' });
    await waitText(page.locator('#hardware-fram-status'), 'Исправна');
    assert.equal(await page.locator('#hardware-fram-error').isVisible(), false);

    const hardwareRoute = '**/api/v1/hardware';
    await page.route(hardwareRoute, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.stateStorage.usedBytes = body.stateStorage.capacityBytes + 1;
      await route.fulfill({ response, json: body });
    });
    await waitText(page.locator('#hardware-fram-used'), 'Нет данных');
    assert.equal(
      await page.locator('#hardware-fram-progress').isVisible(),
      false,
      'Invalid byte bounds cannot create a misleading usage bar',
    );
    await page.unroute(hardwareRoute);
    await page.route(hardwareRoute, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.stateStorage;
      await route.fulfill({ response, json: body });
    });
    await waitText(page.locator('#hardware-fram-status'), 'Нет данных');
    assert.equal(await page.locator('#hardware-fram-progress').isVisible(), false);
    await page.unroute(hardwareRoute);
    await waitText(page.locator('#hardware-fram-status'), 'Исправна');

    await page.locator('#hardware-scan').click();
    await page
      .locator('[data-bus-id="io-expanders"] .address-chip')
      .getByText('0x68', { exact: true })
      .waitFor();
    await page
      .locator('[data-bus-id="io-expanders"] .address-chip')
      .getByText('0x50', { exact: true })
      .waitFor();
    await page
      .locator('[data-bus-id="isolated-sensors"] .address-chip')
      .getByText('0x44', { exact: true })
      .waitFor();
    assert.equal(mock.hardware.scanRequests, 1);
    assert.match(await page.locator('.simulator-banner').textContent(), /демонстрационные/);

    // A delayed GET captures OFF; clicking during it must wait for that GET and
    // then publish explicit ON, with no stale read overwriting the confirmation.
    mock.setHardwareFaults({ getDelayMs: 300 });
    await page.waitForRequest(
      (request) => request.url().endsWith('/api/v1/hardware') && request.method() === 'GET',
    );
    await relay('rly-0/3').click();
    await waitText(badge('rly-0/3'), 'Включено');
    mock.setHardwareFaults({ getDelayMs: 0 });
    assert.equal(
      mock.hardware.maxActiveRequests,
      1,
      'Hardware polling and relay POST are serialized',
    );
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'hardware-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'hardware-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      'Hardware mobile horizontal overflow',
    );
    await page.locator('#hardware-fram-title').scrollIntoViewIfNeeded();
    await page.locator('.fram-card').screenshot({ path: path.join(artifacts, 'fram-mobile.png') });
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      'FRAM card fits a narrow mobile viewport',
    );
    await page.locator('.fram-card').screenshot({ path: path.join(artifacts, 'fram-narrow.png') });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.locator('.fram-card').screenshot({ path: path.join(artifacts, 'fram-desktop.png') });

    await page.locator('#tab-system').click();
    await page.waitForTimeout(400); // Allow the one in-flight read to complete.
    const reads = mock.hardware.getRequests;
    await page.waitForTimeout(1250);
    assert.equal(mock.hardware.getRequests, reads, 'Hardware polling stops outside its tab');
    const badRelay = await context.request.post(`${url}/api/v1/hardware/relay`, {
      data: { id: 'unknown', value: true },
    });
    assert.equal(badRelay.status(), 404);
    assert.equal(
      (
        await context.request.post(`${url}/api/v1/hardware/relay`, {
          data: { id: 'rly-0/1', value: 'false' },
        })
      ).status(),
      400,
    );
    // Repeated explicit desired values remain ON; reboot alone resets outputs.
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await context.request.post(`${url}/api/v1/hardware/relay`, {
            data: { id: 'rly-0/1', value: true },
          })
        ).status(),
        200,
      );
    assert.equal(mock.hardware.snapshot().relays[0].value, true);
    const revision = mock.config.revision;
    assert.equal((await context.request.post(`${url}/api/v1/reboot`, { data: {} })).status(), 200);
    await page.waitForTimeout(1150);
    assert.equal((await context.request.get(`${url}/api/v1/hardware`)).status(), 401);
    assert.equal(mock.config.revision, revision);
    assert.equal(
      mock.hardware.snapshot().relays.every((channel) => channel.value === false),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn hardware browser checks passed: 16 relays/inputs, raw HIGH/LOW, 8 sensor pins, confirmed writes/errors, polling serialization, RTC validity, FRAM health/allocation/payload/fault recovery/stale and malformed data, both I2C scans, reboot OFF, desktop/mobile/narrow layout.',
    );
  } finally {
    await context.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}

async function run() {
  await require('./thermostat_policy_checks.cjs').checkThermostatPolicy({ createMock });
  console.log(
    'FCPLCn thermostat policy checks passed: startup/minimum ON/OFF, immediate safety OFF and bounded cached samples.',
  );
  await require('./static_assets_checks.cjs').checkStaticAssets({ createMock });
  console.log(
    'FCPLCn static assets checks passed: ES modules, deterministic gzip, ETags, coding exclusions and version-bound cache.',
  );
  const playwrightPackage =
    process.env.FCPLCN_PLAYWRIGHT_PACKAGE ||
    path.join(repository, 'tools/firmware/web-smoke/node_modules/@playwright/test');
  let chromium;
  try {
    ({ chromium } = require(playwrightPackage));
  } catch (_) {
    throw new Error(
      `Existing Playwright dependency not found at ${playwrightPackage}. Restore tools/firmware/web-smoke dependencies first.`,
    );
  }
  const mock = createMock();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${mock.server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    if (process.env.FCPLCN_UI_SESSIONS_ONLY === '1') {
      await require('./simulator_sessions_checks.cjs').checkSimulatorSessions({
        browser,
        createMock,
      });
      return;
    }
    if (process.env.FCPLCN_UI_IRRIGATION_ONLY === '1') {
      await require('./irrigation_checks.cjs').checkIrrigation({ browser, createMock });
      return;
    }
    if (process.env.FCPLCN_UI_TANKS_ONLY === '1') {
      await require('./tanks_checks.cjs').checkTanks({ browser, createMock, artifacts });
      return;
    }
    if (process.env.FCPLCN_UI_SECURITY_ONLY === '1') {
      await require('./security_checks.cjs').checkSecurity({ browser, createMock, artifacts });
      return;
    }
    if (process.env.FCPLCN_UI_NOTICES_ONLY === '1') {
      await require('./controller_notices_checks.cjs').checkControllerNotices({
        browser,
        createMock,
        artifacts,
      });
      return;
    }
    if (process.env.FCPLCN_UI_BOARDS_ONLY === '1') {
      await checkBoardSelection(browser);
      await require('./state_memory_checks.cjs').checkStateMemory({
        browser,
        createMock,
        artifacts,
      });
      return;
    }
    if (process.env.FCPLCN_UI_HARDWARE_ONLY === '1') {
      await checkHardware(browser);
      await require('./state_memory_checks.cjs').checkStateMemory({
        browser,
        createMock,
        artifacts,
      });
      return;
    }
    if (process.env.FCPLCN_UI_SOCKETS_ONLY === '1') {
      await require('./sockets_checks.cjs').checkSockets({ browser, createMock, artifacts });
      return;
    }
    if (process.env.FCPLCN_UI_CONTROLLERS_ONLY === '1') {
      await require('./controllers_checks.cjs').checkControllers({
        browser,
        createMock,
        artifacts,
      });
      return;
    }
    if (process.env.FCPLCN_UI_METEO_ONLY === '1') {
      await require('./meteo_checks.cjs').checkMeteo({ browser, createMock, artifacts });
      return;
    }
    if (process.env.FCPLCN_UI_THERMOSTATS_ONLY === '1') {
      await require('./thermostats_checks.cjs').checkThermostats({
        browser,
        createMock,
        artifacts,
      });
      return;
    }
    if (process.env.FCPLCN_UI_BACKUP_ONLY === '1') {
      await require('./backup_checks.cjs').checkBackup({ browser, createMock, artifacts });
      return;
    }
    await require('./simulator_sessions_checks.cjs').checkSimulatorSessions({
      browser,
      createMock,
    });
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#login-username').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#login-username').inputValue(), 'admin');
    assert.equal(await page.title(), `${product.name} — ${product.fullName}`);

    await page.locator('#login-password').fill('wrong');
    await page.locator('#login-form button').click();
    await page.locator('#login-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#login-error').textContent(), /Неверный/);
    await page.locator('#login-password').fill('');
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.getByText('На связи', { exact: true }).waitFor();
    assert.deepEqual(
      await page
        .locator('[role="tablist"] [role="tab"]')
        .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tab)),
      ['network', 'hub', 'hardware', 'controllers', 'system', 'users'],
    );
    assert.equal(
      await page.locator('#tab-wifi, #tab-ethernet').count(),
      0,
      'WiFi/Ethernet are nested network views',
    );
    assert.equal(
      await page.locator('#network-list-view').isVisible(),
      true,
      'Network landing is the default view',
    );
    await page.locator('#tab-network').focus();
    await page.locator('#tab-network').press('ArrowRight');
    assert.equal(await page.locator('#tab-hub').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#panel-hub').isVisible(), true);
    await page.locator('#tab-hub').press('End');
    assert.equal(await page.locator('#tab-users').getAttribute('aria-selected'), 'true');
    await page.locator('#tab-users').press('Home');
    assert.equal(await page.locator('#tab-network').getAttribute('aria-selected'), 'true');
    for (const id of ['wifi-enabled', 'ap-enabled', 'ethernet-enabled', 'ethernet-dhcp']) {
      assert.equal(await page.locator(`#${id}`).isChecked(), true, id);
    }
    assert.equal(await page.locator('#ap-channel').getAttribute('max'), '11');
    assert.equal(await page.locator('#sta-enabled').isChecked(), false);

    await openNetwork(page, 'wifi');
    await page.locator('#ap-ssid').fill('FCPLCn Office');
    await page.locator('#sta-enabled').check();
    await page.locator('#sta-ssid').fill('Router');
    await page.locator('#network-back-wifi').click();
    assert.equal(await page.locator('#network-list-view').isVisible(), true);
    assert.equal(await page.locator('#tab-network [data-dirty="network"]').isVisible(), true);
    assert.equal(await page.locator('[data-dirty="wifi"]').isVisible(), true);
    assert.equal(await page.locator('[data-dirty="ethernet"]').isVisible(), false);
    await page.locator('#network-open-ethernet').click();
    await page.locator('#ethernet-dhcp').uncheck();
    await page.locator('#ethernet-ip').fill('192.168.1.80');
    await page.locator('#network-back-ethernet').click();
    assert.equal(await page.locator('[data-dirty="ethernet"]').isVisible(), true);
    await page.locator('#tab-system').click();
    assert.equal(await page.locator('#status-board-id').textContent(), canonicalBoardId);
    assert.equal(await page.locator('#status-board-name').textContent(), 'FCPLCN-161608-1v0');
    await page.waitForFunction(() => !document.getElementById('hardware-board-id').disabled);
    assert.equal(
      await page.locator('#hardware-board-id option').count(),
      2,
      'Default registry exposes both supported physical boards',
    );
    assert.equal(await page.locator('#hardware-board-id').inputValue(), canonicalBoardId);
    assert.equal(await page.locator('#status-chip-temperature').textContent(), '43.5 °C');
    await page.locator('#time-timezone').fill('UTC-3');
    await page.locator('#time-ntp-server').fill('ntp.example.test');
    await page.locator('#tab-hub').click();
    await page.locator('#linux-host').fill('192.168.1.10');
    await page.waitForTimeout(5200);
    assert.equal(await page.locator('#ap-ssid').inputValue(), 'FCPLCn Office');
    assert.equal(await page.locator('#ethernet-ip').inputValue(), '192.168.1.80');
    assert.equal(await page.locator('#time-timezone').inputValue(), 'UTC-3');
    assert.equal(
      await page.locator('#linux-host').inputValue(),
      '192.168.1.10',
      'Polling preserves all four independent drafts',
    );
    for (const tab of ['network', 'hub', 'system'])
      assert.equal(await page.locator(`#tab-${tab} [data-dirty="${tab}"]`).isVisible(), true);
    await openNetwork(page, 'wifi');
    await page.locator('#wifi-form button[type=submit]').click();
    await page.getByText(/Сетевые интерфейсы перезапускаются/).waitFor();
    assert.equal(mock.config.wifi.ap.ssid, 'FCPLCn Office');
    assert.equal(mock.lastConfigPatch.baseRevision, 1);
    assert.deepEqual(Object.keys(mock.lastConfigPatch).sort(), ['baseRevision', 'wifi']);
    assert.equal(mock.config.ethernet.dhcp, true, 'WiFi save leaves Ethernet draft unapplied');
    assert.equal(
      await page.locator('#tab-network [data-dirty="network"]').isVisible(),
      true,
      'Ethernet draft keeps the parent Network dirty',
    );

    await page.locator('#tab-hub').click();
    assert.equal(await page.locator('#linux-host').inputValue(), '192.168.1.10');
    const linuxSave = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
    await page.locator('#hub-form button[type=submit]').click();
    assert.equal((await linuxSave).status(), 200);
    await page
      .locator('#notice')
      .getByText(/Настройки хаба сохранены/)
      .waitFor();
    assert.equal(mock.config.linux.host, '192.168.1.10');
    assert.equal(mock.lastConfigPatch.baseRevision, 2);
    assert.deepEqual(
      Object.keys(mock.lastConfigPatch).sort(),
      ['baseRevision', 'linux'],
      'Hub sends only Linux settings',
    );
    assert.equal(
      mock.config.time.timezone,
      'UTC-7',
      'Hub save does not apply an unsaved time zone',
    );
    assert.equal(mock.config.time.ntpServer, 'pool.ntp.org');
    await page.locator('#linux-host').fill('pending-hub.local');
    await page.locator('#linux-password').fill('pending-hub-password');
    await page.locator('#tab-system').click();
    assert.equal(await page.locator('#time-timezone').inputValue(), 'UTC-3');
    const timeSave = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
    await page.locator('#system-form button[type=submit]').click();
    assert.equal((await timeSave).status(), 200);
    assert.deepEqual(
      Object.keys(mock.lastConfigPatch).sort(),
      ['baseRevision', 'device', 'time'],
      'System sends device name and time settings',
    );
    assert.equal(mock.lastConfigResponse.networkRestart, false);
    assert.equal(mock.config.time.timezone, 'UTC-3');
    assert.equal(
      mock.config.linux.host,
      '192.168.1.10',
      'Time save leaves the Hub draft unapplied',
    );
    assert.equal(mock.config.linux.passwordSet, false);
    assert.equal(await page.locator('#linux-host').inputValue(), 'pending-hub.local');
    assert.equal(
      await page.locator('#linux-password').inputValue(),
      'pending-hub-password',
      'Saving time preserves the unsaved Hub secret',
    );
    assert.equal(await page.locator('#tab-system [data-dirty="system"]').isVisible(), false);
    assert.equal(await page.locator('#tab-hub [data-dirty="hub"]').isVisible(), true);
    await page.locator('#status-external-rtc').getByText('Подключён', { exact: true }).waitFor();
    await page.locator('#time-from-browser').click();
    await page.locator('#manual-time-form button[type=submit]').click();
    await page.getByText(/Время контроллера установлено/).waitFor();
    assert.equal(mock.timeRequests, 1);
    // Commit the remaining drafts explicitly before the legacy fault/auth tests.
    await page.locator('#tab-hub').click();
    const pendingHub = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
    await page.locator('#hub-form button[type=submit]').click();
    assert.equal((await pendingHub).status(), 200);
    await openNetwork(page, 'ethernet');
    assert.equal(await page.locator('#ethernet-ip').inputValue(), '192.168.1.80');
    const ethernetSave = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
    await page.locator('#ethernet-form button[type=submit]').click();
    assert.equal((await ethernetSave).status(), 200);
    assert.equal(await page.locator('#tab-network [data-dirty="network"]').isVisible(), false);

    mock.setFaults({
      sta: 'Ошибка авторизации WiFi',
      ethernet: 'Не удалось запустить W5500 <ошибка>',
      linux: 'Ошибка авторизации MQTT',
    });
    mock.setChipTemperature(null);
    await openNetwork(page, 'wifi');
    await page.locator('#status-sta-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#status-sta-error').textContent(), /Ошибка авторизации WiFi/);
    await openNetwork(page, 'ethernet');
    await page.locator('#status-ethernet-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#status-ethernet-error').textContent(), /<ошибка>/);
    assert.equal(await page.locator('#status-ethernet-error *').count(), 0);
    await page.locator('#tab-hub').click();
    await page.locator('#status-linux-error').waitFor({ state: 'visible' });
    assert.match(
      await page.locator('#status-linux-error').textContent(),
      /Ошибка авторизации MQTT/,
    );
    await page.locator('#tab-system').click();
    assert.equal(await page.locator('#status-chip-temperature').textContent(), 'Недоступна');
    mock.setFaults({ sta: '', ethernet: '', linux: '' });
    mock.setChipTemperature(0);
    await page.waitForFunction(() => document.getElementById('status-linux-error').hidden);
    assert.equal(await page.locator('#status-sta-error').getAttribute('hidden'), '');
    assert.equal(await page.locator('#status-ethernet-error').getAttribute('hidden'), '');
    assert.equal(await page.locator('#status-chip-temperature').textContent(), '0.0 °C');
    mock.setChipTemperature(43.5);

    await openNetwork(page, 'ethernet');
    await page.locator('#ethernet-enabled').uncheck();
    await page.locator('#ethernet-form button[type=submit]').click();
    await page.getByText(/Сетевые интерфейсы перезапускаются/).waitFor();
    await openNetwork(page, 'wifi');
    await page.locator('#wifi-enabled').uncheck();
    await page.locator('#wifi-form button[type=submit]').click();
    await page.getByText(/Оставьте включённым хотя бы один/).waitFor();
    assert.equal(mock.config.wifi.enabled, true);
    await page.locator('#wifi-enabled').check();

    await page.locator('#tab-users').click();
    await page.locator('#user-username').fill('operator');
    await page.locator('#user-change-password').check();
    await page.locator('#user-new-password').fill('new-password');
    await page.locator('#user-confirm-password').fill('new-password');
    await page.locator('#user-form button[type=submit]').click();
    await page.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#login-username').inputValue(), 'operator');
    await page.locator('#login-password').fill('new-password');
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });

    // Capture the usable page before the simulated restart notice.
    await openNetwork(page, 'wifi');
    await page.locator('#network-back-wifi').click();
    await page.getByText('На связи', { exact: true }).waitFor();
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'network-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'network-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      'Network mobile horizontal overflow',
    );
    await page.locator('#tab-hub').click();
    await page.screenshot({ path: path.join(artifacts, 'hub-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      'Hub mobile horizontal overflow',
    );
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.screenshot({ path: path.join(artifacts, 'hub-desktop.png'), fullPage: true });
    fs.copyFileSync(
      path.join(artifacts, 'network-desktop.png'),
      path.join(artifacts, 'desktop.png'),
    );
    fs.copyFileSync(path.join(artifacts, 'network-mobile.png'), path.join(artifacts, 'mobile.png'));

    await page.locator('#tab-system').click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#reboot').click();
    await page.getByText(/Команда перезагрузки принята/).waitFor();
    assert.equal(mock.rebootCount, 1);
    const revisionBeforeProfileSave = mock.config.revision;
    const sameProfileSave = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/config') && response.request().method() === 'POST',
    );
    const sameProfileReboot = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/reboot'),
    );
    await page.locator('#hardware-save').click();
    assert.equal((await sameProfileSave).status(), 200);
    assert.equal((await sameProfileReboot).status(), 200);
    assert.equal(mock.config.revision, revisionBeforeProfileSave);
    assert.equal(mock.lastConfigResponse.networkRestart, false);
    assert.equal(
      mock.rebootCount,
      2,
      'Save and reboot remains usable with an already-selected profile',
    );
    assert.equal(await page.locator('#hardware-board-id').inputValue(), canonicalBoardId);
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn UI browser checks passed: six-tab keyboard navigation, nested Network views, independent WiFi/Ethernet/Hub/System drafts, Linux-only/Device+time save isolation, auth, board/temperature, network errors/guard, reboot, Network/Hub desktop/mobile layout, CSP self-only.',
    );
    console.log(`Screenshots: ${artifacts}`);
    await checkAsyncLifecycle(browser);
    await checkBoardSelection(browser);
    await checkHardware(browser);
    await require('./state_memory_checks.cjs').checkStateMemory({ browser, createMock, artifacts });
    await require('./sockets_checks.cjs').checkSockets({ browser, createMock, artifacts });
    await require('./controllers_checks.cjs').checkControllers({ browser, createMock, artifacts });
    await require('./controller_notices_checks.cjs').checkControllerNotices({
      browser,
      createMock,
      artifacts,
    });
    await require('./meteo_checks.cjs').checkMeteo({ browser, createMock, artifacts });
    await require('./thermostats_checks.cjs').checkThermostats({ browser, createMock, artifacts });
    await require('./security_checks.cjs').checkSecurity({ browser, createMock, artifacts });
    await require('./tanks_checks.cjs').checkTanks({ browser, createMock, artifacts });
    await require('./irrigation_checks.cjs').checkIrrigation({ browser, createMock });
    await require('./backup_checks.cjs').checkBackup({ browser, createMock, artifacts });
  } finally {
    if (browser) await browser.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}

module.exports = { createMock, checkAsyncLifecycle, checkHardware };
if (require.main === module)
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
