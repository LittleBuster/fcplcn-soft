/** @file Registry regressions for replay protection, freshness and honest command outcomes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityActor, DeviceOutage } from '../shared/activity.js';
import type { CommandView, EngineOptions } from '../shared/types.js';
import { createEngine } from '../src/engine.js';
import { HubRegistry } from '../src/protocol/registry.js';

const id = 'fcplcn-test-plc';
const boot = 'boot-a';
const settings = (): EngineOptions => ({
  product: { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' },
  mode: 'mqtt',
  brokerUrl: 'mqtt://127.0.0.1:1',
  clientId: 'fcplcn-hub-test',
  staleAfterMs: 35_000,
  commandTimeoutMs: 1000,
  labels: {},
  onLabelsChanged() {},
});
const heartbeat = (sequence = 1, bootId = boot) => ({
  deviceId: id,
  product: 'FCPLCn',
  schemaVersion: 1,
  boardId: 'fcplcn-161608-1v0',
  firmwareVersion: 'test',
  bootId,
  sequence,
  uptimeSec: 100,
  socketCommandSequence: 4,
  lightCommandSequence: 0,
  thermostatCommandSequence: 0,
  securityCommandSequence: 0,
});
const sockets = (bootId = boot) => ({
  enabled: true,
  commandSequence: 7,
  bootId,
  uptimeMs: 100_000,
  items: [{ id: 'socket-1', name: 'Розетка', state: false, actual: false, available: true }],
});

function fixture(overrides: Partial<EngineOptions> = {}) {
  let time = 1000;
  const publications: { topic: string; payload: Record<string, unknown>; expirySeconds: number }[] =
    [];
  const options = { ...settings(), ...overrides };
  const registry = new HubRegistry(
    options,
    {
      async publish(topic, payload, expirySeconds) {
        publications.push({ topic, payload: JSON.parse(payload), expirySeconds });
      },
    },
    () => time,
    () => new Date(time).toISOString(),
  );
  const receive = (suffix: string, value: unknown, retained = false) =>
    registry.receive(`fcplcn/${id}/${suffix}`, JSON.stringify(value), retained);
  const live = () => {
    receive('system/status', heartbeat());
    receive('controllers/sockets/status', sockets());
  };
  registry.setConnection(true);
  return {
    registry,
    publications,
    receive,
    live,
    advance: (delta: number) => {
      time += delta;
    },
    options,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('retained snapshots display state without authorizing operative commands', async () => {
  const f = fixture();
  try {
    f.receive('system/status', heartbeat(), true);
    f.receive('controllers/sockets/status', sockets(), true);
    assert.equal(f.registry.snapshot().devices[0].status, 'stale');
    assert.equal(f.registry.snapshot().devices[0].controllers.sockets!.fresh, false);
    await assert.rejects(f.registry.command(id, 'sockets', 'socket-1', true), /свежих/);
    f.receive('system/status', heartbeat(2));
    assert.equal(f.registry.snapshot().devices[0].online, true);
    await assert.rejects(f.registry.command(id, 'sockets', 'socket-1', true), /свежих/);
    f.receive('controllers/sockets/status', sockets());
    assert.equal(f.registry.snapshot().devices[0].controllers.sockets!.fresh, true);
  } finally {
    f.registry.close();
  }
});

test('malformed, oversized, foreign and poison JSON do not discover a PLC', () => {
  const f = fixture();
  try {
    for (const value of [
      '{',
      '[]',
      'null',
      JSON.stringify({ ...heartbeat(), product: 'Other' }),
      JSON.stringify({ ...heartbeat(), sequence: -1 }),
      '{"__proto__":{"online":true}}',
      'x'.repeat(65_537),
    ])
      f.registry.receive(`fcplcn/${id}/system/status`, value);
    f.registry.receive('fcplcn/__proto__/availability', 'online');
    f.registry.receive(`fcplcn/${id}/system/status/extra`, JSON.stringify(heartbeat()));
    assert.equal(f.registry.snapshot().devices.length, 0);
    assert.equal(({} as { online?: boolean }).online, undefined);
  } finally {
    f.registry.close();
  }
});

test('hourly history observes only live meteo packets from the current online PLC boot', () => {
  const collected: string[] = [];
  const f = fixture({ onMeteo: (deviceId) => collected.push(deviceId) });
  const meteo = { enabled: true, bootId: boot, uptimeMs: 100_000, items: [] };
  try {
    f.receive('system/status', heartbeat(), true);
    f.receive('controllers/meteo/status', meteo);
    f.receive('system/status', heartbeat(2));
    f.receive('controllers/meteo/status', meteo, true);
    f.receive('controllers/meteo/status', { ...meteo, bootId: 'other-boot' });
    f.receive('controllers/meteo/status', { ...meteo, enabled: false });
    assert.deepEqual(collected, []);
    f.receive('controllers/meteo/status', meteo);
    assert.deepEqual(collected, [id]);
  } finally {
    f.registry.close();
  }
});

test('registry bounds the number of discovered devices', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 300; index++)
      f.registry.receive(`fcplcn/fcplcn-test-${index}/availability`, 'online', true);
    assert.equal(f.registry.snapshot().devices.length, 256);
  } finally {
    f.registry.close();
  }
});

test('duplicate and out-of-order heartbeats do not extend freshness', async () => {
  const f = fixture();
  try {
    f.live();
    f.advance(34_000);
    f.receive('system/status', heartbeat());
    f.advance(2000);
    assert.equal(f.registry.snapshot().devices[0].online, false);
    f.receive('system/status', { ...heartbeat(2), uptimeSec: 99 });
    assert.equal(f.registry.snapshot().devices[0].online, false);
    await assert.rejects(f.registry.command(id, 'sockets', 'socket-1', true), /свежих/);
    assert.equal(f.publications.length, 0);
  } finally {
    f.registry.close();
  }
});

test('outages record heartbeat expiry and reconnect only on a fresh validated PLC heartbeat', () => {
  const updates: DeviceOutage[] = [];
  const f = fixture({ activity: { outageChanged: (row) => updates.push(row) } });
  const presence = (state: string, retained = false) =>
    f.registry.receive(`fcplcn/${id}/availability`, state, retained);
  try {
    presence('offline', true);
    assert.equal(updates.length, 0);
    f.live();
    f.advance(35_001);
    f.registry.checkOutages();
    f.registry.checkOutages();
    const [timeout] = updates;
    assert.equal(updates.length, 1);
    assert.equal(timeout.reason, 'timeout');
    assert.equal(timeout.offlineAt, new Date(36_001).toISOString());
    assert.equal(timeout.onlineAt, null);

    f.advance(2000);
    presence('online');
    f.receive('system/status', heartbeat(2), true);
    f.receive('system/status', heartbeat());
    assert.equal(updates.length, 1);
    f.receive('system/status', heartbeat(2));
    assert.deepEqual(updates[1], { ...timeout, onlineAt: new Date(38_001).toISOString() });
    presence('offline');
    presence('offline');
    assert.equal(updates.length, 3);
    assert.equal(updates[2].reason, 'availability');
    assert.equal(updates[2].onlineAt, null);
    assert.notEqual(updates[2].id, timeout.id);
    f.advance(1000);
    f.receive('system/status', heartbeat(3));
    assert.deepEqual(updates[3], { ...updates[2], onlineAt: new Date(39_001).toISOString() });

    f.registry.setConnection(false);
    f.advance(35_001);
    f.registry.checkOutages();
    f.registry.setConnection(true);
    f.registry.checkOutages();
    assert.equal(updates.length, 4, 'broker reconnect must never create or recover an outage');
    assert.deepEqual(f.registry.snapshot().outages, [updates[3], updates[1]]);
  } finally {
    f.registry.close();
  }
});

test('a persisted outage resumes through hub restart and records recovery under the same id', () => {
  const stored: DeviceOutage = {
    id: 'existing-outage',
    deviceId: id,
    deviceName: 'Тестовый PLC',
    offlineAt: new Date(500).toISOString(),
    onlineAt: null,
    reason: 'availability',
  };
  const updates: DeviceOutage[] = [];
  const f = fixture({ activity: { outages: [stored], outageChanged: (row) => updates.push(row) } });
  try {
    f.registry.receive(`fcplcn/${id}/availability`, 'offline');
    f.receive('system/status', heartbeat(), true);
    assert.equal(updates.length, 0);
    assert.deepEqual(f.registry.snapshot().outages, [stored]);
    f.advance(1000);
    f.receive('system/status', heartbeat(2));
    assert.deepEqual(updates, [{ ...stored, onlineAt: new Date(2000).toISOString() }]);
    assert.deepEqual(f.registry.snapshot().outages, updates);
  } finally {
    f.registry.close();
  }
});

test('journal records actor before dispatch and records only acknowledged PLC results', async () => {
  const actor: ActivityActor = { source: 'telegram', name: 'Оператор', id: 'actor-1' };
  const commands: CommandView[] = [];
  const start = deferred();
  const finish = deferred();
  const finishing = deferred();
  const f = fixture({
    commandTimeoutMs: 10_000,
    activity: {
      context: () => ({ actor, sceneRunId: 'run-1' }),
      async commandStarted(command) {
        commands.push(command);
        await start.promise;
      },
      async commandFinished(command) {
        commands.push(command);
        finishing.resolve();
        await finish.promise;
      },
    },
  });
  try {
    f.live();
    const result = f.registry.command(id, 'sockets', 'socket-1', true);
    await assert.rejects(f.registry.command(id, 'sockets', 'socket-1', false), /Предыдущая/);
    assert.equal(f.publications.length, 0);
    assert.deepEqual(commands[0].actor, actor);
    assert.equal(commands[0].deviceName, id);
    assert.equal(commands[0].sceneRunId, 'run-1');
    assert.equal(commands[0].completedAt, null);
    const ack = { ok: true, bootId: boot, sequence: 8, id: 'socket-1', value: true };
    f.receive('controllers/sockets/ack', ack);
    assert.equal(f.registry.snapshot().commands[0].status, 'pending');
    start.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.publications.length, 1);
    f.advance(12);
    f.receive('controllers/sockets/ack', ack);
    await finishing.promise;
    assert.deepEqual(commands[1], {
      ...commands[0],
      status: 'applied',
      completedAt: new Date(1012).toISOString(),
    });
    finish.resolve();
    assert.deepEqual(await result, commands[1]);
  } finally {
    start.resolve();
    finish.resolve();
    f.registry.close();
    await f.registry.flushActivity();
  }
});

test('waiting on the journal cannot publish a command across broker reconnection', async () => {
  const events: string[] = [];
  const start = deferred();
  const f = fixture({
    activity: {
      async commandStarted() {
        await start.promise;
        events.push('start');
      },
      async commandFinished(command) {
        events.push(command.status);
      },
    },
  });
  try {
    f.live();
    const result = f.registry.command(id, 'sockets', 'socket-1', true);
    f.registry.setConnection(false);
    f.registry.setConnection(true);
    f.receive('system/status', heartbeat(2));
    f.receive('controllers/sockets/status', sockets());
    assert.equal((await result).status, 'rejected');
    assert.deepEqual(events, []);
    start.resolve();
    await f.registry.flushActivity();
    assert.deepEqual(events, ['start', 'rejected']);
    assert.equal(f.publications.length, 0);
  } finally {
    start.resolve();
    f.registry.close();
    await f.registry.flushActivity();
  }
});

test('command sequences start above both firmware counters and ACKs match every field', async () => {
  const f = fixture();
  try {
    f.live();
    const result = f.registry.command(id, 'sockets', 'socket-1', true);
    const packet = f.publications[0].payload;
    assert.equal(packet.sequence, 8);
    assert.equal(packet.bootId, boot);
    assert.equal(packet.expiresAtUptimeMs, 104_000);
    assert.equal(
      f.registry.snapshot().devices[0].controllers.sockets!.data.items instanceof Array,
      true,
    );
    assert.equal(
      (
        f.registry.snapshot().devices[0].controllers.sockets!.data.items as Record<
          string,
          unknown
        >[]
      )[0].actual,
      false,
      'SET cannot optimistically invent output state',
    );
    await assert.rejects(f.registry.command(id, 'sockets', 'socket-1', false), /Предыдущая/);
    const ack = { ok: true, bootId: boot, sequence: 8, id: 'socket-1', value: true };
    for (const wrong of [
      { ...ack, bootId: 'old-boot' },
      { ...ack, sequence: 9 },
      { ...ack, id: 'other' },
      { ...ack, value: false },
    ])
      f.receive('controllers/sockets/ack', wrong);
    f.receive('controllers/sockets/ack', ack, true);
    assert.equal(f.registry.snapshot().commands[0].status, 'pending');
    f.receive('controllers/sockets/ack', ack);
    assert.equal((await result).status, 'applied');
    assert.equal(
      (
        f.registry.snapshot().devices[0].controllers.sockets!.data.items as Record<
          string,
          unknown
        >[]
      )[0].actual,
      false,
    );
    const next = f.registry.command(id, 'sockets', 'socket-1', false);
    assert.equal(f.publications[1].payload.sequence, 9);
    f.receive('controllers/sockets/ack', {
      ...ack,
      sequence: 9,
      value: false,
      ok: false,
      error: 'Реле недоступно',
    });
    assert.equal((await next).status, 'rejected');
  } finally {
    f.registry.close();
  }
});

test('ACK timeout stays unknown even when an old confirmation arrives later', async () => {
  const f = fixture({ commandTimeoutMs: 5 });
  try {
    f.live();
    assert.equal((await f.registry.command(id, 'sockets', 'socket-1', true)).status, 'unknown');
    f.receive('controllers/sockets/ack', {
      ok: true,
      bootId: boot,
      sequence: 8,
      id: 'socket-1',
      value: true,
    });
    assert.equal(f.registry.snapshot().commands[0].status, 'unknown');
  } finally {
    f.registry.close();
  }
});

test('a stalled transport write cannot bypass the bounded command deadline', async () => {
  const registry = new HubRegistry(
    { ...settings(), commandTimeoutMs: 5 },
    {
      publish: () => new Promise<void>(() => {}),
    },
  );
  registry.setConnection(true);
  registry.receive(`fcplcn/${id}/system/status`, JSON.stringify(heartbeat()));
  registry.receive(`fcplcn/${id}/controllers/sockets/status`, JSON.stringify(sockets()));
  try {
    const result = await registry.command(id, 'sockets', 'socket-1', true);
    assert.equal(result.status, 'unknown');
  } finally {
    registry.close();
  }
});

test('a late failure of an old write cannot cancel the following command', async () => {
  let rejectOldWrite!: (error: Error) => void;
  let calls = 0;
  const registry = new HubRegistry(settings(), {
    publish: () =>
      ++calls === 1
        ? new Promise<void>((_, reject) => {
            rejectOldWrite = reject;
          })
        : Promise.resolve(),
  });
  registry.setConnection(true);
  registry.receive(`fcplcn/${id}/system/status`, JSON.stringify(heartbeat()));
  registry.receive(`fcplcn/${id}/controllers/sockets/status`, JSON.stringify(sockets()));
  try {
    const old = registry.command(id, 'sockets', 'socket-1', true);
    registry.receive(
      `fcplcn/${id}/controllers/sockets/ack`,
      JSON.stringify({ ok: true, bootId: boot, sequence: 8, id: 'socket-1', value: true }),
    );
    assert.equal((await old).status, 'applied');
    const next = registry.command(id, 'sockets', 'socket-1', false);
    rejectOldWrite(new Error('Late write callback'));
    await Promise.resolve();
    assert.equal(registry.snapshot().commands[0].status, 'pending');
    registry.receive(
      `fcplcn/${id}/controllers/sockets/ack`,
      JSON.stringify({ ok: true, bootId: boot, sequence: 9, id: 'socket-1', value: false }),
    );
    assert.equal((await next).status, 'applied');
  } finally {
    registry.close();
  }
});

test('disconnect aborts outstanding work and reconnect never replays it', async () => {
  const f = fixture();
  try {
    f.live();
    const result = f.registry.command(id, 'sockets', 'socket-1', true);
    f.registry.setConnection(false);
    assert.equal((await result).status, 'unknown');
    f.registry.setConnection(true);
    await assert.rejects(f.registry.command(id, 'sockets', 'socket-1', true), /свежих/);
    f.receive('system/status', heartbeat(), true);
    f.receive('controllers/sockets/status', sockets(), true);
    await assert.rejects(f.registry.command(id, 'sockets', 'socket-1', true), /свежих/);
    assert.equal(f.publications.length, 1);
  } finally {
    f.registry.close();
  }
});

test('an older retained reconnect cache cannot lower the heartbeat sequence barrier', () => {
  const f = fixture();
  try {
    f.receive('system/status', heartbeat(10));
    f.receive('controllers/sockets/status', sockets());
    f.registry.setConnection(false);
    f.registry.setConnection(true);
    f.receive('system/status', heartbeat(2), true);
    f.receive('system/status', heartbeat(9));
    assert.equal(f.registry.snapshot().devices[0].online, false);
    f.receive('system/status', heartbeat(11));
    assert.equal(f.registry.snapshot().devices[0].online, true);
    assert.equal(f.registry.snapshot().devices[0].controllers.sockets!.fresh, false);
  } finally {
    f.registry.close();
  }
});

test('PLC reboot invalidates pending commands and retires the old boot identity', async () => {
  const f = fixture();
  try {
    f.live();
    const result = f.registry.command(id, 'sockets', 'socket-1', true);
    f.receive('system/status', { ...heartbeat(1, 'boot-b'), socketCommandSequence: 0 });
    assert.equal((await result).status, 'unknown');
    assert.equal(f.registry.snapshot().devices[0].controllers.sockets!.fresh, false);
    f.receive('system/status', heartbeat(2));
    assert.equal(f.registry.snapshot().devices[0].bootId, 'boot-b');
    f.receive('controllers/sockets/status', { ...sockets('boot-b'), commandSequence: 0 });
    const newResult = f.registry.command(id, 'sockets', 'socket-1', false);
    assert.equal(f.publications[1].payload.sequence, 1);
    f.receive('controllers/sockets/ack', {
      ok: true,
      bootId: 'boot-b',
      sequence: 1,
      id: 'socket-1',
      value: false,
    });
    assert.equal((await newResult).status, 'applied');
  } finally {
    f.registry.close();
  }
});

test('local name persistence is transactional and does not leak private MQTT fields', () => {
  let fail = false;
  const f = fixture({
    onLabelsChanged() {
      if (fail) throw new Error('Disk full');
    },
  });
  try {
    f.live();
    f.registry.rename(id, 'Гостиная', 'Дом');
    fail = true;
    assert.throws(() => f.registry.rename(id, 'Не сохранено', 'Двор'), /Disk full/);
    assert.equal(f.registry.snapshot().devices[0].name, 'Гостиная');
    f.receive('controllers/security/status', {
      enabled: true,
      items: [],
      commandSequence: 0,
      bootId: boot,
      uptimeMs: 100_000,
      keys: [{ address: 'secret-key' }],
      nested: { password: 'secret-pass' },
      armed: false,
    });
    assert.equal(JSON.stringify(f.registry.snapshot()).includes('secret-'), false);
  } finally {
    f.registry.close();
  }
});

test('availability loss cannot leave a cached live PLC commandable', async () => {
  const f = fixture();
  try {
    f.live();
    f.registry.receive(`fcplcn/${id}/availability`, 'offline');
    assert.equal(f.registry.snapshot().devices[0].status, 'offline');
    await assert.rejects(f.registry.command(id, 'sockets', 'socket-1', true), /свежих/);
  } finally {
    f.registry.close();
  }
});

test('demo starts without a broker and updates actual output only with simulated acknowledgement', async () => {
  // The acknowledgement includes loopback HTTP and persistence. Allow CPU
  // emulation to finish while keeping the state-before/after-ACK assertions.
  const engine = createEngine({ ...settings(), mode: 'demo', commandTimeoutMs: 10_000 });
  await engine.start();
  try {
    assert.equal(engine.snapshot().devices.length, 3);
    const device = engine.snapshot().devices.find((device) => device.id === 'fcplcn-demo-living')!;
    assert.equal(device.online, true);
    const command = engine.command(device.id, 'lights', 'light-main', false);
    assert.equal(
      (
        engine.snapshot().devices.find((device) => device.id === 'fcplcn-demo-living')!.controllers
          .lights!.data.items as Record<string, unknown>[]
      )[0].actual,
      true,
    );
    assert.equal((await command).status, 'applied');
    assert.equal(
      (
        engine.snapshot().devices.find((device) => device.id === 'fcplcn-demo-living')!.controllers
          .lights!.data.items as Record<string, unknown>[]
      )[0].actual,
      false,
    );
  } finally {
    await engine.stop();
  }
});
