/** @file Durable summary preferences, concurrent editors and unavailable sensor identity. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceView, EngineSnapshot, HubEngine, Product } from '../shared/types.js';
import type { PultSettingsView } from '../shared/pult.js';
import { PultSettings, PultSettingsStore } from '../server/pult-settings.js';
import { HubControl } from '../server/control.js';
import { Scenes } from '../server/scenes.js';

function device(id = 'fcplcn-living'): DeviceView {
  return {
    id,
    name: 'Гостиная',
    room: 'Первый этаж',
    boardId: 'fcplcn-161608-1v0',
    firmwareVersion: 'test',
    bootId: 'test-boot',
    status: 'online',
    online: true,
    lastSeenAt: new Date().toISOString(),
    uptimeSec: 10,
    controllers: {
      meteo: {
        kind: 'meteo',
        fresh: true,
        receivedAt: new Date().toISOString(),
        data: {
          enabled: true,
          items: [
            { id: 'air', name: 'Воздух в гостиной', sensorType: 'dht22', temperatureC: 21.8 },
            { id: 'floor', name: 'Тёплый пол', sensorType: 'onewire', temperatureC: 26.2 },
          ],
        },
      },
    },
  };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-pult-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = new PultSettings(directory);
  const store = new PultSettingsStore(directory);
  return { directory, settings, store, devices: [device()] };
}
const selection = { deviceId: 'fcplcn-living', itemId: 'air' };
const savedSource = {
  ...selection,
  deviceName: 'Гостиная',
  itemName: 'Воздух в гостиной',
};

test('summary starts unselected, resolves names on save and persists independently of PLC availability', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.settings.snapshot(), { revision: 0, temperatureSource: null });
  const saved = f.settings.update({ baseRevision: 0, temperatureSource: selection }, f.devices);
  assert.deepEqual(saved, { revision: 1, temperatureSource: savedSource });
  assert.equal(statSync(f.store.path!).mode & 0o777, 0o600);
  assert.deepEqual(new PultSettings(f.directory).snapshot(), saved);

  // The controller may not have announced itself since restarting the hub.
  const missing = new PultSettings(f.directory);
  assert.deepEqual(missing.snapshot(), saved);
  assert.deepEqual(
    missing.update({ baseRevision: 1, temperatureSource: selection }, []).temperatureSource,
    savedSource,
    'The selected unavailable identity can be retained explicitly',
  );
  assert.deepEqual(missing.update({ baseRevision: 2, temperatureSource: null }, []), {
    revision: 3,
    temperatureSource: null,
  });
  assert.deepEqual(new PultSettings(f.directory).snapshot(), missing.snapshot());
});

test('cached offline sensors can be selected without requiring a successful measurement', (t) => {
  const f = fixture(t);
  f.devices[0].online = false;
  f.devices[0].status = 'offline';
  const meteo = f.devices[0].controllers.meteo!;
  meteo.fresh = false;
  meteo.data.enabled = false;
  const item = (meteo.data.items as Record<string, unknown>[])[0];
  item.available = false;
  item.temperatureC = null;
  assert.deepEqual(
    f.settings.update({ baseRevision: 0, temperatureSource: selection }, f.devices),
    { revision: 1, temperatureSource: savedSource },
  );
});

test('selection validation and stale editor revisions cannot replace the confirmed preference', (t) => {
  const f = fixture(t);
  const saved = f.settings.update({ baseRevision: 0, temperatureSource: selection }, f.devices);
  const bytes = readFileSync(f.store.path!, 'utf8');
  assert.throws(() => f.settings.update({ baseRevision: 0, temperatureSource: null }, f.devices), {
    statusCode: 409,
  });
  for (const body of [
    {},
    { baseRevision: -1, temperatureSource: null },
    { baseRevision: 1.5, temperatureSource: null },
    { baseRevision: 1, temperatureSource: null, extra: true },
    { baseRevision: 1, temperatureSource: [] },
    { baseRevision: 1, temperatureSource: { deviceId: 'bad', itemId: 'air' } },
    { baseRevision: 1, temperatureSource: { ...selection, itemId: '../air' } },
    { baseRevision: 1, temperatureSource: { ...selection, deviceName: 'Spoofed name' } },
    { baseRevision: 1, temperatureSource: { ...selection, itemId: 'missing' } },
    { baseRevision: 1, temperatureSource: { deviceId: 'fcplcn-other', itemId: 'air' } },
  ])
    assert.throws(() => f.settings.update(body, f.devices), { statusCode: 400 });
  assert.deepEqual(f.settings.snapshot(), saved);
  assert.equal(readFileSync(f.store.path!, 'utf8'), bytes);
});

test('public snapshots cannot mutate the saved selection or future readbacks', (t) => {
  const f = fixture(t);
  const returned = f.settings.update({ baseRevision: 0, temperatureSource: selection }, f.devices);
  returned.temperatureSource!.itemName = 'Changed outside';
  returned.revision = 100;
  assert.deepEqual(f.settings.snapshot(), { revision: 1, temperatureSource: savedSource });
  assert.deepEqual(new PultSettings(f.directory).snapshot(), f.settings.snapshot());
});

test('a failed write leaves the previous committed selection and revision intact', (t) => {
  const f = fixture(t);
  const saved = f.settings.update({ baseRevision: 0, temperatureSource: selection }, f.devices);
  const before = readFileSync(f.store.path!, 'utf8');
  const store = Reflect.get(f.settings, 'store') as PultSettingsStore;
  const failed = t.mock.method(store, 'save', () => {
    throw Object.assign(new Error('Read-only preference filesystem'), { code: 'EROFS' });
  });
  assert.throws(
    () => f.settings.update({ baseRevision: 1, temperatureSource: null }, f.devices),
    /Read-only/,
  );
  assert.deepEqual(f.settings.snapshot(), saved);
  assert.equal(readFileSync(f.store.path!, 'utf8'), before);
  assert.deepEqual(new PultSettings(f.directory).snapshot(), saved);
  failed.mock.restore();
  assert.deepEqual(f.settings.update({ baseRevision: 1, temperatureSource: null }, f.devices), {
    revision: 2,
    temperatureSource: null,
  });
});

test('a failure after the atomic commit cannot resurrect the previous selection in memory', (t) => {
  const f = fixture(t);
  f.settings.update({ baseRevision: 0, temperatureSource: selection }, f.devices);
  const store = Reflect.get(f.settings, 'store') as PultSettingsStore;
  const save = store.save.bind(store);
  t.mock.method(store, 'save', (value: PultSettingsView, committed: () => void) => {
    save(value, committed);
    throw new Error('Directory sync failed after commit');
  });
  assert.throws(
    () => f.settings.update({ baseRevision: 1, temperatureSource: null }, f.devices),
    /after commit/,
  );
  assert.deepEqual(f.settings.snapshot(), { revision: 2, temperatureSource: null });
  assert.deepEqual(new PultSettings(f.directory).snapshot(), f.settings.snapshot());
});

test('corrupt, oversized, linked or unexpected preference formats are preserved and rejected', (t) => {
  const f = fixture(t);
  for (const invalid of [
    '{broken',
    'x'.repeat(4097),
    JSON.stringify({ version: 2, revision: 1, temperatureSource: savedSource }),
    JSON.stringify({ version: 1, revision: -1, temperatureSource: null }),
    JSON.stringify({
      version: 1,
      revision: 1,
      temperatureSource: { ...savedSource, itemId: 'bad/id' },
    }),
    JSON.stringify({ version: 1, revision: 1, temperatureSource: savedSource, extra: true }),
  ]) {
    writeFileSync(f.store.path!, invalid);
    assert.throws(() => new PultSettings(f.directory), /пульта/);
    assert.equal(readFileSync(f.store.path!, 'utf8'), invalid);
  }
  rmSync(f.store.path!);
  symlinkSync(join(f.directory, 'missing'), f.store.path!);
  assert.throws(() => new PultSettings(f.directory), /обычном/);
});

test('HubControl shares the preference in overview and dispatch without issuing hardware commands', async (t) => {
  const f = fixture(t);
  let commands = 0;
  const state: EngineSnapshot = {
    broker: { connected: true, error: null },
    devices: f.devices,
    commands: [],
  };
  const engine: HubEngine = {
    async start() {},
    async stop() {},
    snapshot: () => structuredClone(state),
    rename() {},
    async command() {
      commands++;
      throw new Error('No hardware command is allowed for a display preference');
    },
  };
  const product: Product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };
  const scenes = new Scenes(engine);
  const control = new HubControl({ engine, scenes, product, mode: 'demo', dataDir: f.directory });
  t.after(() => control.close());
  assert.deepEqual(await control.dispatch('GET', '/pult/settings'), {
    status: 200,
    data: { revision: 0, temperatureSource: null },
  });
  const result = await control.dispatch('PUT', '/pult/settings', {
    baseRevision: 0,
    temperatureSource: selection,
  });
  assert.deepEqual(result, { status: 200, data: { revision: 1, temperatureSource: savedSource } });
  assert.deepEqual(control.overview().pult, result.data);
  state.devices = [];
  assert.deepEqual(control.overview().pult, result.data);
  assert.equal(commands, 0);
  const memory = new PultSettings();
  assert.deepEqual(memory.update({ baseRevision: 0, temperatureSource: selection }, f.devices), {
    revision: 1,
    temperatureSource: savedSource,
  });
});
