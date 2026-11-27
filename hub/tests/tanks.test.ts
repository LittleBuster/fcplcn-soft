/** @file Tank transport validation, monitoring permissions and remote control boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { validTankTelemetry } from '../shared/tanks.js';
import { cloudPermitted, cloudRoute } from '../shared/cloud.js';
import { serviceRoute } from '../src/protocol/management.js';
import { HubRegistry } from '../src/protocol/registry.js';
import type { EngineOptions } from '../shared/types.js';

function tank(wet: (boolean | null)[], level: number | null, available = level !== null) {
  return {
    id: 'tank-water',
    name: 'Бак',
    enabled: true,
    available,
    pumpRelayId: 'rly-0/1',
    valveRelayId: 'rly-0/2',
    levelInputs: wet.map((_, i) => `in-0/${i + 1}`),
    fillLevel: wet.length,
    levelsWet: wet,
    levelPct: level,
    pumpActual: false,
    valveActual: false,
    error: null,
  };
}

test('Tank telemetry accepts discrete one/two/three-level estimates and rejects misleading measurements', () => {
  for (const wet of [
    [false],
    [true],
    [false, false],
    [true, false],
    [true, true],
    [false, false, false],
    [true, false, false],
    [true, true, false],
    [true, true, true],
  ]) {
    assert.equal(
      validTankTelemetry(tank(wet, Math.round((100 * wet.filter(Boolean).length) / wet.length))),
      true,
    );
  }
  assert.equal(validTankTelemetry(tank([null, null], null)), true);
  assert.equal(
    validTankTelemetry(tank([false, true], null, false)),
    true,
    'A reported PLC fault remains visible as unknown',
  );
  for (const row of [
    tank([false, true], 50),
    tank([true, false, false], 34),
    tank([true, true], 50),
    { ...tank([true, false], 50), levelInputs: ['in-0/1', 'in-0/1'] },
    { ...tank([true, false], 50), pumpActual: 'on' },
    { ...tank([true, false], 50), error: {} },
    { ...tank([true, false], 50), enabled: false },
    { ...tank([true, false], 50), error: 'Неисправность выхода' },
    tank([true, null], 50),
  ])
    assert.equal(validTankTelemetry(row), false);
});

test('Tank service paths and cloud roles separate monitoring control from wiring edits', () => {
  assert.equal(serviceRoute('GET', '/controllers/tanks'), true);
  assert.equal(serviceRoute('POST', '/controllers/tanks'), true);
  assert.equal(serviceRoute('POST', '/controllers/tanks/enabled'), true);
  assert.equal(serviceRoute('POST', '/controllers/tanks/state'), false);
  const path = '/devices/fcplcn-test/service/controllers/tanks';
  assert.equal(cloudRoute('GET', path), true);
  for (const role of ['owner', 'operator', 'viewer'] as const) {
    const actor = { userId: 'test', role };
    assert.equal(cloudPermitted(actor, 'POST', path, {}), role === 'owner');
    assert.equal(
      cloudPermitted(actor, 'POST', '/devices/fcplcn-test/commands', {
        controller: 'tanks',
        itemId: 'tank-water',
        value: true,
      }),
      role !== 'viewer',
    );
  }
});

test('Monitoring SET requires live evidence, is explicitly acknowledged and never invents pump/valve state', async () => {
  const publications: { topic: string; payload: Record<string, unknown> }[] = [];
  const options: EngineOptions = {
    product: { id: 'fcplcn', name: 'FCPLCn', fullName: 'Future City PLC Next' },
    mode: 'mqtt',
    brokerUrl: 'mqtt://127.0.0.1:1',
    clientId: 'tank-test',
    staleAfterMs: 35000,
    commandTimeoutMs: 1000,
    labels: {},
    onLabelsChanged() {},
  };
  const registry = new HubRegistry(options, {
    async publish(topic, payload) {
      publications.push({ topic, payload: JSON.parse(payload) });
    },
  });
  const receive = (path: string, data: unknown, retained = false) =>
    registry.receive('fcplcn/fcplcn-test/' + path, JSON.stringify(data), retained);
  const heartbeat = {
    deviceId: 'fcplcn-test',
    product: 'FCPLCn',
    schemaVersion: 1,
    boardId: 'fcplcn-161608-1v0',
    firmwareVersion: 'test',
    bootId: 'tank-boot',
    sequence: 1,
    uptimeSec: 100,
    socketCommandSequence: 0,
    lightCommandSequence: 0,
    thermostatCommandSequence: 0,
    securityCommandSequence: 0,
    tankCommandSequence: 5,
  };
  const status = {
    enabled: true,
    bootId: 'tank-boot',
    uptimeMs: 100000,
    commandSequence: 5,
    items: [{ ...tank([null, null], null), enabled: false }],
  };
  registry.setConnection(true);
  try {
    receive('system/status', heartbeat, true);
    receive('controllers/tanks/status', status, true);
    await assert.rejects(registry.command('fcplcn-test', 'tanks', 'tank-water', true), /свежих/);
    receive('system/status', { ...heartbeat, sequence: 2 });
    receive('controllers/tanks/status', status);
    const pending = registry.command('fcplcn-test', 'tanks', 'tank-water', true);
    await setImmediate();
    assert.equal(publications.length, 1);
    assert.match(publications[0].topic, /\/controllers\/tanks\/set$/);
    const packet = publications[0].payload;
    assert.equal(packet.sequence, 6);
    assert.equal(packet.value, true);
    receive('controllers/tanks/ack', {
      bootId: 'tank-boot',
      sequence: packet.sequence,
      id: 'tank-water',
      value: true,
      ok: true,
    });
    assert.equal((await pending).status, 'applied');
    const actual = registry.snapshot().devices[0].controllers.tanks!.data.items as Record<
      string,
      unknown
    >[];
    assert.equal(actual[0].pumpActual, false);
    assert.equal(actual[0].valveActual, false);
    assert.equal(actual[0].enabled, false, 'An ACK is distinct from new telemetry');
    receive('availability', 'offline');
  } finally {
    registry.close();
  }
});
