/** @file Ephemeral iButton source authority, conservative deadlines and autonomous demo fallback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HubRegistry } from '../src/protocol/registry.js';
import { createEngine } from '../src/engine.js';
import type { EngineOptions } from '../shared/types.js';
import type {
  SecurityCommandFence,
  SecurityLeasePacket,
  SecurityTouchEvent,
  SecurityTouchPacket,
} from '../shared/security-sync.js';

const deviceId = 'fcplcn-security-test';
const options = (): EngineOptions => ({
  product: { id: 'fcplcn', name: 'FCPLCn', fullName: 'Future City PLC Next' },
  mode: 'mqtt',
  brokerUrl: 'mqtt://127.0.0.1:1',
  clientId: 'fcplcn-security-unit',
  staleAfterMs: 35000,
  commandTimeoutMs: 500,
  labels: {},
  onLabelsChanged() {},
});
function fixture() {
  let now = 0;
  const publications: { topic: string; body: Record<string, unknown>; expiry: number }[] = [];
  const events: SecurityTouchEvent[] = [];
  const registry = new HubRegistry(
    options(),
    {
      async publish(topic, payload, expiry) {
        publications.push({ topic, body: JSON.parse(payload), expiry });
      },
    },
    () => now,
  );
  registry.onSecurityTouch((event) => events.push(event));
  registry.setConnection(true);
  function receive(suffix: string, data: unknown, retained = false) {
    registry.receive(`fcplcn/${deviceId}/${suffix}`, JSON.stringify(data), retained);
  }
  function live(sequence = 1, bootId = 'boot-a', uptimeMs = 100000) {
    receive('system/status', {
      deviceId,
      product: 'FCPLCn',
      schemaVersion: 1,
      bootId,
      sequence,
      uptimeSec: Math.floor(uptimeMs / 1000),
      boardId: 'test',
      firmwareVersion: 'test',
      socketCommandSequence: 0,
      lightCommandSequence: 0,
      thermostatCommandSequence: 0,
      securityCommandSequence: 0,
    });
    receive('controllers/security/status', {
      bootId,
      uptimeMs,
      enabled: true,
      armed: false,
      readyToArm: true,
      commandSequence: 0,
      hubSync: { version: 1 },
      items: [{ id: 'zone-1', name: 'Дверь' }],
    });
  }
  live();
  const lease = (touchArmed = true, busy = false, modeRevision = 7) =>
    registry.sendSecurityLease(deviceId, { hubEpoch: 'hub-epoch', modeRevision, touchArmed, busy });
  const touch = (
    fence: SecurityCommandFence,
    eventSequence: number,
    patch: Partial<SecurityTouchPacket> = {},
  ) => ({
    schemaVersion: 1 as const,
    bootId: 'boot-a',
    ...fence,
    eventSequence,
    eventAtUptimeMs: 100000 + now,
    value: true,
    keyId: 'key-1',
    keyName: 'Ключ дома',
    localApplied: true,
    ...patch,
  });
  return {
    registry,
    publications,
    events,
    receive,
    live,
    lease,
    touch,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test('iButton events require an issued fresh lease, exact target and source sequence; busy consumes without a second toggle', async () => {
  const f = fixture();
  try {
    const first = await f.lease();
    assert.equal(f.publications[0].topic, `fcplcn/${deviceId}/controllers/security/hub`);
    assert.equal(f.publications[0].expiry, 4);
    assert.equal(f.publications[0].body.expiresAtUptimeMs, 104000);
    const valid = f.touch(first, 1, { localApplied: false });
    f.receive('controllers/security/event', valid, true);
    for (const patch of [
      { bootId: 'retired' },
      { modeRevision: 6 },
      { leaseSequence: 99 },
      { value: false },
      { eventAtUptimeMs: 105000 },
      { password: 'forbidden' },
    ])
      f.receive('controllers/security/event', { ...valid, ...patch });
    assert.equal(f.events.length, 0);
    f.receive('controllers/security/event', valid);
    assert.equal(
      f.events.length,
      1,
      'A real authorized intention propagates even when the source rejected its own relay action',
    );
    assert.equal(f.events[0].localApplied, false);
    f.receive('controllers/security/event', valid);
    assert.equal(f.events.length, 1);
    f.advance(10);
    await f.lease();
    f.receive('controllers/security/event', f.touch(first, 2));
    assert.equal(
      f.events.length,
      2,
      'A pulse arriving after a physical touch does not discard the same fresh intention',
    );
    const busy = await f.lease(true, true);
    f.receive('controllers/security/event', f.touch(busy, 3, { localApplied: false }));
    assert.equal(f.events.length, 2);
    const ready = await f.lease();
    f.receive('controllers/security/event', f.touch(ready, 3));
    assert.equal(
      f.events.length,
      2,
      'A held/busy contact cannot replay after the scenario completes',
    );
    f.receive('controllers/security/event', f.touch(ready, 4));
    assert.equal(f.events.length, 3);
    const next = await f.lease(false, false, 8);
    f.receive('controllers/security/event', f.touch(ready, 5));
    assert.equal(f.events.length, 3);
    f.receive('controllers/security/event', f.touch(next, 5, { value: false }));
    assert.equal(f.events.length, 4);
    await assert.rejects(
      f.registry.command(deviceId, 'security', 'alarm', false, undefined, ready),
      /устарела/,
    );
    const command = f.registry.command(deviceId, 'security', 'alarm', false, undefined, next);
    const sent = f.publications.at(-1)!.body;
    assert.equal(sent.hubEpoch, next.hubEpoch);
    assert.equal(sent.leaseSequence, next.leaseSequence);
    assert.ok(
      (sent.expiresAtUptimeMs as number) <=
        (f.publications.at(-2)!.body as unknown as SecurityLeasePacket).expiresAtUptimeMs,
    );
    f.receive('controllers/security/ack', {
      bootId: 'boot-a',
      id: 'alarm',
      value: false,
      sequence: sent.sequence,
      ok: true,
    });
    assert.equal((await command).status, 'applied');
  } finally {
    f.registry.close();
  }
});

test('reconnect, device boot and expired event deadlines retire all previous authority without lease sequence reuse', async () => {
  const f = fixture();
  try {
    const first = await f.lease();
    f.registry.setConnection(false);
    f.registry.setConnection(true);
    await assert.rejects(f.lease(), /свежего/);
    f.live(2);
    const second = await f.lease();
    assert.ok(second.leaseSequence > first.leaseSequence);
    f.receive('controllers/security/event', f.touch(first, 1));
    assert.equal(f.events.length, 0);
    f.receive('controllers/security/event', f.touch(second, 2));
    assert.equal(f.events.length, 1);
    f.advance(1600);
    f.receive('controllers/security/event', f.touch(second, 3, { eventAtUptimeMs: 100000 }));
    assert.equal(
      f.events.length,
      1,
      'An old source event is rejected inside an otherwise live lease',
    );
    f.advance(2500);
    f.receive('controllers/security/event', f.touch(second, 4));
    assert.equal(f.events.length, 1);
    await assert.rejects(
      f.registry.command(deviceId, 'security', 'alarm', false, undefined, second),
      /устарела/,
    );
    f.live(1, 'boot-b', 1000);
    const fresh = await f.lease();
    f.receive('controllers/security/event', f.touch(fresh, 5));
    assert.equal(f.events.length, 1, 'Old device boot cannot impersonate a new lease');
    f.receive(
      'controllers/security/event',
      f.touch(fresh, 1, { bootId: 'boot-b', eventAtUptimeMs: 1000 }),
    );
    assert.equal(f.events.length, 2);
  } finally {
    f.registry.close();
  }
});

test('connection generation remembers an offline/online interval even when no coordinator poll observes it', () => {
  const f = fixture();
  try {
    const before = f.registry.snapshot().devices[0].connectionGeneration!;
    f.registry.receive(`fcplcn/${deviceId}/availability`, 'online');
    f.live(2);
    assert.equal(
      f.registry.snapshot().devices[0].connectionGeneration,
      before,
      'Normal telemetry and repeated online announcements do not create recovery',
    );
    f.registry.receive(`fcplcn/${deviceId}/availability`, 'offline');
    f.registry.receive(`fcplcn/${deviceId}/availability`, 'online');
    f.live(3);
    const returned = f.registry.snapshot().devices[0];
    assert.equal(returned.online, true);
    assert.ok(
      returned.connectionGeneration! > before,
      'The entire missed offline interval remains visible in the next live snapshot',
    );
    const recovered = returned.connectionGeneration!;
    f.registry.setConnection(false);
    f.registry.setConnection(true);
    f.live(4);
    assert.ok(
      f.registry.snapshot().devices[0].connectionGeneration! > recovered,
      'Broker reconnect also retires captured command generations',
    );
  } finally {
    f.registry.close();
  }
});

test('a delayed status cannot roll back the issued lease clock and revive a source event', async () => {
  const f = fixture();
  try {
    const lease = await f.lease();
    f.advance(1200);
    const delayed = f.touch(lease, 1);
    f.advance(2000);
    f.live(2, 'boot-a', 100900);
    f.receive('controllers/security/event', delayed);
    assert.equal(
      f.events.length,
      0,
      'An older sample received later cannot hide two seconds of source age',
    );
    f.receive('controllers/security/event', f.touch(lease, 2));
    assert.equal(
      f.events.length,
      1,
      'A genuinely current source event remains valid under the same lease',
    );
  } finally {
    f.registry.close();
  }
});

test('demo authorized iButton follows the debounced PLC source path, works locally without a hub lease and consumes held contacts once', async () => {
  const engine = createEngine({ ...options(), mode: 'demo' });
  const events: SecurityTouchEvent[] = [];
  engine.onSecurityTouch!((event) => events.push(event));
  try {
    await engine.start();
    const id = 'fcplcn-demo-garage';
    assert.equal((await engine.demoSecurityTouch!(id, 'not-authorized')).status, 409);
    const local = await engine.demoSecurityTouch!(id);
    assert.equal(local.status, 200);
    assert.equal((local.data as { localApplied: boolean }).localApplied, true);
    assert.equal((local.data as { accepted: boolean }).accepted, false);
    assert.equal(events.length, 0);
    await engine.sendSecurityLease!(id, {
      hubEpoch: 'demo-hub',
      modeRevision: 0,
      touchArmed: true,
      busy: false,
    });
    const touch = await engine.demoSecurityTouch!(id);
    assert.equal(touch.status, 200);
    assert.equal(events.length, 1, 'Five held source samples emit exactly one event');
    assert.equal(events[0].value, true);
    assert.equal(events[0].keyId, 'demo-key');
    await engine.sendSecurityLease!(id, {
      hubEpoch: 'demo-hub',
      modeRevision: 1,
      touchArmed: false,
      busy: true,
    });
    const busy = await engine.demoSecurityTouch!(id);
    assert.equal((busy.data as { ignored: boolean }).ignored, true);
    assert.equal(events.length, 1);
    assert.equal(
      engine.snapshot().devices.find((row) => row.id === id)!.controllers.security!.data.armed,
      true,
    );
    await engine.sendSecurityLease!(id, {
      hubEpoch: 'demo-hub',
      modeRevision: 1,
      touchArmed: false,
      busy: false,
    });
    await engine.demoSecurityTouch!(id);
    assert.equal(events.length, 2);
    assert.ok(events[1].eventSequence > events[0].eventSequence);
    assert.equal(events[1].value, false);
  } finally {
    await engine.stop();
  }
});
