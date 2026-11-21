/**
 * @file controllers_mock.cjs
 * @brief Model serialized controller operations and durable settings for desktop simulation.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalBoardId } = require('./board_profiles_mock.cjs');
const { createMeteoMock, validRom } = require('./meteo_mock.cjs');
const { createThermostatsMock } = require('./thermostats_mock.cjs');
const { createSecurityMock, emptySecurity, validateSecurity } = require('./security_mock.cjs');
const {
  validLegacyThermostatDurations,
  withoutLegacyThermostatDurations,
} = require('./thermostat_policy.cjs');

// The mock has one durable store and operation queue for both controllers.
/** @brief Own the shared virtual resource catalog, request queue, and durable controller bundle. */
function createControllersMock({
  hardware,
  statePath,
  boardId = canonicalBoardId,
  normalizeId = (id) => id,
}) {
  const actuatorIds = ['sockets', 'lights'],
    ids = [...actuatorIds, 'meteo', 'thermostats', 'security'];
  const ports = {
    relays: Array.from({ length: 16 }, (_, i) => `rly-0/${i + 1}`),
    inputs: Array.from({ length: 16 }, (_, i) => `in-0/${i + 1}`),
    sensors: Array.from({ length: 8 }, (_, i) => `sens-0/${i + 1}`),
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const empty = () => ({ revision: 1, enabled: false, items: [] });
  let settings = {
      sockets: empty(),
      lights: empty(),
      meteo: empty(),
      thermostats: empty(),
      security: emptySecurity(),
    },
    stagedRestore;
  let lockedInputs = new Set();
  const filters = new Map(),
    errors = new Map();
  const inhibitedThermostats = new Set();
  const buttonIds = [...actuatorIds, 'thermostats'];
  const faults = Object.fromEntries(
    ids.map((id) => [
      id,
      { get: '', save: '', state: '', stateDelayMs: 0, enabled: '', enabledDelayMs: 0 },
    ]),
  );
  const counts = Object.fromEntries(
    ids.map((id) => [id, { get: 0, save: 0, state: 0, enabled: 0 }]),
  );
  let queue = Promise.resolve(),
    busy = false;
  const fail = (error, status = 400) => ({ status, data: { error } });
  const key = (moduleId, itemId) => `${moduleId}/${itemId}`;
  /** @brief Serialize mutations while keeping a rejected operation from poisoning the queue. */
  function exclusive(operation) {
    const run = queue.then(async () => {
      busy = true;
      try {
        return await operation();
      } finally {
        busy = false;
      }
    });
    queue = run.catch(() => {});
    return run;
  }
  function validate(module, states = false, kind = 'sockets') {
    if (kind === 'security') return validateSecurity(module, ports, states);
    if (
      !module ||
      typeof module !== 'object' ||
      Array.isArray(module) ||
      typeof module.enabled !== 'boolean' ||
      !Array.isArray(module.items) ||
      module.items.length > 16
    )
      return 'Некорректные настройки контроллера';
    const seen = new Set();
    for (const item of module.items) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,32}$/.test(item.id) ||
        typeof item.name !== 'string' ||
        !item.name.trim() ||
        Buffer.byteLength(item.name) > 64 ||
        /[\x00-\x1f\x7f]/.test(item.name) ||
        (kind === 'thermostats'
          ? !ports.relays.includes(item.relayId) ||
            typeof item.meteoId !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,32}$/.test(item.meteoId) ||
            ((states || item.inputId !== undefined) &&
              (typeof item.inputId !== 'string' ||
                (item.inputId && !ports.inputs.includes(item.inputId)))) ||
            (states ? typeof item.enabled !== 'boolean' : 'enabled' in item) ||
            !['heating', 'cooling'].includes(item.mode) ||
            !Number.isFinite(item.setpointC) ||
            item.setpointC < -55 ||
            item.setpointC > 125 ||
            Math.abs(item.setpointC * 10 - Math.round(item.setpointC * 10)) > 1e-8 ||
            !Number.isInteger(item.hysteresisC) ||
            item.hysteresisC < 1 ||
            item.hysteresisC > 20 ||
            !validLegacyThermostatDurations(item)
          : kind === 'meteo'
            ? !ports.sensors.includes(item.portId) ||
              !['dht22', 'onewire'].includes(item.sensorType) ||
              (item.sensorType === 'dht22' ? item.address !== '' : !validRom(item.address))
            : !ports.relays.includes(item.relayId) ||
              typeof item.inputId !== 'string' ||
              (item.inputId && !ports.inputs.includes(item.inputId)) ||
              (states && (typeof item.state !== 'boolean' || (!module.enabled && item.state))))
      )
        return 'Некорректный элемент или порт контроллера';
      if (seen.has(item.id)) return 'Идентификаторы элементов должны быть уникальны';
      seen.add(item.id);
      if (
        states &&
        Object.keys(item).some(
          (name) =>
            !(
              kind === 'thermostats'
                ? [
                    'id',
                    'name',
                    'meteoId',
                    'relayId',
                    'inputId',
                    'enabled',
                    'mode',
                    'setpointC',
                    'hysteresisC',
                  ]
                : kind === 'meteo'
                  ? ['id', 'name', 'portId', 'sensorType', 'address']
                  : ['id', 'name', 'relayId', 'inputId', 'state']
            ).includes(name),
        )
      )
        return 'Неизвестное поле элемента';
    }
    return '';
  }
  /** @brief Derive saved ownership; only distinct OneWire ROMs may share a sensor bus. */
  function resources(bundle = settings) {
    const all = [
      ...ports.relays.map((id) => ({ id, kind: 'relay' })),
      ...ports.inputs.map((id) => ({ id, kind: 'input' })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: `sens-0/${i + 1}`, kind: 'sensor' })),
    ];
    return all.map((resource) => {
      const owners = [];
      for (const moduleId of ids)
        for (const item of bundle[moduleId].items)
          if (
            item.relayId === resource.id ||
            item.inputId === resource.id ||
            item.portId === resource.id
          )
            owners.push({
              ownerController: moduleId,
              ownerId: item.id,
              ownerName: item.name,
              sensorType: item.sensorType,
              address: item.address?.toLowerCase(),
            });
      if (bundle.security?.sirenRelayId === resource.id)
        owners.push({ ownerController: 'security', ownerId: 'siren', ownerName: 'Сирена' });
      if (bundle.security?.readerPortId === resource.id)
        owners.push({
          ownerController: 'security',
          ownerId: 'reader',
          ownerName: 'Считыватель iButton',
        });
      const sharedBus =
        resource.kind === 'sensor' &&
        owners.every(
          (owner) => owner.ownerController === 'meteo' && owner.sensorType === 'onewire',
        ) &&
        new Set(owners.map((owner) => owner.address)).size === owners.length;
      const owner = owners[0];
      return {
        ...resource,
        ownerController: owner?.ownerController || null,
        ownerId: owner?.ownerId || null,
        ownerName: owner?.ownerName || null,
        conflict: owners.length > 1 && !sharedBus,
      };
    });
  }
  const conflict = (bundle) => resources(bundle).find((resource) => resource.conflict);
  /** @brief Write a private temporary record before atomically replacing the durable bundle. */
  function persist(bundle) {
    if (!statePath) return;
    const target = path.resolve(statePath),
      temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const record = { version: 8, boardId, controllers: bundle };
    if (conflict(bundle)) record.legacyConflicts = true;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  if (statePath && fs.existsSync(statePath)) {
    const record = JSON.parse(fs.readFileSync(statePath, 'utf8')),
      legacy = record.version === 1;
    const savedBoard = legacy ? record.sockets?.boardId : record.boardId;
    if (savedBoard !== undefined && normalizeId(savedBoard) !== boardId)
      throw new Error('Сохранённые контроллеры относятся к другой плате');
    if (legacy) {
      settings.sockets = clone(record.sockets);
      delete settings.sockets.boardId;
    } else if (
      record.version === 2 &&
      record.controllers &&
      Object.keys(record.controllers).sort().join(',') === 'lights,sockets'
    )
      settings = { ...clone(record.controllers), meteo: empty(), thermostats: empty() };
    else if (
      record.version === 3 &&
      record.controllers &&
      Object.keys(record.controllers).sort().join(',') === 'lights,meteo,sockets'
    )
      settings = { ...clone(record.controllers), thermostats: empty() };
    else if (
      [4, 5, 6, 7, 8].includes(record.version) &&
      record.controllers &&
      Object.keys(record.controllers).sort().join(',') ===
        (record.version === 8
          ? 'lights,meteo,security,sockets,thermostats'
          : 'lights,meteo,sockets,thermostats')
    ) {
      settings = clone(record.controllers);
      if (record.version === 4)
        settings.thermostats.items = settings.thermostats.items.map((item) => ({
          ...item,
          inputId: '',
          enabled: true,
        }));
    } else throw new Error('Файл состояния симулятора имеет неверный формат');
    if (record.version === 6) {
      if (settings.thermostats.items.some((item) => !validLegacyThermostatDurations(item, true)))
        throw new Error('Invalid legacy thermostat durations');
      settings.thermostats.items = settings.thermostats.items.map(withoutLegacyThermostatDurations);
    }
    settings.security ||= emptySecurity();
    for (const id of ids)
      if (
        validate(settings[id], true, id) ||
        !Number.isSafeInteger(settings[id].revision) ||
        settings[id].revision < 1
      )
        throw new Error('Файл состояния симулятора имеет неверный формат');
    for (const item of settings.meteo.items) item.address = item.address.toLowerCase();
    const clashes = resources().filter((resource) => resource.conflict);
    if (
      clashes.some((resource) => resource.kind !== 'input') ||
      (clashes.length && !legacy && !record.legacyConflicts)
    )
      throw new Error('Конфликт портов в файле состояния');
  }
  function configureInputs() {
    const next = new Set(
      [
        ...buttonIds.flatMap((id) => settings[id].items.map((item) => item.inputId)),
        ...settings.security.items.map((item) => item.inputId),
      ].filter(Boolean),
    );
    for (const id of lockedInputs)
      if (!next.has(id)) {
        hardware.unlockInput(id);
        filters.delete(id);
      }
    for (const id of next) {
      const fresh = !lockedInputs.has(id);
      hardware.lockInput(id);
      if (fresh) {
        const zone = settings.security.items.find((item) => item.inputId === id);
        if (zone) hardware.setInputLevel(id, zone.sensorType !== 'reed');
      }
    }
    lockedInputs = next;
  }
  function simulatedInputs() {
    const inputs = hardware.snapshot().inputs;
    return [...lockedInputs]
      .filter((id) =>
        buttonIds.some((module) => settings[module].items.some((item) => item.inputId === id)),
      )
      .map((id) => {
        const input = inputs.find((channel) => channel.id === id);
        return { id, level: input?.value ?? null, pressed: input?.value === false };
      });
  }
  function drive() {
    const clashes = new Set(
      resources()
        .filter((resource) => resource.conflict && resource.kind === 'relay')
        .map((resource) => resource.id),
    );
    for (const id of actuatorIds)
      for (const item of settings[id].items) {
        if (clashes.has(item.relayId)) continue;
        const error = hardware.driveRelay(item.relayId, settings[id].enabled && item.state);
        if (error) errors.set(key(id, item.id), error);
        else errors.delete(key(id, item.id));
      }
  }
  function snapshot(id) {
    if (id === 'security') return securityDriver.snapshot();
    if (id === 'thermostats') return thermostatDriver.snapshot();
    if (id === 'meteo')
      return {
        revision: settings.meteo.revision,
        enabled: settings.meteo.enabled,
        ports: { sensors: clone(ports.sensors) },
        items: settings.meteo.items.map((item) => ({
          ...item,
          ...meteoDriver.reading(item, settings.meteo.enabled),
        })),
      };
    const io = hardware.snapshot(),
      claims = resources(),
      module = settings[id];
    const result = {
      revision: module.revision,
      enabled: module.enabled,
      ports: { relays: clone(ports.relays), inputs: clone(ports.inputs) },
      items: module.items.map((item) => {
        const relay = io.relays.find((channel) => channel.id === item.relayId),
          input = item.inputId ? io.inputs.find((channel) => channel.id === item.inputId) : null;
        const relayKnown = relay?.valid === true && typeof relay.value === 'boolean',
          inputKnown = !item.inputId || (input?.valid === true && typeof input.value === 'boolean');
        const clash = claims.find(
          (resource) =>
            resource.conflict && (resource.id === item.relayId || resource.id === item.inputId),
        );
        const relayError =
          errors.get(key(id, item.id)) || (!relayKnown ? relay?.error || 'Реле недоступно' : '');
        return {
          ...item,
          actual: relayKnown ? relay.value : null,
          inputLevel: item.inputId && inputKnown ? input.value : null,
          available: module.enabled && relayKnown && !relayError && !(clash?.kind === 'relay'),
          error:
            relayError ||
            (clash
              ? `Конфликт порта ${clash.id}: кнопочная автоматика приостановлена`
              : !inputKnown
                ? input?.error || 'Вход недоступен'
                : null),
        };
      }),
    };
    if (result.items.some((item) => item.error?.includes('Конфликт')))
      result.error = 'Сохранённые привязки конфликтуют. Исправьте назначения портов.';
    return result;
  }
  const exportSettings = () =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        id === 'security'
          ? clone(
              Object.fromEntries(
                Object.entries(settings.security).filter(([key]) => key !== 'revision'),
              ),
            )
          : clone({ enabled: settings[id].enabled, items: settings[id].items }),
      ]),
    );
  function transition(id, items) {
    const next = { ...settings, [id]: { ...settings[id], items } };
    persist(next);
    settings = next;
    drive();
  }
  function setThermostatEnabled(data) {
    if (stagedRestore) return fail('Перезагрузка после восстановления', 503);
    if (typeof data?.id !== 'string' || typeof data.value !== 'boolean')
      return fail('Некорректная команда режима термостата');
    const item = settings.thermostats.items.find((item) => item.id === data.id);
    if (!item) return fail('Термостат не найден', 404);
    if (item.enabled === data.value && !inhibitedThermostats.has(item.id))
      return { status: 200, data: { ok: true, ...snapshot('thermostats') } };
    thermostatDriver.resetItem(item.id);
    const next = {
      ...settings,
      thermostats: {
        ...settings.thermostats,
        items: settings.thermostats.items.map((item) =>
          item.id === data.id ? { ...item, enabled: data.value } : item,
        ),
      },
    };
    try {
      if (faults.thermostats.enabled) throw new Error(faults.thermostats.enabled);
      persist(next);
    } catch (error) {
      inhibitedThermostats.add(item.id);
      errors.set(key('thermostats', item.id), error.message);
      return fail(error.message, 503);
    }
    settings = next;
    inhibitedThermostats.delete(item.id);
    errors.delete(key('thermostats', item.id));
    thermostatDriver.step();
    return { status: 200, data: { ok: true, ...snapshot('thermostats') } };
  }
  /** @brief Advance virtual buttons and regulation without persisting transient thermostat demand. */
  function tick(now = Date.now(), initial = false) {
    if (stagedRestore || (busy && !initial)) return;
    if (errors.size) drive();
    const inputs = hardware.snapshot().inputs,
      conflicted = new Set(
        resources()
          .filter((resource) => resource.conflict)
          .map((resource) => resource.id),
      );
    for (const moduleId of buttonIds)
      for (const item of settings[moduleId].items) {
        const filterKey = key(moduleId, item.id);
        if (
          !settings[moduleId].enabled ||
          !item.inputId ||
          conflicted.has(item.inputId) ||
          conflicted.has(item.relayId)
        ) {
          filters.delete(filterKey);
          continue;
        }
        const input = inputs.find((channel) => channel.id === item.inputId);
        if (input?.valid !== true || typeof input.value !== 'boolean') {
          filters.delete(filterKey);
          continue;
        }
        const filter = filters.get(filterKey);
        if (!filter) {
          filters.set(filterKey, {
            armed: input.value,
            lockoutUntil: 0,
            releaseSince: null,
            releaseSamples: 0,
            lowSamples: 0,
            lowSampleAt: null,
          });
          continue;
        }
        if (filter.armed && !input.value) {
          if (filter.lowSampleAt === null || now - filter.lowSampleAt >= 20) {
            filter.lowSamples++;
            filter.lowSampleAt = now;
          }
          if (filter.lowSamples < 3) continue;
          filter.armed = false;
          filter.lockoutUntil = now + 300;
          filter.releaseSince = null;
          filter.releaseSamples = 0;
          try {
            if (moduleId === 'thermostats')
              setThermostatEnabled({ id: item.id, value: !item.enabled });
            else
              transition(
                moduleId,
                settings[moduleId].items.map((entry) =>
                  entry.id === item.id ? { ...entry, state: !entry.state } : entry,
                ),
              );
          } catch (error) {
            errors.set(filterKey, error.message);
          }
        } else if (filter.armed) {
          filter.lowSamples = 0;
          filter.lowSampleAt = null;
        } else if (!filter.armed) {
          if (now < filter.lockoutUntil || !input.value) {
            filter.releaseSince = null;
            filter.releaseSamples = 0;
          } else {
            if (filter.releaseSince === null) filter.releaseSince = now;
            if (++filter.releaseSamples >= 2 && now - filter.releaseSince >= 50)
              filter.armed = true;
          }
        }
      }
    thermostatDriver.step();
    securityDriver.step();
  }
  const meteoDriver = createMeteoMock({
    sensors: ports.sensors,
    dhtClaimed: (port, data) => {
      const owners = settings.meteo.items.filter((item) => item.portId === port);
      if (!owners.some((item) => item.sensorType === 'dht22')) return false;
      return !(
        owners.length === 1 &&
        data.itemId === owners[0].id &&
        data.baseRevision === settings.meteo.revision
      );
    },
  });
  function observation(id) {
    const item = settings.meteo.items.find((item) => item.id === id);
    return item
      ? {
          ...meteoDriver.observation(item, settings.meteo.enabled),
          name: item.name,
          enabled: settings.meteo.enabled,
        }
      : null;
  }
  const thermostatDriver = createThermostatsMock({
    hardware,
    configuration: () => settings.thermostats,
    observation,
    inhibited: (id) => inhibitedThermostats.has(id),
    persistenceError: (id) => errors.get(key('thermostats', id)),
  });
  const securityDriver = createSecurityMock({
    hardware,
    ports,
    faults: faults.security,
    configuration: () => settings.security,
    commit(module) {
      const next = { ...settings, security: module };
      persist(next);
      settings = next;
    },
    claim: (port) =>
      resources().some(
        (resource) =>
          resource.id === port &&
          resource.ownerController &&
          resource.ownerController !== 'security',
      ),
  });
  meteoDriver.configure(settings.meteo);
  configureInputs();
  drive();
  tick();
  const timer = setInterval(() => tick(), 10).unref();
  const engine = {
    modules: {},
    resources,
    tick,
    exportSettings,
    snapshot() {
      return {
        sockets: snapshot('sockets'),
        lights: snapshot('lights'),
        meteo: snapshot('meteo'),
        thermostats: snapshot('thermostats'),
        security: snapshot('security'),
        resources: resources(),
      };
    },
    get() {
      const error = ids.map((id) => faults[id].get).find(Boolean);
      return error ? fail(error, 503) : { status: 200, data: engine.snapshot() };
    },
    validateRestore(data) {
      if (
        !data ||
        Object.keys(data).sort().join(',') !== 'lights,meteo,security,sockets,thermostats'
      )
        return 'Неполный набор контроллеров';
      for (const id of ids)
        if (
          validate(data[id], true, id) ||
          (id !== 'security' && Object.keys(data[id]).sort().join(',') !== 'enabled,items')
        )
          return 'Некорректный контроллер';
      return conflict(data) ? 'Конфликт назначенных портов' : '';
    },
    stageRestore(data) {
      return exclusive(() => {
        const next = Object.fromEntries(
          ids.map((id) => [id, { revision: settings[id].revision + 1, ...clone(data[id]) }]),
        );
        for (const item of next.meteo.items) item.address = item.address.toLowerCase();
        persist(next);
        thermostatDriver.reset();
        stagedRestore = next;
      });
    },
    applyRestore() {
      if (stagedRestore) {
        settings = stagedRestore;
        stagedRestore = undefined;
        filters.clear();
        errors.clear();
        inhibitedThermostats.clear();
        configureInputs();
      }
    },
    reboot() {
      filters.clear();
      errors.clear();
      inhibitedThermostats.clear();
      thermostatDriver.reset();
      securityDriver.reset();
      meteoDriver.reset();
      meteoDriver.configure(settings.meteo);
      drive();
      tick();
    },
    setMeteoFault: meteoDriver.setFault,
    setMeteoReadFailure: meteoDriver.setReadFailure,
    advanceThermostatTime: (milliseconds) => thermostatDriver.advanceTime(milliseconds),
    advanceSecurityTime: (milliseconds) => securityDriver.advanceTime(milliseconds),
    setSecurityReaderFault: securityDriver.setReaderFault,
    securityDemo: securityDriver.demo,
    simulateIbutton: (data) => exclusive(() => securityDriver.contact(data)),
    setSecurityTouchHandlers: (handlers) => securityDriver.setTouchHandlers(handlers),
    simulateSecurityZone: (data) => exclusive(() => securityDriver.zone(data)),
    setMeteoTemperature(id, temperatureC, options) {
      const item = settings.meteo.items.find((item) => item.id === id);
      if (!item) throw new Error('Метеоточка не найдена');
      meteoDriver.setTemperature(item, temperatureC, options);
      tick();
    },
    simulatedTemperatures() {
      return settings.meteo.items.map((item) => ({
        id: item.id,
        name: item.name,
        ...meteoDriver.reading(item, settings.meteo.enabled),
      }));
    },
    simulateTemperature(data) {
      try {
        engine.setMeteoTemperature(data?.id, data?.temperatureC);
        return { status: 200, data: { ok: true, temperatures: engine.simulatedTemperatures() } };
      } catch (error) {
        return fail(error.message);
      }
    },
    relay(data) {
      if (settings.security.sirenRelayId === data?.id)
        return Promise.resolve(fail('Реле принадлежит сирене охраны', 409));
      if (settings.thermostats.items.some((item) => item.relayId === data?.id))
        return Promise.resolve(fail('Реле принадлежит термостату', 409));
      return hardware.relay(data);
    },
    simulatedInputs,
    simulateInput(data) {
      if (!lockedInputs.has(data?.id)) return fail('Вход не назначен кнопке контроллера', 404);
      if (typeof data.pressed !== 'boolean') return fail('Некорректное состояние кнопки');
      hardware.setInputLevel(data.id, !data.pressed);
      tick();
      return { status: 200, data: { ok: true, inputs: simulatedInputs() } };
    },
    close() {
      clearInterval(timer);
      meteoDriver.reset();
      for (const id of lockedInputs) hardware.unlockInput(id);
    },
  };
  for (const id of ids)
    engine.modules[id] = {
      snapshot: () => snapshot(id),
      tick,
      reboot: engine.reboot,
      close: engine.close,
      simulatedInputs,
      get boardId() {
        return boardId;
      },
      get counts() {
        return { ...counts[id] };
      },
      setFaults(value) {
        Object.assign(faults[id], value);
      },
      exportSettings: () => clone({ enabled: settings[id].enabled, items: settings[id].items }),
      get() {
        counts[id].get++;
        return faults[id].get ? fail(faults[id].get, 503) : { status: 200, data: snapshot(id) };
      },
      save(data) {
        return exclusive(() => {
          counts[id].save++;
          if (stagedRestore) return fail('Перезагрузка после восстановления', 503);
          if (data?.baseRevision !== settings[id].revision)
            return fail('Конфигурация контроллера изменена. Перезагрузите настройки.', 409);
          const error = validate(data, false, id);
          if (error) return fail(error);
          if (faults[id].save) {
            if (id === 'thermostats') thermostatDriver.reset();
            return fail(faults[id].save, 503);
          }
          if (
            id === 'thermostats' &&
            data.items.some(
              (item) =>
                !settings.meteo.items.some((source) => source.id === item.meteoId) &&
                !settings.thermostats.items.some(
                  (old) => old.id === item.id && old.meteoId === item.meteoId,
                ),
            )
          )
            return fail('Метеоточка не найдена');
          const nextModule = {
            revision: settings[id].revision,
            enabled: data.enabled,
            items: data.items.map((item) => {
              if (id === 'meteo')
                return {
                  id: item.id,
                  name: item.name.trim(),
                  portId: item.portId,
                  sensorType: item.sensorType,
                  address: item.address.toLowerCase(),
                };
              if (id === 'thermostats')
                return {
                  id: item.id,
                  name: item.name.trim(),
                  meteoId: item.meteoId,
                  relayId: item.relayId,
                  inputId: item.inputId || '',
                  enabled:
                    settings.thermostats.items.find((old) => old.id === item.id)?.enabled || false,
                  mode: item.mode,
                  setpointC: item.setpointC,
                  hysteresisC: item.hysteresisC,
                };
              const old = settings[id].items.find(
                (old) =>
                  old.id === item.id &&
                  old.relayId === item.relayId &&
                  old.inputId === item.inputId,
              );
              return {
                id: item.id,
                name: item.name.trim(),
                relayId: item.relayId,
                inputId: item.inputId,
                state: data.enabled && old ? old.state : false,
              };
            }),
          };
          const next = { ...settings, [id]: nextModule },
            clash = conflict(next);
          if (clash) return fail(`Порт ${clash.id} уже назначен: ${clash.ownerName}`, 409);
          if (JSON.stringify(nextModule) !== JSON.stringify(settings[id])) nextModule.revision++;
          try {
            persist(next);
          } catch (error) {
            if (id === 'thermostats') thermostatDriver.reset();
            return fail(error.message, 503);
          }
          for (const old of settings[id].items)
            if (
              id !== 'meteo' &&
              !nextModule.items.some((item) => item.id === old.id && item.relayId === old.relayId)
            )
              hardware.driveRelay(old.relayId, false);
          for (const item of [...settings[id].items, ...nextModule.items]) {
            const unchanged =
              settings[id].enabled === nextModule.enabled &&
              settings[id].items.some(
                (old) =>
                  old.id === item.id &&
                  old.relayId === item.relayId &&
                  old.inputId === item.inputId,
              ) &&
              nextModule.items.some(
                (next) =>
                  next.id === item.id &&
                  next.relayId === item.relayId &&
                  next.inputId === item.inputId,
              );
            if (!unchanged) filters.delete(key(id, item.id));
          }
          settings = next;
          for (const itemId of inhibitedThermostats)
            if (!settings.thermostats.items.some((item) => item.id === itemId))
              inhibitedThermostats.delete(itemId);
          for (const errorKey of errors.keys())
            if (
              !errorKey.startsWith('thermostats/') ||
              !inhibitedThermostats.has(errorKey.slice('thermostats/'.length))
            )
              errors.delete(errorKey);
          configureInputs();
          drive();
          meteoDriver.configure(settings.meteo);
          tick(Date.now(), true);
          return { status: 200, data: { ok: true, ...snapshot(id) } };
        });
      },
      state(data) {
        return exclusive(async () => {
          counts[id].state++;
          if (stagedRestore) return fail('Перезагрузка после восстановления', 503);
          if (typeof data?.id !== 'string' || typeof data.value !== 'boolean')
            return fail('Некорректная команда контроллера');
          const item = settings[id].items.find((item) => item.id === data.id);
          if (!item) return fail('Элемент не найден', 404);
          if (!settings[id].enabled) return fail('Модуль выключен', 409);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(Number(faults[id].stateDelayMs) || 0, 3000)),
          );
          if (faults[id].state) return fail(faults[id].state, 503);
          const known = snapshot(id).items.find((entry) => entry.id === data.id);
          if (!known.available) return fail(known.error || 'Оборудование недоступно', 503);
          const error = hardware.driveRelay(item.relayId, data.value);
          if (error) {
            errors.set(key(id, item.id), error);
            return fail(error, 503);
          }
          try {
            transition(
              id,
              settings[id].items.map((entry) =>
                entry.id === data.id ? { ...entry, state: data.value } : entry,
              ),
            );
          } catch (error) {
            drive();
            return fail(error.message, 503);
          }
          return { status: 200, data: { ok: true, ...snapshot(id) } };
        });
      },
    };
  engine.modules.security = {
    snapshot: () => snapshot('security'),
    exportSettings: () => exportSettings().security,
    get counts() {
      return { ...counts.security };
    },
    setFaults(value) {
      Object.assign(faults.security, value);
    },
    get() {
      counts.security.get++;
      return faults.security.get
        ? fail(faults.security.get, 503)
        : { status: 200, data: snapshot('security') };
    },
    scan: (data) => exclusive(() => securityDriver.scan(data)),
    armed: (data) => exclusive(() => securityDriver.setArmed(data)),
    save(data) {
      return exclusive(() => {
        counts.security.save++;
        if (stagedRestore) return fail('Перезагрузка после восстановления', 503);
        if (data?.baseRevision !== settings.security.revision)
          return fail('Конфигурация охраны изменена', 409);
        const error = validateSecurity(data, ports);
        if (error) return fail(error);
        if (settings.security.armed && data.enabled) return fail('Сначала снимите охрану', 409);
        if (faults.security.save) return fail(faults.security.save, 503);
        const nextModule = {
          ...clone(data),
          revision: settings.security.revision + 1,
          armed: data.enabled ? settings.security.armed : false,
          triggered: data.enabled ? settings.security.triggered : false,
        };
        delete nextModule.baseRevision;
        for (const key of nextModule.keys) key.address = key.address.toLowerCase();
        const next = { ...settings, security: nextModule },
          clash = conflict(next);
        if (clash) return fail(`Порт ${clash.id} уже занят: ${clash.ownerName}`, 409);
        try {
          persist(next);
        } catch (error) {
          return fail(error.message, 503);
        }
        if (settings.security.sirenRelayId)
          hardware.driveRelay(settings.security.sirenRelayId, false);
        settings = next;
        configureInputs();
        securityDriver.reset();
        return { status: 200, data: { ok: true, ...snapshot('security') } };
      });
    },
  };
  engine.modules.meteo.scan = (data) =>
    exclusive(() =>
      settings.security.readerPortId === data?.portId
        ? fail('Порт занят считывателем iButton', 409)
        : meteoDriver.scan(data),
    );
  engine.modules.thermostats.enabled = (data) =>
    exclusive(async () => {
      counts.thermostats.enabled++;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(Number(faults.thermostats.enabledDelayMs) || 0, 3000)),
      );
      return setThermostatEnabled(data);
    });
  return engine;
}
module.exports = { createControllersMock };
