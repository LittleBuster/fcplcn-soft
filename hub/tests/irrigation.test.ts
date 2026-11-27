/** @file Irrigation rules crossing the local MQTT and cloud control boundaries. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  irrigationDays,
  irrigationRuleState,
  validIrrigationTelemetry,
} from '../shared/irrigation.js';
import { cloudPermitted, cloudRoute } from '../shared/cloud.js';
import { serviceRoute } from '../src/protocol/management.js';
import { HubRegistry } from '../src/protocol/registry.js';

const rule = {
  id: 'garden',
  name: 'Газон',
  enabled: true,
  relayId: 'rly-0/8',
  tankId: 'rain',
  days: [7, 1],
  startTime: '07:00',
  durationMinutes: 15,
  actual: false,
  valveActual: true,
  remainingSeconds: 0,
  waterAvailable: true,
  error: null,
};

test('A tank-bound watering rule keeps its own activity separate from the shared valve', () => {
  assert.equal(validIrrigationTelemetry(rule), true);
  assert.equal(irrigationDays(rule.days), 'Пн, Вс');
  assert.equal(irrigationDays([1, 2, 3, 4, 5, 6, 7]), 'Ежедневно');
  assert.equal(irrigationRuleState(rule), 'Ожидает старта');
  assert.equal(irrigationRuleState({ ...rule, actual: true }), 'Идёт полив');
  assert.equal(irrigationRuleState({ ...rule, waterAvailable: false }), 'Нет воды в баке');
  for (const patch of [
    { days: [0] },
    { days: [1, 1] },
    { days: [] },
    { startTime: '24:00' },
    { durationMinutes: 0 },
    { durationMinutes: 1441 },
    { relayId: 'light' },
    { tankId: '', waterAvailable: true },
    { tankId: '', waterAvailable: false },
    { tankId: null, waterAvailable: null },
    { tankId: undefined, waterAvailable: null },
    { tankId: ' ' },
    { actual: 1 },
    { waterAvailable: 'yes' },
    { remainingSeconds: -1 },
  ])
    assert.equal(validIrrigationTelemetry({ ...rule, ...patch }), false, JSON.stringify(patch));
});

test('An explicitly tankless rule can water on schedule while a rule with unreadable tank data is blocked', () => {
  const standalone = { ...rule, tankId: '', waterAvailable: null };
  assert.equal(validIrrigationTelemetry(standalone), true);
  assert.equal(irrigationRuleState(standalone), 'Ожидает старта');
  assert.equal(irrigationRuleState({ ...standalone, actual: true }), 'Идёт полив');
  assert.equal(irrigationRuleState({ ...standalone, actual: null }), 'Нет данных полива');
  assert.equal(irrigationRuleState({ ...standalone, error: 'Ошибка реле' }), 'Полив заблокирован');
  assert.equal(irrigationRuleState({ ...standalone, enabled: false }), 'Правило выключено');
  const unresolved = { ...rule, waterAvailable: null };
  assert.equal(validIrrigationTelemetry(unresolved), true);
  assert.equal(irrigationRuleState(unresolved), 'Нет данных бака');
});

test('Cloud owners edit irrigation schedules, operators toggle them, and service exposes no raw valve route', () => {
  const service = '/controllers/irrigation';
  const path = '/devices/fcplcn-board/service' + service;
  for (const [method, suffix, allowed] of [
    ['GET', '', true],
    ['POST', '', true],
    ['POST', '/enabled', true],
    ['POST', '/state', false],
    ['POST', '/scan', false],
  ] as const) {
    assert.equal(serviceRoute(method, service + suffix), allowed);
    assert.equal(cloudRoute(method, path + suffix), allowed);
  }
  for (const role of ['owner', 'operator', 'viewer'] as const) {
    const actor = { userId: 'test', role };
    assert.equal(cloudPermitted(actor, 'POST', path, { items: [rule] }), role === 'owner');
    assert.equal(
      cloudPermitted(actor, 'POST', '/devices/fcplcn-board/commands', {
        controller: 'irrigation',
        itemId: rule.id,
        value: true,
      }),
      role !== 'viewer',
    );
  }
});

test('Enabling a dry watering schedule requires a fresh matching PLC and a SET acknowledgement without opening the valve', async () => {
  const publications: { topic: string; packet: Record<string, unknown> }[] = [];
  const registry = new HubRegistry(
    {
      product: { id: 'fcplcn', name: 'FCPLCn', fullName: 'Future City PLC Next' },
      mode: 'mqtt',
      brokerUrl: 'mqtt://localhost',
      clientId: 'irrigation-test',
      staleAfterMs: 35000,
      commandTimeoutMs: 1000,
      labels: {},
      onLabelsChanged() {},
    },
    {
      async publish(topic, payload) {
        publications.push({ topic, packet: JSON.parse(payload) });
      },
    },
  );
  const id = 'fcplcn-irrigation',
    bootId = 'boot-one';
  const receive = (path: string, data: unknown, retained = false) =>
    registry.receive('fcplcn/' + id + '/' + path, JSON.stringify(data), retained);
  const heartbeat = {
    deviceId: id,
    bootId,
    product: 'FCPLCn',
    schemaVersion: 1,
    boardId: 'fcplcn-161608-1v0',
    firmwareVersion: 'test',
    sequence: 1,
    uptimeSec: 100,
    socketCommandSequence: 0,
    lightCommandSequence: 0,
    thermostatCommandSequence: 0,
    securityCommandSequence: 0,
  };
  const item = {
    ...rule,
    enabled: false,
    actual: false,
    valveActual: false,
    waterAvailable: false,
  };
  const status = { bootId, uptimeMs: 100000, enabled: true, commandSequence: 2, items: [item] };
  registry.setConnection(true);
  try {
    receive('system/status', heartbeat);
    receive('controllers/irrigation/status', status, true);
    await assert.rejects(registry.command(id, 'irrigation', rule.id, true), /свежих/);
    receive('controllers/irrigation/status', status);
    await assert.rejects(registry.command(id, 'irrigation', rule.id, true), /счётчик/);
    receive('system/status', { ...heartbeat, sequence: 2, irrigationCommandSequence: 3 });
    const pending = registry.command(id, 'irrigation', rule.id, true);
    await setImmediate();
    assert.equal(publications.length, 1);
    const { topic, packet } = publications[0];
    assert.equal(topic, 'fcplcn/' + id + '/controllers/irrigation/set');
    assert.equal(packet.sequence, 4);
    assert.equal(packet.value, true);
    receive('controllers/irrigation/ack', {
      bootId,
      sequence: 4,
      id: rule.id,
      value: true,
      ok: true,
    });
    assert.equal((await pending).status, 'applied');
    const read = () =>
      (registry.snapshot().devices[0].controllers.irrigation!.data.items as (typeof item)[])[0];
    assert.deepEqual(read(), item);
    receive('controllers/irrigation/status', {
      ...status,
      uptimeMs: 100020,
      commandSequence: 4,
      items: [{ ...item, enabled: true }],
    });
    assert.equal(read().enabled, true);
    assert.equal(read().actual, false);
    assert.equal(read().valveActual, false);
  } finally {
    registry.close();
  }
});

test('Hub lists all PLC tanks and relays only current non-retained water observations', () => {
  const relays: { topic: string; reply: Record<string, unknown>; expiry: number }[] = [];
  let now = 0;
  const hub = new HubRegistry(
    {
      product: { id: 'fcplcn', name: 'FCPLCn', fullName: 'Future City PLC Next' },
      mode: 'mqtt',
      brokerUrl: 'mqtt://localhost',
      clientId: 'test-remote-water',
      staleAfterMs: 35_000,
      commandTimeoutMs: 1000,
      labels: { 'fcplcn-source': { name: 'Котельная', room: 'Цоколь' } },
      onLabelsChanged() {},
    },
    {
      async publish(topic, payload, expiry) {
        relays.push({ topic, reply: JSON.parse(payload), expiry });
      },
    },
    () => now,
  );
  const target = 'fcplcn-target',
    source = 'fcplcn-source',
    legacy = 'fcplcn-legacy';
  const send = (id: string, topic: string, value: unknown, retained = false) =>
    hub.receive('fcplcn/' + id + '/' + topic, JSON.stringify(value), retained);
  const heartbeat = (id: string, bootId = id + '-boot', sequence = 1, uptimeSec = 100) =>
    send(id, 'system/status', {
      deviceId: id,
      bootId,
      sequence,
      uptimeSec,
      product: 'FCPLCn',
      schemaVersion: 1,
      boardId: 'fcplcn-161608-1v0',
      firmwareVersion: 'test',
      socketCommandSequence: 0,
      lightCommandSequence: 0,
      thermostatCommandSequence: 0,
      securityCommandSequence: 0,
    });
  const tank = { id: 'rain', name: 'Запас', water: true };
  const report = (
    uptimeMs: number,
    water: boolean | null,
    retained = false,
    bootId = source + '-boot',
  ) =>
    send(
      source,
      'irrigation-water/source',
      { bootId, uptimeMs, items: [{ ...tank, water }] },
      retained,
    );
  const ask = (sequence: number, kept?: string[], bootId = target + '-boot', retained = false) => {
    relays.length = 0;
    send(target, 'irrigation-water/request', { bootId, sequence, sources: kept }, retained);
    return relays.map(({ reply }) => reply);
  };
  const known = (sequence: number) =>
    ask(sequence, [source + '/rain', 'fcplcn-unavailable/rain'])[0]?.water;

  assert.equal(validIrrigationTelemetry({ ...rule, tankId: source + '/rain' }), true);
  assert.equal(validIrrigationTelemetry({ ...rule, tankId: 'unregistered/rain' }), false);
  hub.setConnection(true);
  [target, source, legacy].forEach((id) => heartbeat(id));
  // A legacy device's visible tank level is never a safety input.
  send(
    legacy,
    'controllers/tanks/status',
    {
      bootId: legacy + '-boot',
      uptimeMs: 100_000,
      commandSequence: 0,
      enabled: true,
      items: [
        {
          id: 'rain',
          name: 'Старый бак',
          enabled: true,
          available: true,
          levelsWet: [true, true],
          levelPct: 100,
          pumpRelayId: '',
          valveRelayId: '',
          pumpActual: null,
          valveActual: null,
          error: null,
          levelInputs: ['in-0/1', 'in-0/2'],
          fillLevel: 2,
        },
      ],
    },
    true,
  );
  report(100_100, true, true);
  assert.equal(known(1), null);
  now = 1000;
  report(101_000, true);
  const list = ask(2, [source + '/rain', 'fcplcn-unavailable/rain', target + '/rain']);
  assert.deepEqual(
    list.map(({ source, id, sourceName, water }) => ({ source, id, sourceName, water })),
    [
      { source, id: 'rain', sourceName: 'Котельная', water: true },
      { source: 'fcplcn-unavailable', id: 'rain', sourceName: 'fcplcn-unavailable', water: null },
      { source: legacy, id: 'rain', sourceName: legacy, water: null },
    ],
  );
  assert.ok(
    relays.every(
      ({ topic, expiry }) =>
        topic === 'fcplcn/' + target + '/irrigation-water/reply' && expiry === 1,
    ),
  );
  send(target, 'controllers/irrigation/status', {
    bootId: target + '-boot',
    uptimeMs: 101_000,
    commandSequence: 0,
    enabled: true,
    items: [{ ...rule, tankId: source + '/rain' }],
  });
  const view = hub.snapshot().devices.find((device) => device.id === target);
  assert.equal(
    (view?.controllers.irrigation?.data.items as Record<string, unknown>[])[0]?.tankSourceLabel,
    'Котельная · Запас',
  );
  assert.deepEqual(ask(2), []);
  assert.deepEqual(ask(3), [], 'Excess request rate is capped');

  now = 2000;
  report(102_000, false);
  report(101_800, true);
  report(102_000, true);
  assert.equal(known(3), false);
  now = 4000;
  assert.equal(known(4), null, 'Freshness expires independently from the device dashboard');
  assert.deepEqual(ask(5, [], 'wrong-boot'), []);
  assert.deepEqual(ask(5, [], target + '-boot', true), []);
  now = 5000;
  report(103_100, true);
  assert.equal(known(5), true);
  now = 5500;
  hub.receive('fcplcn/' + source + '/availability', 'offline');
  assert.equal(known(6), null);
  now = 6000;
  heartbeat(source, source + '-boot', 2, 106);
  assert.equal(known(7), null, 'Online heartbeat alone does not revive an earlier wet sample');
  now = 6500;
  report(106_500, true);
  assert.equal(known(8), true);
  hub.setConnection(false);
  hub.setConnection(true);
  now = 7000;
  heartbeat(source, source + '-boot', 3, 107);
  heartbeat(target, target + '-boot', 2, 107);
  report(106_500, true);
  assert.equal(known(9), null, 'An equal sample after reconnect does not gain a new lifetime');
  now = 7500;
  heartbeat(source, 'new-source-boot', 1, 1);
  report(107_500, true);
  assert.equal(known(10), null, 'An old boot cannot authorize water');
  now = 8000;
  report(1500, true, false, 'new-source-boot');
  assert.equal(known(11), true);
  hub.close();
});
