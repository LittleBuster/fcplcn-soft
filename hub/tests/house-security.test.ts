/** @file Whole-house key intents, immediate extras and current-state recovery without scene replay. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HubEngine,
  EngineSnapshot,
  DeviceView,
  CommandView,
  WritableControllerKind,
  SecurityCommandFence,
  SecurityLeaseInput,
  SecurityTouchEvent,
} from '../shared/types.js';
import { Scenes } from '../server/scenes.js';
import { HouseSecurity } from '../server/house-security.js';
import { HubControl } from '../server/control.js';

const product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };
function device(id: string, armed = true): DeviceView {
  return {
    id,
    name: id,
    room: '',
    boardId: 'fcplcn-161608-1v0',
    firmwareVersion: 'test',
    bootId: 'boot-' + id,
    online: true,
    status: 'online',
    lastSeenAt: new Date().toISOString(),
    uptimeSec: 100,
    controllers: {
      security: {
        kind: 'security',
        fresh: true,
        receivedAt: 'sample-1',
        data: {
          enabled: true,
          readyToArm: true,
          armed,
          triggered: false,
          items: [{ id: 'door', name: 'Дверь', available: true }],
        },
      },
      sockets: {
        kind: 'sockets',
        fresh: true,
        receivedAt: 'sample-1',
        data: {
          enabled: true,
          items: [{ id: 'contactor', name: 'Контактор', available: true, actual: true }],
        },
      },
    },
  };
}
class Engine implements HubEngine {
  readonly state: EngineSnapshot = {
    broker: { connected: true, error: null },
    devices: [device('fcplcn-a'), device('fcplcn-b')],
    commands: [],
  };
  readonly leases = new Map<string, SecurityLeaseInput & SecurityCommandFence>();
  readonly calls: {
    deviceId: string;
    controller: WritableControllerKind;
    value: boolean;
    timeout?: number;
    fence?: SecurityCommandFence;
  }[] = [];
  private handlers = new Set<(event: SecurityTouchEvent) => void>();
  private sequence = 0;
  private eventSequence = 0;
  hook?: (
    deviceId: string,
    kind: WritableControllerKind,
    value: boolean,
  ) => Promise<'applied' | 'unknown' | 'rejected'>;
  async start() {}
  async stop() {}
  rename() {}
  snapshot() {
    return structuredClone(this.state);
  }
  onSecurityTouch(handler: (event: SecurityTouchEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  async sendSecurityLease(id: string, input: SecurityLeaseInput): Promise<SecurityCommandFence> {
    const lease = { ...input, leaseSequence: ++this.sequence };
    this.leases.set(id, lease);
    return {
      hubEpoch: lease.hubEpoch,
      modeRevision: lease.modeRevision,
      leaseSequence: lease.leaseSequence,
    };
  }
  async command(
    deviceId: string,
    controller: WritableControllerKind,
    itemId: string,
    value: boolean,
    _timeout?: number,
    fence?: SecurityCommandFence,
  ): Promise<CommandView> {
    this.calls.push({ deviceId, controller, value, fence, timeout: _timeout });
    if (controller === 'security') {
      assert.ok(fence, 'Every house/manual guard SET uses an exact ephemeral fence');
      assert.equal(fence.leaseSequence, this.leases.get(deviceId)?.leaseSequence);
    }
    const status = (await this.hook?.(deviceId, controller, value)) || 'applied';
    const row = this.state.devices.find((device) => device.id === deviceId)!;
    if (status === 'applied' && controller === 'security') {
      row.controllers.security!.data.armed = value;
      if (!value) row.controllers.security!.data.triggered = false;
      row.controllers.security!.receivedAt = 'sample-' + this.calls.length + '-' + Math.random();
    }
    const command: CommandView = {
      id: 'command-' + this.calls.length,
      deviceId,
      controller,
      itemId,
      value,
      sequence: this.calls.length,
      status,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: status === 'applied' ? null : 'Не подтверждено',
    };
    this.state.commands.push(command);
    return command;
  }
  tap(id: string): SecurityTouchEvent {
    const lease = this.leases.get(id)!;
    const event: SecurityTouchEvent = {
      schemaVersion: 1,
      deviceId: id,
      bootId: this.state.devices.find((device) => device.id === id)!.bootId!,
      hubEpoch: lease.hubEpoch,
      leaseSequence: lease.leaseSequence,
      modeRevision: lease.modeRevision,
      eventSequence: ++this.eventSequence,
      eventAtUptimeMs: 100000,
      value: lease.touchArmed,
      keyId: 'key-home',
      keyName: 'Ключ дома',
      localApplied: true,
    };
    this.state.devices.find((device) => device.id === id)!.controllers.security!.data.armed =
      event.value;
    this.emit(event);
    return event;
  }
  emit(event: SecurityTouchEvent) {
    for (const handler of this.handlers) handler(event);
  }
}
function fixture(
  t: TestContext,
  engine = new Engine(),
  directory = mkdtempSync(join(tmpdir(), 'fcplcn-house-')),
) {
  const scenes = new Scenes(engine, { directory });
  let time = 1000,
    control!: HubControl;
  const house = new HouseSecurity(engine, scenes, {
    directory,
    pulseMs: 100000,
    commandTimeoutMs: 100,
    now: () => time,
    runScene: (id) => control.runScene(id),
  });
  control = new HubControl({ engine, scenes, product, mode: 'demo', houseSecurity: house });
  t.after(async () => {
    control.close();
    await scenes.stop();
    await engine.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    engine,
    scenes,
    house,
    control,
    directory,
    advance(ms: number) {
      time += ms;
    },
  };
}
async function settled(scenes: Scenes) {
  const deadline = Date.now() + 2000;
  while (scenes.snapshot().activeRun) {
    if (Date.now() > deadline) assert.fail('House scene did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function pending(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('House operation did not advance');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('concurrent source touches use one durable CAS intent; duplicates and old revisions never toggle twice', async (t) => {
  const f = fixture(t);
  assert.equal(f.house.snapshot().desiredArmed, null);
  assert.equal(f.engine.calls.length, 0, 'Startup does not silently disarm an armed home');
  const first = f.engine.tap('fcplcn-a');
  f.engine.emit(first);
  f.engine.tap('fcplcn-b');
  await settled(f.scenes);
  assert.equal(f.house.snapshot().revision, 1);
  assert.equal(f.house.snapshot().desiredArmed, false);
  assert.equal(f.scenes.snapshot().runs.length, 1);
  const stored = JSON.parse(readFileSync(join(f.directory, 'house-security.json'), 'utf8'));
  assert.equal(stored.lastRunId, f.scenes.snapshot().runs[0].id);
  assert.ok(stored.consumed.includes(f.house.snapshot().lastEvent!.eventId));
  f.house.tick();
  f.engine.tap('fcplcn-b');
  await settled(f.scenes);
  assert.equal(f.house.snapshot().desiredArmed, true);
  assert.equal(f.house.snapshot().revision, 2);
  assert.equal(f.scenes.snapshot().runs.length, 2);
  f.engine.emit(first);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.scenes.snapshot().runs.length, 2);
});

test('configured contactors start immediately despite an unconfirmed guard and an offline PLC; pending fences are reserved', async (t) => {
  const engine = new Engine();
  engine.state.devices[1].online = false;
  engine.state.devices[1].controllers.security!.fresh = false;
  let release!: () => void;
  engine.hook = async (_id, kind) => {
    if (kind === 'security')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return 'applied';
  };
  const f = fixture(t, engine);
  f.scenes.update('away', 1, [
    {
      id: 'main-contactor',
      deviceId: 'fcplcn-a',
      controller: 'sockets',
      itemId: 'contactor',
      value: false,
    },
  ]);
  f.control.runScene('away');
  await pending(() => engine.calls.some((call) => call.controller === 'sockets'));
  assert.ok(
    f.scenes.snapshot().activeRun,
    'Guard ACK is still pending while the contactor action has already started',
  );
  const guard = engine.calls.find((call) => call.controller === 'security')!;
  f.house.tick();
  assert.equal(
    engine.leases.get('fcplcn-a')!.leaseSequence,
    guard.fence!.leaseSequence,
    'The pulse cannot invalidate an in-flight SET fence',
  );
  release();
  await settled(f.scenes);
  assert.equal(engine.calls.filter((call) => call.controller === 'sockets').length, 1);
  assert.equal(f.scenes.snapshot().runs[0].status, 'partial');
  assert.equal(
    f.house.snapshot().devices.find((device) => device.deviceId === 'fcplcn-b')!.status,
    'offline',
  );
});

test('an offline PLC returns to the latest desired revision without replaying earlier modes or configured actions', async (t) => {
  const engine = new Engine();
  engine.state.devices[1].online = false;
  engine.state.devices[1].controllers.security!.fresh = false;
  const f = fixture(t, engine);
  for (const id of ['home', 'away'])
    f.scenes.update(id, 1, [
      {
        id: 'contactor-' + id,
        deviceId: 'fcplcn-a',
        controller: 'sockets',
        itemId: 'contactor',
        value: id === 'home',
      },
    ]);
  f.control.runScene('home');
  await settled(f.scenes);
  f.control.runScene('away');
  await settled(f.scenes);
  const extraCount = engine.calls.filter((call) => call.controller === 'sockets').length;
  const returned = engine.state.devices[1];
  returned.online = true;
  returned.bootId = 'new-boot';
  returned.controllers.security!.fresh = true;
  returned.controllers.security!.data.armed = false;
  f.house.tick();
  await pending(() => engine.calls.some((call) => call.deviceId === returned.id));
  await pending(() => !f.house.busy);
  assert.deepEqual(
    engine.calls.filter((call) => call.deviceId === returned.id).map((call) => call.value),
    [true],
  );
  assert.equal(engine.calls.filter((call) => call.controller === 'sockets').length, extraCount);
  assert.equal(f.scenes.snapshot().runs.length, 2);
  assert.equal(
    f.house.snapshot().devices.find((device) => device.deviceId === returned.id)!.status,
    'confirmed',
  );
});

test('durable inventory survives hub restart; recovery never repeats extra actions', async (t) => {
  const f = fixture(t);
  f.control.runScene('away');
  await settled(f.scenes);
  f.control.close();
  await f.scenes.stop();
  const engine = new Engine();
  engine.state.devices = [device('fcplcn-a', false)];
  const scenes = new Scenes(engine, { directory: f.directory });
  const house = new HouseSecurity(engine, scenes, { directory: f.directory, pulseMs: 100000 });
  house.start();
  t.after(async () => {
    house.stop();
    await scenes.stop();
  });
  await pending(() => !house.busy);
  assert.equal(house.snapshot().desiredArmed, true);
  assert.equal(house.snapshot().devices.length, 2);
  assert.equal(
    house.snapshot().devices.find((device) => device.deviceId === 'fcplcn-b')!.status,
    'offline',
  );
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].controller, 'security');
  assert.equal(scenes.snapshot().runs.length, 1);
});

test('unknown outcomes wait for a new fresh observation and confirm readback without blind resend', async (t) => {
  const engine = new Engine();
  engine.state.devices[0].controllers.security!.data.armed = false;
  engine.state.devices[1].controllers.security!.data.enabled = false;
  engine.hook = async () => 'unknown';
  const f = fixture(t, engine);
  f.control.runScene('away');
  await settled(f.scenes);
  assert.equal(engine.calls.length, 1);
  f.advance(60000);
  f.house.tick();
  f.house.tick();
  assert.equal(engine.calls.length, 1, 'Elapsed wall time alone never authorizes an unknown retry');
  engine.state.devices[0].controllers.security!.receivedAt = 'fresh-after-unknown';
  engine.state.devices[0].controllers.security!.data.armed = true;
  f.house.tick();
  assert.equal(engine.calls.length, 1);
  assert.equal(
    f.house.snapshot().devices.find((device) => device.deviceId === 'fcplcn-a')!.status,
    'confirmed',
  );
});

test('disabled and unconfigured modules stay skipped; individual commands and scheduled modes retain distinct intent semantics', async (t) => {
  const f = fixture(t);
  f.engine.state.devices[1].controllers.security!.data.enabled = false;
  f.scenes.run('home', 'schedule');
  await settled(f.scenes);
  assert.equal(f.house.snapshot().desiredArmed, false);
  assert.equal(f.engine.calls.filter((call) => call.deviceId === 'fcplcn-b').length, 0);
  assert.equal(
    f.house.snapshot().devices.find((device) => device.deviceId === 'fcplcn-b')!.status,
    'skipped',
  );
  await f.control.command('fcplcn-a', 'security', 'alarm', true);
  f.house.tick();
  assert.equal(f.house.snapshot().revision, 1);
  assert.equal(f.house.snapshot().desiredArmed, false);
  assert.equal(
    f.house.snapshot().devices.find((device) => device.deviceId === 'fcplcn-a')!.status,
    'unknown',
    'A local override is not falsely reported as globally confirmed',
  );
  f.engine.state.devices[0].controllers.security!.data.items = [];
  f.house.tick();
  f.control.runScene('away');
  await settled(f.scenes);
  assert.equal(
    f.house.snapshot().devices.find((device) => device.deviceId === 'fcplcn-a')!.status,
    'not-configured',
  );
  assert.equal(f.engine.calls.length, 2);
});

test('enabling an online module is not arming it; a real reconnect applies the current house mode', async (t) => {
  const engine = new Engine();
  const returned = engine.state.devices[1];
  returned.controllers.security!.data.enabled = false;
  returned.controllers.security!.data.armed = false;
  const f = fixture(t, engine);
  f.control.runScene('away');
  await settled(f.scenes);
  assert.equal(engine.calls.filter((call) => call.deviceId === returned.id).length, 0);
  returned.controllers.security!.data.enabled = true;
  returned.controllers.security!.receivedAt = 'enabled-without-reconnect';
  f.house.tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    engine.calls.filter((call) => call.deviceId === returned.id).length,
    0,
    'A skipped old intent does not awaken when the module is merely enabled',
  );
  assert.equal(
    f.house.snapshot().devices.find((device) => device.deviceId === returned.id)!.status,
    'unknown',
  );
  assert.equal(
    f.house.snapshot().devices.find((device) => device.deviceId === returned.id)!.actualArmed,
    false,
  );
  returned.online = false;
  returned.controllers.security!.fresh = false;
  f.house.tick();
  returned.online = true;
  returned.controllers.security!.fresh = true;
  f.house.tick();
  await pending(() => !f.house.busy);
  assert.deepEqual(
    engine.calls.filter((call) => call.deviceId === returned.id).map((call) => call.value),
    [true],
  );
});

test('a reconnect generation reconciles the latest mode even when polling missed the entire offline interval', async (t) => {
  const f = fixture(t);
  f.control.runScene('away');
  await settled(f.scenes);
  await f.control.command('fcplcn-a', 'security', 'alarm', false);
  const device = f.engine.state.devices[0],
    runs = f.scenes.snapshot().runs.length;
  assert.equal(f.house.snapshot().devices[0].actualArmed, false);
  // Registry observed the real reconnect between coordinator polls; online and bootId look unchanged.
  device.connectionGeneration = 1;
  f.house.tick();
  await pending(() => !f.house.busy);
  assert.equal(f.engine.calls.at(-1)!.value, true);
  assert.equal(f.house.snapshot().devices[0].status, 'confirmed');
  assert.equal(f.scenes.snapshot().runs.length, runs);
});

test('a background recovery lease blocks another physical touch before its pending SET is registered', async (t) => {
  const f = fixture(t);
  f.control.runScene('away');
  await settled(f.scenes);
  const device = f.engine.state.devices[1];
  device.online = false;
  device.controllers.security!.fresh = false;
  f.house.tick();
  let release!: () => void;
  f.engine.hook = async (id) => {
    if (id === device.id)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return 'applied';
  };
  device.online = true;
  device.controllers.security!.fresh = true;
  device.connectionGeneration = 1;
  f.house.tick();
  await pending(() => Boolean(release));
  assert.equal(
    f.engine.leases.get(device.id)!.busy,
    true,
    'Recovery authority is already busy when sendSecurityLease is invoked',
  );
  assert.equal(f.house.busy, true);
  release();
  await pending(() => !f.house.busy);
  assert.equal(f.scenes.snapshot().runs.length, 1, 'Background recovery is not another scene run');
});

test('security ACK budgets stay inside the four-second lease while other outputs keep their original budget', async (t) => {
  const f = fixture(t);
  await f.control.command('fcplcn-a', 'security', 'alarm', false, 8000);
  await f.control.command('fcplcn-a', 'sockets', 'contactor', false, 8000);
  assert.equal(f.engine.calls[0].timeout, 2500);
  assert.equal(f.engine.calls[1].timeout, 8000);
  const security = f.engine.state.devices[0].controllers.security!;
  security.data.phase = 'exit_delay';
  security.data.remainingSeconds = 20;
  assert.equal(f.house.snapshot().devices[0].phase, 'exit_delay');
  assert.equal(f.house.snapshot().devices[0].remainingSeconds, 20);
  security.fresh = false;
  assert.equal(f.house.snapshot().devices[0].phase, null);
});

test('storage failure refuses the mode and all extras; a corrupt journal is kept and grants no hub leases', async (t) => {
  const f = fixture(t);
  f.scenes.update('away', 1, [
    {
      id: 'contactor',
      deviceId: 'fcplcn-a',
      controller: 'sockets',
      itemId: 'contactor',
      value: false,
    },
  ]);
  const file = join(f.directory, 'house-security.json');
  renameSync(file, file + '.confirmed');
  mkdirSync(file);
  assert.throws(() => f.control.runScene('away'), /сохранить/);
  assert.equal(f.engine.calls.length, 0);
  assert.equal(f.house.snapshot().desiredArmed, null);
  assert.ok(f.house.snapshot().error);
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-house-corrupt-'));
  writeFileSync(join(directory, 'house-security.json'), 'invalid journal');
  const engine = new Engine(),
    scenes = new Scenes(engine),
    house = new HouseSecurity(engine, scenes, { directory });
  house.start();
  assert.equal(engine.leases.size, 0);
  assert.equal(readFileSync(join(directory, 'house-security.json'), 'utf8'), 'invalid journal');
  t.after(async () => {
    house.stop();
    await scenes.stop();
    rmSync(directory, { recursive: true, force: true });
  });
});
