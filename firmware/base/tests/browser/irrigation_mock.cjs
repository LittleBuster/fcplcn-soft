/** @file Weekly irrigation schedules for the virtual PLC; no physical I/O. */
'use strict';

const isRemoteTank = (id) =>
  typeof id === 'string' && /^fcplcn-[A-Za-z0-9_-]{1,97}\/[A-Za-z0-9_-]{1,32}$/.test(id);

/** Fixed POSIX zones use west-positive offsets, including UTC-7 for UTC+7. */
function fixedUtcOffsetMinutes(zone) {
  if (zone === 'UTC' || zone === 'GMT') return 0;
  const match = /^(?:[a-zA-Z]{3,}|<[a-zA-Z0-9+-]{3,}>)([+-]?)(\d{1,2})(?::([0-5]\d))?$/.exec(zone);
  if (!match) return NaN;
  const hours = Number(match[2]),
    minutes = Number(match[3] || 0);
  if (hours > 24 || (hours === 24 && minutes)) return NaN;
  return (match[1] === '-' ? 1 : -1) * (hours * 60 + minutes) || 0;
}

function validateIrrigation(module, relays, states) {
  if (
    !module ||
    typeof module.enabled !== 'boolean' ||
    !Array.isArray(module.items) ||
    module.items.length > 16
  )
    return 'Некорректные настройки полива';
  const ids = new Set();
  const tanksByRelay = new Map();
  const fields = [
    'id',
    'name',
    'relayId',
    'tankId',
    'days',
    'startTime',
    'durationMinutes',
    'enabled',
  ];
  for (const item of module.items) {
    const tankId = item?.tankId === undefined ? '' : item.tankId;
    if (
      !item ||
      Object.keys(item).some((field) => !fields.includes(field)) ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      Buffer.byteLength(item.name) > 64 ||
      /[\x00-\x1f\x7f]/.test(item.name) ||
      !relays.includes(item.relayId) ||
      (!isRemoteTank(tankId) &&
        (typeof tankId !== 'string' || !/^[a-zA-Z0-9_-]{0,32}$/.test(tankId))) ||
      !Array.isArray(item.days) ||
      !item.days.length ||
      item.days.length > 7 ||
      !item.days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7) ||
      new Set(item.days).size !== item.days.length ||
      typeof item.startTime !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.startTime) ||
      !Number.isInteger(item.durationMinutes) ||
      item.durationMinutes < 1 ||
      item.durationMinutes > 1440 ||
      ((states || 'enabled' in item) && typeof item.enabled !== 'boolean')
    )
      return 'Проверьте название, реле, бак, дни, время и длительность полива';
    if (tanksByRelay.has(item.relayId) && tanksByRelay.get(item.relayId) !== tankId)
      return 'Выберите одинаковый источник воды для всех правил этого крана';
    ids.add(item.id);
    tanksByRelay.set(item.relayId, tankId);
  }
  return '';
}

