/** @file security_mock.cjs @brief Model autonomous alarm zones, iButton contacts and durable permissions. */
'use strict';
const { performance } = require('node:perf_hooks');

const clone = (value) => JSON.parse(JSON.stringify(value));
const emptySecurity = () => ({
  revision: 1,
  enabled: false,
  sirenRelayId: '',
  readerPortId: '',
  exitDelaySeconds: 30,
  entryDelaySeconds: 15,
  keys: [],
  items: [],
  armed: false,
  triggered: false,
});
/** @brief Validate family-0x01 wire-order ROM bytes including the Dallas CRC. */
function validIbutton(address) {
  if (typeof address !== 'string' || !/^01[0-9a-f]{14}$/i.test(address)) return false;
  let crc = 0;
  for (const byte of Buffer.from(address, 'hex')) {
    let part = byte;
    for (let bit = 0; bit < 8; bit++) {
      const mixed = (crc ^ part) & 1;
      crc >>= 1;
      if (mixed) crc ^= 0x8c;
      part >>= 1;
    }
  }
  return crc === 0;
}
/** @brief Generate repeatable, valid simulated contact-key identifiers. */
function demoKey(serial) {
  const bytes = [1, serial, 0x12, 0x34, 0x56, 0x78, 0x9a];
  let crc = 0;
  for (const byte of bytes) {
    let part = byte;
    for (let bit = 0; bit < 8; bit++) {
      const mixed = (crc ^ part) & 1;
      crc >>= 1;
      if (mixed) crc ^= 0x8c;
      part >>= 1;
    }
  }
  return Buffer.from([...bytes, crc]).toString('hex');
}
const demoKeys = [demoKey(0x11), demoKey(0x22), demoKey(0x33)];
/** @brief Validate configuration independently from the mutable alarm state. */
function validateSecurity(module, ports, states = false) {
  const text = (value, maximum = 64) =>
    typeof value === 'string' &&
    value.trim() &&
    Buffer.byteLength(value) <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value);
  const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value);
  if (
    !module ||
    typeof module.enabled !== 'boolean' ||
    !Array.isArray(module.items) ||
    module.items.length > 16 ||
    !Array.isArray(module.keys) ||
    module.keys.length > 16 ||
    typeof module.sirenRelayId !== 'string' ||
    typeof module.readerPortId !== 'string' ||
    (module.sirenRelayId && !ports.relays.includes(module.sirenRelayId)) ||
    (module.readerPortId && !ports.sensors.includes(module.readerPortId)) ||
    !['exitDelaySeconds', 'entryDelaySeconds'].every(
      (key) => Number.isInteger(module[key]) && module[key] >= 0 && module[key] <= 300,
    ) ||
    (states &&
      (typeof module.armed !== 'boolean' ||
        typeof module.triggered !== 'boolean' ||
        (module.triggered && !module.armed) ||
        (!module.enabled && (module.armed || module.triggered)))) ||
    (!states && ('armed' in module || 'triggered' in module))
  )
    return 'Некорректные общие настройки охраны';
  const fields = [
    'enabled',
    'sirenRelayId',
    'readerPortId',
    'exitDelaySeconds',
    'entryDelaySeconds',
    'keys',
    'items',
    ...(states ? ['revision', 'armed', 'triggered'] : ['baseRevision']),
  ];
  if (Object.keys(module).some((key) => !fields.includes(key))) return 'Неизвестное поле охраны';
  if (states && module.armed && !module.items.length)
    return 'Для постановки на охрану добавьте хотя бы один датчик';
  if (
    module.items.some(
      (item) =>
        !item ||
        !id(item.id) ||
        !text(item.name) ||
        !ports.inputs.includes(item.inputId) ||
        !['reed', 'motion'].includes(item.sensorType) ||
        typeof item.entryDelay !== 'boolean' ||
        Object.keys(item).some(
          (name) => !['id', 'name', 'inputId', 'sensorType', 'entryDelay'].includes(name),
        ),
    ) ||
    new Set(module.items.map((item) => item.id)).size !== module.items.length
  )
    return 'Некорректный датчик охраны';
  if (
    module.keys.some(
      (item) =>
        !item ||
        !id(item.id) ||
        !text(item.name) ||
        !validIbutton(item.address) ||
        Object.keys(item).some((name) => !['id', 'name', 'address'].includes(name)),
    ) ||
    new Set(module.keys.map((item) => item.id)).size !== module.keys.length ||
    new Set(module.keys.map((item) => item.address.toLowerCase())).size !== module.keys.length
  )
    return 'Некорректный или повторяющийся ключ iButton';
  return '';
}

