/** @file Full PLC management uses one shared virtual state, including claims, accounts and restores. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.js';
import type {
  EngineOptions,
  HubEngine,
  ManagementReply,
  ManagementRequest,
} from '../shared/types.js';
import { DemoPLC, demoRoms } from '../src/protocol/demo-plc.js';
import { demoPresets } from '../src/protocol/demo-presets.js';

type Data = Record<string, unknown>;
const product = { name: 'FCPLCn', id: 'fcplcn', fullName: 'Future City PLC Next' };
const living = 'fcplcn-demo-living';
const record = (reply: Pick<ManagementReply, 'data'>): Data => {
  assert.ok(!Array.isArray(reply.data));
  return reply.data as Data;
};
const items = (data: Data): Data[] => data.items as Data[];
const settings = (data: Data) =>
  items(data).map(({ id, name, relayId, inputId }) => ({ id, name, relayId, inputId }));
const options = (directory: string): EngineOptions => ({
  mode: 'demo',
  product,
  demoDataDir: directory,
  brokerUrl: 'mqtt://127.0.0.1:1883',
  clientId: 'demo-management-check',
  staleAfterMs: 45_000,
  commandTimeoutMs: 8000,
  labels: {},
  onLabelsChanged() {},
});
async function service(
  engine: HubEngine,
  path: string,
  body?: Data,
  method: 'GET' | 'POST' = body ? 'POST' : 'GET',
) {
  assert.ok(engine.service);
  return engine.service(living, method, path, body);
}
async function until(check: () => boolean | Promise<boolean>, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Virtual PLC did not settle');
}
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-management-demo-'));
  const engine = createEngine(options(directory));
  await engine.start();
  t.after(async () => {
    await engine.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { engine, directory };
}

test('demo management CRUD, core commands, hardware claims, backup and reboot share one PLC state', async (t) => {
  const { engine } = await fixture(t);
  const profiles = await service(engine, '/board-profiles');
  assert.equal(profiles.status, 200);
  assert.ok(Array.isArray(profiles.data));
  const current = record(await service(engine, '/controllers/sockets'));
  const saved = await service(engine, '/controllers/sockets', {
    baseRevision: current.revision,
    enabled: true,
    items: [
      ...settings(current),
      { id: 'demo-new-outlet', name: 'Новая розетка', relayId: 'rly-0/13', inputId: 'in-0/10' },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await service(engine, '/controllers/sockets/state', { id: 'demo-new-outlet', value: true }))
      .status,
    200,
  );
  const hubItem = () =>
    (
      engine.snapshot().devices.find((device) => device.id === living)!.controllers.sockets!.data
        .items as Data[]
    ).find((item) => item.id === 'demo-new-outlet');
  assert.equal(hubItem()?.state, true, 'Service edits immediately update hub telemetry');
  assert.equal(
    (await engine.command(living, 'sockets', 'demo-new-outlet', false)).status,
    'applied',
  );
  assert.equal(
    items(record(await service(engine, '/controllers/sockets'))).find(
      (item) => item.id === 'demo-new-outlet',
    )?.state,
    false,
  );
  const lights = record(await service(engine, '/controllers/lights'));
  assert.equal(
    (
      await service(engine, '/controllers/lights', {
        baseRevision: lights.revision,
        enabled: true,
        items: [
          ...settings(lights),
          { id: 'conflicting-light', name: 'Конфликт', relayId: 'rly-0/13', inputId: '' },
        ],
      })
    ).status,
    409,
  );
  const hardware = record(await service(engine, '/hardware'));
  assert.equal((hardware.relays as unknown[]).length, 16);
  const config = record(await service(engine, '/config'));
  assert.equal(
    (
      await service(engine, '/config', {
        baseRevision: config.revision,
        device: { name: 'Новая гостиная' },
      })
    ).status,
    200,
  );
  const backup = record(await service(engine, '/config/backup'));
  assert.equal(backup.version, 10);
  const bad = structuredClone(backup);
  bad.boardId = 'different-board';
  const now = record(await service(engine, '/config'));
  assert.ok(
    (await service(engine, '/config/restore', { baseRevision: now.revision, document: bad }))
      .status >= 400,
  );
  let boot = engine.snapshot().devices.find((device) => device.id === living)!.bootId;
  assert.equal((await service(engine, '/reboot', {})).status, 200);
  await until(
    () => engine.snapshot().devices.find((device) => device.id === living)!.bootId !== boot,
  );
  assert.equal((record(await service(engine, '/config')).device as Data).name, 'Новая гостиная');
  assert.ok(
    items(record(await service(engine, '/controllers/sockets'))).some(
      (item) => item.id === 'demo-new-outlet',
    ),
  );
  boot = engine.snapshot().devices.find((device) => device.id === living)!.bootId;
  const beforeRestore = record(await service(engine, '/config'));
  assert.equal(
    (
      await service(engine, '/config/restore', {
        baseRevision: beforeRestore.revision,
        document: backup,
      })
    ).status,
    200,
  );
  await until(
    () => engine.snapshot().devices.find((device) => device.id === living)!.bootId !== boot,
  );
  assert.ok(
    items(record(await service(engine, '/controllers/sockets'))).some(
      (item) => item.id === 'demo-new-outlet',
    ),
  );
});

test('demo preserves network settings and the actual account verifier across hub process restart', async (t) => {
  const { engine, directory } = await fixture(t);
  assert.equal(
    (
      await service(engine, '/user', {
        username: 'demo-owner',
        currentPassword: '',
        newPassword: 'demo-private-pass',
      })
    ).status,
    200,
  );
  assert.equal(
    (await service(engine, '/user', { username: 'demo-owner', currentPassword: 'wrong-password' }))
      .status,
    403,
  );
  const config = record(await service(engine, '/config'));
  assert.equal(
    (
      await service(engine, '/config', {
        baseRevision: config.revision,
        wifi: { ap: { enabled: false } },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await service(engine, '/time', {
        timezone: (config.time as Data).timezone,
        unixTime: 1795123456,
      })
    ).status,
    200,
  );
  assert.equal((record(await service(engine, '/status')).time as Data).source, 'manual');
  await engine.stop();
  const second = createEngine(options(directory));
  await second.start();
  try {
    const restored = record(await service(second, '/config'));
    assert.equal((restored.user as Data).username, 'demo-owner');
    assert.equal(((restored.wifi as Data).ap as Data).enabled, false);
    assert.equal(
      (
        await service(second, '/user', {
          username: 'demo-owner',
          currentPassword: 'demo-private-pass',
          newPassword: '',
        })
      ).status,
      200,
    );
  } finally {
    await second.stop();
  }
});

test('tank monitoring survives a demo restart while automatic outputs use newly observed contacts', async (t) => {
  const { engine, directory } = await fixture(t);
  const utility = 'fcplcn-demo-utility';
  const tank = (current: HubEngine) =>
    (
      current.snapshot().devices.find((device) => device.id === utility)!.controllers.tanks!.data
        .items as Data[]
    )[0];
  await until(() => tank(engine).levelPct === 50);
  assert.equal(tank(engine).pumpActual, true, 'The lower wet contact starts the draining pump');
  assert.equal(tank(engine).valveActual, true, 'The dry upper contact independently opens filling');
  assert.equal((await engine.command(utility, 'tanks', 'tank-water', false)).status, 'applied');
  await until(() => tank(engine).enabled === false);
  assert.equal(tank(engine).pumpActual, false);
  assert.equal(tank(engine).valveActual, false);
  assert.equal(tank(engine).levelPct, null);
  assert.equal((await engine.command(utility, 'tanks', 'tank-water', true)).status, 'applied');
  await until(() => tank(engine).levelPct === 50);
  await engine.stop();
  const restarted = createEngine(options(directory));
  await restarted.start();
  try {
    await until(() => tank(restarted).levelPct === 0);
    assert.equal(tank(restarted).enabled, true, 'Monitoring permission is durable');
    assert.equal(
      tank(restarted).pumpActual,
      false,
      'A prior ON output is never restored as intent',
    );
    assert.equal(
      tank(restarted).valveActual,
      true,
      'Filling follows the newly observed dry contacts',
    );
  } finally {
    await restarted.stop();
  }
});

test('irrigation commands enable a local schedule across a demo restart with the valve closed', async (t) => {
  const { engine, directory } = await fixture(t);
  const deviceId = 'fcplcn-demo-utility';
  const rule = (current: HubEngine) =>
    items(
      current.snapshot().devices.find((device) => device.id === deviceId)!.controllers.irrigation!
        .data,
    )[0];
  await until(() => rule(engine)?.waterAvailable === true);
  assert.equal(rule(engine).tankId, 'tank-water');
  assert.deepEqual(rule(engine).days, [1, 3, 5]);
  assert.equal(rule(engine).enabled, false);
  assert.equal(
    (await engine.command(deviceId, 'irrigation', 'irrigation-garden', true)).status,
    'applied',
  );
  await until(() => rule(engine).enabled === true);
  assert.equal(rule(engine).actual, false);
  await engine.stop();
  const restarted = createEngine(options(directory));
  await restarted.start();
  try {
    await until(() => rule(restarted).waterAvailable === false);
    assert.equal(rule(restarted).enabled, true);
    assert.equal(rule(restarted).valveActual, false);
    assert.equal(
      (await restarted.command(deviceId, 'irrigation', 'irrigation-garden', false)).status,
      'applied',
    );
    await until(() => rule(restarted).enabled === false);
  } finally {
    await restarted.stop();
  }
});

test('a PLC without any tanks preserves a timer-only irrigation rule across a restart', async (t) => {
  const { engine, directory } = await fixture(t);
  const path = '/controllers/irrigation';
  assert.deepEqual(items(record(await service(engine, '/controllers/tanks'))), []);
  const initial = record(await service(engine, path));
  const saved = await service(engine, path, {
    baseRevision: initial.revision,
    enabled: true,
    items: [
      {
        id: 'lawn',
        name: 'Газон',
        relayId: 'rly-0/12',
        days: [2, 6],
        startTime: '06:30',
        durationMinutes: 12,
      },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(items(record(saved))[0].tankId, '');
  assert.equal((await engine.command(living, 'irrigation', 'lawn', true)).status, 'applied');
  await engine.stop();
  const restarted = createEngine(options(directory));
  await restarted.start();
  try {
    const [rule] = items(record(await service(restarted, path)));
    assert.equal(rule.tankId, '');
    assert.equal(rule.waterAvailable, null);
    assert.equal(rule.error, null);
    assert.equal(rule.enabled, true);
    assert.equal(rule.actual, false);
    assert.deepEqual(rule.days, [2, 6]);
  } finally {
    await restarted.stop();
  }
});

test('the demo offers another PLC’s tank and follows its monitoring state', async (t) => {
  const { engine } = await fixture(t);
  const source = 'fcplcn-demo-utility';
  const reference = source + '/tank-water';
  const path = '/controllers/irrigation';
  const catalogue = async () => record(await service(engine, path));
  const findTank = (data: Data) =>
    (data.remoteTanks as Data[] | undefined)?.find(({ id }) => id === reference);
  await until(async () => findTank(await catalogue())?.waterAvailable === true, 6000);
  const initial = await catalogue();
  const selected = findTank(initial);
  assert.equal(selected?.name, 'Бак с водой');
  assert.equal(selected?.deviceName, 'Котельная');
  assert.equal(selected?.waterAvailable, true);
  const saved = await service(engine, path, {
    baseRevision: initial.revision,
    enabled: true,
    items: [
      {
        id: 'remote-watering',
        name: 'Полив из котельной',
        relayId: 'rly-0/12',
        tankId: reference,
        days: [2, 6],
        startTime: '06:30',
        durationMinutes: 12,
      },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(items(record(saved))[0].tankId, reference);
  assert.equal(
    (await engine.command(living, 'irrigation', 'remote-watering', true)).status,
    'applied',
  );
  const rule = () =>
    items(
      engine.snapshot().devices.find((device) => device.id === living)!.controllers.irrigation!
        .data,
    )[0];
  await until(() => rule().waterAvailable === true, 6000);
  assert.equal((await engine.command(source, 'tanks', 'tank-water', false)).status, 'applied');
  await until(() => rule().waterAvailable === null, 6000);
  assert.equal(rule().actual, false);
  assert.equal(rule().valveActual, false);
  assert.equal(rule().tankId, reference);
  assert.match(String(rule().error), /бака/);
  assert.equal((await engine.command(source, 'tanks', 'tank-water', true)).status, 'applied');
  await until(() => rule().waterAvailable === true, 6000);
  assert.equal(rule().actual, false);
});

test('demo supports CRC-valid OneWire and iButton enrollment without touching an armed guard', async (t) => {
  const { engine } = await fixture(t);
  assert.equal(
    (await service(engine, '/controllers/meteo/scan', { portId: 'sens-0/8', refresh: true }))
      .status,
    200,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const wire = record(
    await service(engine, '/controllers/meteo/scan', { portId: 'sens-0/8', refresh: false }),
  );
  assert.ok((wire.devices as unknown[]).length > 1);
  const empty = record(await service(engine, '/controllers/security'));
  let saved = await service(engine, '/controllers/security', {
    baseRevision: empty.revision,
    enabled: true,
    sirenRelayId: 'rly-0/16',
    readerPortId: 'sens-0/6',
    exitDelaySeconds: 0,
    entryDelaySeconds: 15,
    keys: [],
    items: [
      {
        id: 'guard-door',
        name: 'Дверь',
        inputId: 'in-0/13',
        sensorType: 'reed',
        entryDelay: false,
      },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await service(engine, '/controllers/security/scan', { portId: 'sens-0/6', refresh: true }))
      .status,
    200,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const scan = record(
    await service(engine, '/controllers/security/scan', { portId: 'sens-0/6', refresh: false }),
  );
  assert.ok((scan.addresses as string[]).length > 0);
  const address = (scan.addresses as string[])[0];
  const guard = record(saved);
  saved = await service(engine, '/controllers/security', {
    baseRevision: guard.revision,
    enabled: true,
    sirenRelayId: 'rly-0/16',
    readerPortId: 'sens-0/6',
    exitDelaySeconds: 0,
    entryDelaySeconds: 15,
    keys: [{ id: 'test-key', name: 'Основной', address }],
    items: items(guard).map(({ id, name, inputId, sensorType, entryDelay }) => ({
      id,
      name,
      inputId,
      sensorType,
      entryDelay,
    })),
  });
  assert.equal(saved.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await service(engine, '/controllers/security/armed', { value: true })).status, 200);
  assert.equal(
    (await service(engine, '/controllers/security/scan', { portId: 'sens-0/6', refresh: true }))
      .status,
    409,
  );
  assert.equal(record(await service(engine, '/controllers/security')).armed, true);
});

test('demo management rejects wrong boot, expired envelopes and stale sequences without mutation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-management-envelope-'));
  const plc = new DemoPLC(demoPresets(product, demoRoms)[0], directory, () => {});
  t.after(async () => {
    await plc.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const packet: ManagementRequest = {
    schemaVersion: 1,
    requestId: 'test-private',
    bootId: plc.bootId,
    sequence: 1,
    expiresAtUptimeMs: plc.uptimeMs() + 5000,
    method: 'GET',
    path: '/config',
  };
  assert.equal((await plc.service({ ...packet, bootId: 'other-boot' })).status, 409);
  assert.equal(
    (await plc.service({ ...packet, expiresAtUptimeMs: plc.uptimeMs() - 1 })).status,
    408,
  );
  const original = await plc.service(packet);
  assert.equal(original.status, 200);
  const duplicate = await plc.service(packet);
  assert.deepEqual(duplicate, original);
  assert.equal((await plc.service({ ...packet, path: '/status' })).status, 409);
  assert.equal((await plc.service({ ...packet, sequence: 2, path: '/login' })).status, 400);
});

test('ordinary firmware fixtures keep authentication required when private demo transport is absent', async (t) => {
  const require = createRequire(import.meta.url);
  const { createMock } = require(
    fileURLToPath(new URL('../firmware/base/tests/browser/ui_test.cjs', import.meta.url)),
  ) as { createMock(): { server: import('node:http').Server } };
  const mock = createMock();
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    mock.server.closeAllConnections();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });
  const address = mock.server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch('http://127.0.0.1:' + address.port + '/api/v1/status', {
    headers: { 'x-fcplcn-management-token': 'not-a-private-demo-token' },
  });
  assert.equal(response.status, 401);
});