function createIrrigationMock({
  hardware,
  configuration,
  waterForIrrigation,
  localClock,
  inhibited,
}) {
  const runtime = new Map();
  const lastRunDate = new Map();
  let remoteTanks = new Map();
  let remoteExpiry = 0;
  let testClock = null;
  const monotonicNow = () => testClock?.monotonic ?? performance.now();
  function setRemoteTanks(rows, ttlMs = 3000) {
    const now = monotonicNow();
    if (now >= remoteExpiry) {
      // An expired observation breaks continuity even if the next MQTT update
      // arrives before the worker has run another iteration.
      for (const { id, tankId } of configuration().items) {
        const row = runtime.get(id);
        if (row && isRemoteTank(tankId)) row.until = 0;
      }
    }
    remoteTanks = new Map();
    const validTtl = Number.isFinite(ttlMs) && ttlMs > 0 && ttlMs <= 3000;
    remoteExpiry = validTtl ? now + ttlMs : 0;
    for (const row of rows) {
      if (remoteTanks.size === 96) break;
      if (
        !isRemoteTank(row?.id) ||
        remoteTanks.has(row.id) ||
        ![row.name, row.deviceName].every(
          (name) => typeof name === 'string' && name.trim() && Buffer.byteLength(name) <= 64,
        ) ||
        !(row.waterAvailable === null || typeof row.waterAvailable === 'boolean')
      )
        continue;
      const { id, name, deviceName, waterAvailable } = row;
      remoteTanks.set(id, { id, name, deviceName, waterAvailable });
    }
    step();
  }
  function closeValve(relayId) {
    const relay = hardware.snapshot().relays.find((row) => row.id === relayId);
    return Boolean(relay?.valid && relay.value === false) || !hardware.driveRelay(relayId, false);
  }
  function reset(replacement = []) {
    let closed = true;
    const rules = [...configuration().items, ...replacement];
    for (const relayId of new Set(rules.map((rule) => rule.relayId))) {
      if (!closeValve(relayId)) closed = false;
    }
    runtime.clear();
    return closed;
  }
  function step() {
    const module = configuration();
    if (!module.items.length && !runtime.size) return;
    const wall = testClock ? testClock.wall : localClock();
    const now = monotonicNow();
    const date = new Date(wall);
    const minute =
      date.getUTCFullYear() >= 2024 && date.getUTCFullYear() < 2100
        ? Math.floor(wall / 60000)
        : null;
    const localDay = minute === null ? '' : date.toISOString().slice(0, 10);
    const sources = module.items.some((item) => item.tankId && !isRemoteTank(item.tankId))
      ? waterForIrrigation()
      : null;
    const io = hardware.snapshot();
    const demand = new Map();
    for (const [id, row] of runtime)
      if (!module.items.some((item) => item.id === id)) {
        demand.set(row.relayId, false);
        runtime.delete(id);
        lastRunDate.delete(id);
      }
    for (const item of module.items) {
      let row = runtime.get(item.id);
      const binding = JSON.stringify([
        item.relayId,
        item.tankId,
        item.days,
        item.startTime,
        item.durationMinutes,
      ]);
      const changed = !row || row.binding !== binding;
      if (changed) {
        if (row) demand.set(row.relayId, false);
        row = { relayId: item.relayId, binding, until: 0, previousMinute: null };
        runtime.set(item.id, row);
      }
      const water = isRemoteTank(item.tankId)
        ? now < remoteExpiry
          ? (remoteTanks.get(item.tankId)?.waterAvailable ?? null)
          : null
        : (sources?.get(item.tankId) ?? null);
      const relay = io.relays.find((r) => r.id === item.relayId);
      const enabled = module.enabled && item.enabled;
      row.waterAvailable = water;
      row.error = enabled
        ? inhibited(item.id)
          ? 'Правило заблокировано после ошибки сохранения'
          : !relay?.valid
            ? 'Нет подтверждения реле крана'
            : minute === null
              ? 'Не установлено время PLC'
              : item.tankId && water === null
                ? 'Нет подтверждённых данных бака'
                : item.tankId && !water
                  ? 'В баке нет воды'
                  : null
        : null;
      const due =
        minute !== null &&
        row.previousMinute !== null &&
        minute === row.previousMinute + 1 &&
        date.getUTCSeconds() < 3 &&
        localDay > (lastRunDate.get(item.id) || '') &&
        item.days.includes(date.getUTCDay() || 7) &&
        item.startTime === date.toISOString().slice(11, 16);
      row.previousMinute = minute;
      if (due) lastRunDate.set(item.id, localDay);
      if (!enabled || row.error) row.until = 0;
      else if (due) row.until = now + item.durationMinutes * 60000;
      else if (now >= row.until || !relay.value) row.until = 0;
      demand.set(row.relayId, Boolean(demand.get(row.relayId) || row.until > now));
    }
    for (const [relayId, on] of demand) {
      const value = io.relays.find((r) => r.id === relayId);
      if (value?.valid && value.value === on) continue;
      const error = hardware.driveRelay(relayId, on);
      if (error) {
        for (const row of runtime.values())
          if (row.relayId === relayId) {
            row.until = 0;
            row.error = error;
          }
        hardware.driveRelay(relayId, false);
      }
    }
    const relays = hardware.snapshot().relays;
    for (const row of runtime.values()) {
      const relay = relays.find((r) => r.id === row.relayId);
      row.valveActual = relay?.valid && typeof relay.value === 'boolean' ? relay.value : null;
      row.actual = row.valveActual === null ? null : row.valveActual && row.until > now;
      row.remainingSeconds = Math.max(0, Math.ceil((row.until - now) / 1000));
    }
  }
  function snapshot(includeCatalogue = true) {
    step();
    const module = configuration();
    const remoteFresh = monotonicNow() < remoteExpiry;
    return {
      revision: module.revision,
      enabled: module.enabled,
      ports: { relays: hardware.snapshot().relays.map((x) => x.id) },
      ...(includeCatalogue
        ? {
            remoteTanks: [...remoteTanks.values()].map((tank) => ({
              ...tank,
              waterAvailable: remoteFresh ? tank.waterAvailable : null,
            })),
          }
        : {}),
      items: module.items.map((item) => {
        const { actual, valveActual, waterAvailable, error, remainingSeconds } = runtime.get(
          item.id,
        );
        return { ...item, actual, valveActual, waterAvailable, error, remainingSeconds };
      }),
    };
  }
  function setTime(wall, monotonic) {
    testClock = { wall, monotonic: monotonic ?? performance.now() };
    step();
  }
  function resetRule(id) {
    const row = runtime.get(id);
    if (!row) return true;
    row.until = 0;
    row.previousMinute = null;
    const now = monotonicNow();
    const sharedDemand = [...runtime.values()].some(
      (other) => other.relayId === row.relayId && other.until > now,
    );
    return sharedDemand || closeValve(row.relayId);
  }
  return { step, reset, resetRule, snapshot, setTime, setRemoteTanks };
}
module.exports = { createIrrigationMock, validateIrrigation, fixedUtcOffsetMinutes, isRemoteTank };
