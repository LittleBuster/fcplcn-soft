/** @file Device-card choices persist on the hub, remain optional for old clients and never alter a PLC. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deviceIllustrations,
  DEFAULT_DEVICE_ILLUSTRATION,
  isDeviceIllustrationId,
  type DeviceIllustrationId,
} from '../shared/device-art.js';
import type { DeviceLabel, EngineOptions, HubEngine } from '../shared/types.js';
import { LabelStore } from '../server/storage.js';
import { HubRegistry } from '../src/protocol/registry.js';
import { HubControl } from '../server/control.js';
import { Scenes } from '../server/scenes.js';

const product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };
const id = 'fcplcn-card-test';
function options(
  labels: Record<string, DeviceLabel>,
  save: EngineOptions['onLabelsChanged'],
): EngineOptions {
  return {
    product,
    mode: 'mqtt',
    brokerUrl: 'mqtt://127.0.0.1:1',
    clientId: 'fcplcn-card-test',
    staleAfterMs: 35000,
    commandTimeoutMs: 8000,
    labels,
    onLabelsChanged: save,
  };
}
function discover(registry: HubRegistry) {
  registry.setConnection(true);
  registry.receive(`fcplcn/${id}/availability`, 'online');
}

test('the shared catalog has thirty distinct safe illustrations and rejects markup, URLs and unknown identities', () => {
  assert.equal(deviceIllustrations.length, 30);
  assert.equal(new Set(deviceIllustrations.map((row) => row.id)).size, 30);
  assert.equal(DEFAULT_DEVICE_ILLUSTRATION, 'board');
  for (const row of deviceIllustrations) {
    assert.ok(isDeviceIllustrationId(row.id));
    assert.ok(row.label.length && row.group.length);
  }
  for (const value of [
    'unknown',
    'Board',
    '../house',
    '<svg/>',
    'https://example.test/a.svg',
    'data:image/svg+xml,a',
    '',
    null,
    1,
    {},
    ['house'],
  ])
    assert.equal(isDeviceIllustrationId(value), false);
});

test('version-one labels load unchanged; selected illustrations survive reload and invalid writes leave the last document intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-device-art-store-'));
  try {
    const store = new LabelStore(directory);
    const legacy = { version: 1, devices: { [id]: { name: 'Щит', room: 'Дом' } } };
    writeFileSync(store.path, JSON.stringify(legacy));
    const original = readFileSync(store.path, 'utf8');
    assert.deepEqual({ ...store.load() }, legacy.devices);
    assert.equal(
      readFileSync(store.path, 'utf8'),
      original,
      'Loading an old file does not rewrite it',
    );
    const selected = {
      [id]: { name: 'Щит', room: 'Дом', illustrationId: 'electrical-panel' as const },
    };
    store.save(selected);
    assert.deepEqual({ ...new LabelStore(directory).load() }, selected);
    assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).version, 1);
    const confirmed = readFileSync(store.path, 'utf8');
    assert.throws(
      () =>
        store.save({
          [id]: {
            ...selected[id],
            illustrationId: '<svg onload=alert(1)>' as DeviceIllustrationId,
          },
        }),
      /Повреждены/,
    );
    assert.equal(readFileSync(store.path, 'utf8'), confirmed);
    assert.deepEqual(readdirSync(directory), ['devices.json']);
    writeFileSync(
      store.path,
      JSON.stringify({
        version: 1,
        devices: { [id]: { ...selected[id], illustrationId: '../foreign.svg' } },
      }),
    );
    assert.throws(() => new LabelStore(directory).load(), /Повреждены/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('registry defaults to PLC artwork, preserves a choice during old-client renames and publishes only durably saved metadata', () => {
  let stored: Record<string, DeviceLabel> = {},
    saves = 0,
    fail = false,
    plcWrites = 0;
  const registry = new HubRegistry(
    options({}, (labels) => {
      saves++;
      if (fail) throw new Error('Disk full');
      stored = structuredClone(labels);
    }),
    {
      async publish() {
        plcWrites++;
      },
    },
  );
  try {
    discover(registry);
    assert.equal(registry.snapshot().devices[0].illustrationId, 'board');
    registry.rename(id, 'Гараж', 'Участок', 'garage');
    registry.rename(id, 'Новый гараж', 'Двор');
    assert.equal(registry.snapshot().devices[0].illustrationId, 'garage');
    assert.equal(stored[id].illustrationId, 'garage');
    const before = saves;
    assert.throws(
      () => registry.rename(id, 'Не сохранено', 'Дом', 'foreign' as DeviceIllustrationId),
      { statusCode: 400 },
    );
    assert.equal(saves, before);
    fail = true;
    assert.throws(() => registry.rename(id, 'Не сохранено', 'Дом', 'house'), /Disk full/);
    assert.equal(registry.snapshot().devices[0].name, 'Новый гараж');
    assert.equal(registry.snapshot().devices[0].illustrationId, 'garage');
    const rebooted = new HubRegistry(
      options(stored, () => {}),
      {
        async publish() {
          plcWrites++;
        },
      },
    );
    try {
      discover(rebooted);
      assert.equal(rebooted.snapshot().devices[0].illustrationId, 'garage');
    } finally {
      rebooted.close();
    }
    assert.equal(
      plcWrites,
      0,
      'Card illustrations never send configuration or control commands to the PLC',
    );
  } finally {
    registry.close();
  }
});

test('the shared LAN/cloud PATCH authority allows owner catalog choices and rejects invalid or unprivileged changes before persistence', async () => {
  let saves = 0,
    plcWrites = 0;
  const registry = new HubRegistry(
    options({}, () => {
      saves++;
    }),
    {
      async publish() {
        plcWrites++;
      },
    },
  );
  const engine: HubEngine = {
    async start() {},
    async stop() {},
    snapshot: () => registry.snapshot(),
    async command() {
      plcWrites++;
      throw new Error('Unexpected PLC command');
    },
    rename: (deviceId, name, room, illustrationId) =>
      registry.rename(deviceId, name, room, illustrationId),
    async service() {
      plcWrites++;
      throw new Error('Unexpected PLC service call');
    },
  };
  const scenes = new Scenes(engine),
    control = new HubControl({ engine, scenes, product, mode: 'mqtt' });
  const path = '/devices/' + id;
  try {
    discover(registry);
    const actor = { userId: 'owner', role: 'owner' as const, securityControl: true };
    assert.equal(
      (
        await control.dispatch(
          'PATCH',
          path,
          { name: 'Дом', room: 'Участок', illustrationId: 'house' },
          { actor },
        )
      ).status,
      200,
    );
    assert.equal(
      (await control.dispatch('PATCH', path, { name: 'Новый дом', room: 'Участок' }, { actor }))
        .status,
      200,
    );
    assert.equal(registry.snapshot().devices[0].illustrationId, 'house');
    const confirmed = saves;
    for (const illustrationId of [null, '<svg/>', '../house.svg', 'unknown', 1, {}])
      await assert.rejects(
        control.dispatch(
          'PATCH',
          path,
          { name: 'Не сохранено', room: 'Дом', illustrationId },
          { actor },
        ),
        { statusCode: 400 },
      );
    for (const role of ['operator', 'viewer'] as const)
      await assert.rejects(
        control.dispatch(
          'PATCH',
          path,
          { name: 'Не сохранено', room: 'Дом', illustrationId: 'garage' },
          { actor: { userId: role, role } },
        ),
        { statusCode: 403 },
      );
    assert.equal(saves, confirmed);
    assert.equal(registry.snapshot().devices[0].name, 'Новый дом');
    assert.equal(registry.snapshot().devices[0].illustrationId, 'house');
    assert.equal(plcWrites, 0);
  } finally {
    control.close();
    await scenes.stop();
    registry.close();
  }
});