/** @brief Run a local alarm state machine with a controllable monotonic test clock. */
function createSecurityMock({ hardware, configuration, commit, ports, faults, claim }) {
  let touchHandlers = null;
  const filters = new Map();
  let pendingEntry = false;
  let offset = 0,
    phase = 'disarmed',
    deadline = 0,
    alarmZone = '',
    inhibited = false;
  let readerFault = '',
    contact = '',
    latchedContact = false,
    releaseSamples = 2,
    sameSamples = 0;
  let lastPoll = -Infinity,
    enrollmentUntil = 0,
    scanState = null,
    lastError = '';
  const now = () => performance.now() + offset;
  let warmupUntil = now() + 300;
  const fail = (error, status = 400) => ({ status, data: { error } });
  function zoneRows(time = now()) {
    const observations = hardware.snapshot().inputs;
    return configuration().items.map((item) => {
      const input = observations.find((row) => row.id === item.inputId);
      const available = input?.valid === true && typeof input.value === 'boolean';
      let filter = filters.get(item.id);
      const binding = `${item.inputId}/${item.sensorType}`;
      if (!filter || filter.binding !== binding) {
        filter = { binding, candidate: null, samples: 0, level: null, lastSample: -Infinity };
        filters.set(item.id, filter);
      }
      if (!available) {
        filter.level = null;
        filter.samples = 0;
      } else if (time - filter.lastSample >= 20) {
        filter.lastSample = time;
        if (filter.candidate !== input.value) {
          filter.candidate = input.value;
          filter.samples = 1;
        } else filter.samples++;
        if (filter.samples >= 3) filter.level = input.value;
      }
      return {
        ...item,
        available: available && filter.level !== null,
        inputLevel: available ? input.value : null,
        closed: available ? !input.value : null,
        active:
          available && filter.level !== null
            ? item.sensorType === 'reed'
              ? filter.level
              : !filter.level
            : null,
        error: !available
          ? input?.error || 'Нет данных входа'
          : filter.level === null
            ? 'Подтверждение уровня входа'
            : '',
      };
    });
  }
  function persistFlags(armed, triggered) {
    if (faults.state) throw new Error(faults.state);
    commit({ ...configuration(), armed, triggered });
  }
  function output() {
    const config = configuration();
    if (!config.sirenRelayId) return;
    const error = hardware.driveRelay(
      config.sirenRelayId,
      Boolean(
        config.enabled &&
        config.armed &&
        ((config.triggered && !pendingEntry) || phase === 'alarm') &&
        !inhibited,
      ),
    );
    if (error) lastError = error;
  }
  function trigger(id = '') {
    const config = configuration();
    alarmZone = id;
    pendingEntry = false;
    phase = 'alarm';
    deadline = 0;
    if (!config.triggered) {
      try {
        persistFlags(true, true);
      } catch (error) {
        lastError = error.message;
      }
    }
    output();
  }
  function blockReason() {
    const config = configuration(),
      rows = zoneRows();
    if (!config.enabled) return 'Модуль охраны выключен';
    if (!config.items.length) return 'Добавьте и сохраните хотя бы один датчик охраны';
    const siren = hardware.snapshot().relays.find((row) => row.id === config.sirenRelayId);
    if (config.sirenRelayId && (siren?.valid !== true || typeof siren.value !== 'boolean'))
      return 'Сирена недоступна';
    if (rows.some((row) => !row.available)) return 'Нет подтверждённых данных всех датчиков';
    if (!config.exitDelaySeconds && rows.some((row) => row.active)) return 'Датчик уже сработал';
    return '';
  }
  function setArmed(data) {
    if (typeof data?.value !== 'boolean') return fail('Укажите value для постановки или снятия');
    const config = configuration();
    if (data.value) {
      const reason = blockReason();
      if (reason) return fail(reason, 409);
    }
    if (!data.value) {
      inhibited = true;
      output();
    }
    try {
      persistFlags(data.value, false);
    } catch (error) {
      lastError = data.value
        ? error.message
        : `Снятие не сохранено: ${error.message}; после перезапуска охрана восстановится`;
      return fail(lastError, 503);
    }
    inhibited = false;
    pendingEntry = false;
    lastError = '';
    alarmZone = '';
    phase = data.value ? (config.exitDelaySeconds ? 'exit_delay' : 'armed') : 'disarmed';
    deadline = data.value && config.exitDelaySeconds ? now() + config.exitDelaySeconds * 1000 : 0;
    output();
    return { status: 200, data: { ok: true, ...snapshot() } };
  }
  function pollKey(time) {
    if (time - lastPoll < 100) return;
    lastPoll = time;
    if (readerFault || !configuration().readerPortId) return;
    if (!contact) {
      sameSamples = 0;
      if (++releaseSamples >= 2) latchedContact = false;
      return;
    }
    releaseSamples = 0;
    if (latchedContact || ++sameSamples < 2) return;
    latchedContact = true;
    if (time < enrollmentUntil || !configuration().enabled) return;
    const key = configuration().keys.find((key) => key.address.toLowerCase() === contact);
    if (!key) return;
    let decision;
    try {
      decision = touchHandlers?.decide?.(clone(key));
    } catch {
      lastError = 'Недоступна сессия управления охраной';
      return;
    }
    const value = typeof decision?.value === 'boolean' ? decision.value : !configuration().armed;
    const busy = decision?.busy === true;
    const result = busy ? fail('Сценарий охраны уже выполняется', 409) : setArmed({ value });
    touchHandlers?.observed?.({
      keyId: key.id,
      keyName: key.name,
      value,
      busy,
      localApplied: result.status === 200,
    });
  }
  function step() {
    const time = now();
    const rows = zoneRows(time);
    pollKey(time);
    const config = configuration();
    if (!config.enabled || !config.armed) {
      phase = 'disarmed';
      deadline = 0;
      output();
      return;
    }
    if ((config.triggered && !pendingEntry) || phase === 'alarm') {
      phase = 'alarm';
      output();
      return;
    }
    if (phase === 'disarmed') phase = 'armed';
    if (phase === 'exit_delay') {
      if (time < deadline) {
        output();
        return;
      }
      phase = 'armed';
      deadline = 0;
      const unsafe = rows.find((row) => !row.available || row.active);
      if (unsafe) {
        trigger(unsafe.id);
        return;
      }
    }
    const bad = rows.find((row) => !row.available);
    if (bad && time < warmupUntil) {
      output();
      return;
    }
    if (bad) {
      trigger(bad.id);
      return;
    }
    const instant = rows.find(
      (row) => row.active && (!row.entryDelay || !config.entryDelaySeconds),
    );
    if (instant) {
      trigger(instant.id);
      return;
    }
    const delayed = rows.find((row) => row.active);
    if (phase === 'armed' && delayed) {
      try {
        persistFlags(true, true);
      } catch (error) {
        lastError = error.message;
        trigger(delayed.id);
        return;
      }
      pendingEntry = true;
      phase = 'entry_delay';
      deadline = time + config.entryDelaySeconds * 1000;
      alarmZone = delayed.id;
    }
    if (phase === 'entry_delay' && time >= deadline) {
      trigger(alarmZone);
      return;
    }
    output();
  }
  function snapshot() {
    const config = configuration(),
      io = hardware.snapshot();
    const siren = io.relays.find((row) => row.id === config.sirenRelayId);
    const reason = blockReason();
    return {
      ...clone(config),
      phase: pendingEntry
        ? 'entry_delay'
        : config.triggered
          ? 'alarm'
          : !config.armed
            ? 'disarmed'
            : phase,
      inhibited,
      remainingSeconds: deadline ? Math.max(0, Math.ceil((deadline - now()) / 1000)) : 0,
      readyToArm: !reason,
      armBlockReason: reason,
      alarmZoneId: alarmZone,
      sirenActual: siren?.valid ? siren.value : null,
      sirenAvailable: siren?.valid === true,
      reader: {
        available: Boolean(config.readerPortId) && !readerFault,
        present: Boolean(contact),
        error: readerFault,
        updatedAtUptimeMs: Math.round(now()),
      },
      enrollmentRemainingSeconds: Math.max(0, Math.ceil((enrollmentUntil - now()) / 1000)),
      items: zoneRows(),
      ports: clone(ports),
      error: lastError,
    };
  }
  function reset() {
    pendingEntry = false;
    filters.clear();
    deadline = 0;
    alarmZone = '';
    inhibited = false;
    lastError = '';
    phase = configuration().triggered ? 'alarm' : configuration().armed ? 'armed' : 'disarmed';
    warmupUntil = now() + 300;
    latchedContact = Boolean(contact);
    releaseSamples = contact ? 0 : 2;
    sameSamples = 0;
    output();
  }
  function scan(data) {
    if (configuration().armed) return fail('Перед поиском ключа снимите охрану', 409);
    if (!ports.sensors.includes(data?.portId)) return fail('Выберите порт считывателя');
    if (claim(data.portId)) return fail('Порт датчика занят другим контроллером', 409);
    if (!scanState || data.refresh || scanState.portId !== data.portId) {
      enrollmentUntil = now() + 30000;
      scanState = { portId: data.portId, until: now() + 100 };
    }
    const busy = now() < scanState.until;
    return {
      status: 200,
      data: {
        portId: data.portId,
        busy,
        complete: !busy,
        addresses: !busy && contact && !readerFault ? [contact] : [],
        error: readerFault,
        updatedAtUptimeMs: Math.round(now()),
      },
    };
  }
  return {
    step,
    snapshot,
    setArmed,
    reset,
    scan,
    advanceTime(ms) {
      offset += ms;
      step();
    },
    setReaderFault(error) {
      readerFault = error || '';
    },
    contact(data) {
      if (data.present !== false && !validIbutton(data.address))
        return fail('Неверный серийный номер iButton');
      const next = data.present === false ? '' : data.address.toLowerCase();
      if (contact !== next) sameSamples = 0;
      contact = next;
      step();
      return { status: 200, data: { ok: true, ...demo() } };
    },
    zone(data) {
      const item = configuration().items.find((row) => row.id === data?.id);
      if (!item || typeof data.active !== 'boolean') return fail('Датчик не найден');
      hardware.setInputLevel(item.inputId, item.sensorType === 'reed' ? data.active : !data.active);
      step();
      return { status: 200, data: { ok: true } };
    },
    demo,
    setTouchHandlers(value) {
      touchHandlers = value;
    },
  };
  function demo() {
    return { present: Boolean(contact), address: contact, demoKeys, zones: zoneRows() };
  }
}
module.exports = { createSecurityMock, emptySecurity, validIbutton, validateSecurity, demoKeys };
