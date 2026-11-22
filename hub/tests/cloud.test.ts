/** @file Private cloud enrollment state, application permissions and common maintenance guards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HubCloudStore, checkedCloudOrigin } from '../server/cloud/store.js';
import { HubCloud } from '../server/cloud/uplink.js';
import { HubControl } from '../server/control.js';
import { Scenes } from '../server/scenes.js';
import { cloudPermitted, cloudRoute } from '../shared/cloud.js';
import type { HubEngine, EngineSnapshot, CommandView } from '../shared/types.js';

const claim = {
  protocolVersion: 1,
  hubId: 'hub-test',
  homeId: 'home-test',
  broker: {
    username: 'hub-test',
    password: 'private-cloud-password-'.repeat(3),
    brokerUrl: 'mqtts://example.invalid:8883',
  },
};
const temporary = () => mkdtempSync(join(tmpdir(), 'fcplcn-hub-cloud-'));

test('Cloud credentials are private, identity is durable and disabled defaults do not contact a server', async () => {
  const directory = temporary();
  try {
    const store = new HubCloudStore(directory);
    store.ensureIdentity();
    const identity = store.privateConfig().installationId;
    assert.equal(store.publicConfig().enabled, false);
    assert.equal(new HubCloudStore(directory).privateConfig().installationId, identity);
    store.pair('https://cloud.example', claim, 'Наш дом');
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(store.publicConfig()).includes(claim.broker.password), false);
    assert.equal(store.publicConfig().paired, true);
    const revision = store.publicConfig().revision;
    assert.throws(() => store.update({ baseRevision: revision - 1, enabled: false }), /изменены/);
    store.update({ baseRevision: revision, enabled: false });
    let calls = 0;
    const unusedControl = {} as HubControl;
    const cloud = new HubCloud(store, unusedControl, {
      request: (async () => {
        calls++;
        throw new Error('must not run');
      }) as typeof fetch,
    });
    cloud.start();
    await cloud.stop();
    assert.equal(calls, 0);
    assert.equal(store.privateConfig().claim?.broker.password, claim.broker.password);
    store.disconnect();
    assert.equal(new HubCloudStore(directory).publicConfig().paired, false);
    assert.equal(new HubCloudStore(directory).privateConfig().installationId, identity);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Cloud URL parsing and corrupt/symlink credentials fail closed without erasing evidence', () => {
  assert.equal(checkedCloudOrigin('https://cloud.example/'), 'https://cloud.example');
  for (const url of [
    'http://cloud.example',
    'https://user:pass@cloud.example',
    'https://cloud.example/other',
    'https://cloud.example/#x',
  ])
    assert.throws(() => checkedCloudOrigin(url));
  assert.equal(checkedCloudOrigin('http://127.0.0.1:4100', true), 'http://127.0.0.1:4100');
  const directory = temporary();
  try {
    const path = join(directory, 'cloud.json');
    writeFileSync(path, '{broken');
    const store = new HubCloudStore(directory);
    assert.ok(store.error);
    assert.equal(store.privateConfig().enabled, false);
    assert.throws(() => store.pair('https://cloud.example', claim, 'Дом'), /прочитать/);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
    rmSync(path);
    symlinkSync(join(directory, 'absent.json'), path);
    assert.ok(
      new HubCloudStore(directory).error,
      'Dangling symlinks are not mistaken for missing credentials',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Remote role allowlist does not expose private services or maintenance to a viewer/operator', () => {
  const viewer = { userId: 'v', role: 'viewer' as const },
    operator = { userId: 'o', role: 'operator' as const };
  assert.equal(cloudPermitted(viewer, 'GET', '/overview'), true);
  const owner = { userId: 'owner', role: 'owner' as const };
  assert.equal(cloudPermitted(owner, 'GET', '/pult/settings'), true);
  assert.equal(cloudPermitted(owner, 'PUT', '/pult/settings'), true);
  for (const actor of [viewer, operator]) {
    assert.equal(cloudPermitted(actor, 'GET', '/pult/settings'), false);
    assert.equal(cloudPermitted(actor, 'PUT', '/pult/settings'), false);
  }
  for (const path of [
    '/telegram',
    '/devices/fcplcn-test/service/config',
    '/devices/fcplcn-test/service/config/backup',
    '/firmware/jobs/job-1',
  ])
    assert.equal(cloudPermitted(viewer, 'GET', path), false);
  assert.equal(
    cloudPermitted(operator, 'POST', '/devices/fcplcn-test/commands', {
      controller: 'security',
      itemId: 'alarm',
      value: false,
    }),
    false,
  );
  assert.equal(
    cloudPermitted(
      { ...operator, securityControl: true },
      'POST',
      '/devices/fcplcn-test/commands',
      { controller: 'security', itemId: 'alarm', value: false },
    ),
    true,
  );
  assert.equal(cloudRoute('POST', '/cloud/pair'), false);
  assert.equal(cloudRoute('GET', '/arbitrary/url'), false);
});

test('The local authority inspects live scene security and reserves maintenance across transports', async () => {
  let commands = 0,
    services = 0;
  const busy: boolean[] = [];
  const state: EngineSnapshot = {
    broker: { connected: true, error: null },
    commands: [],
    devices: [
      {
        id: 'fcplcn-test',
        name: 'Тест',
        room: '',
        boardId: 'board',
        firmwareVersion: 'test',
        bootId: 'boot',
        online: true,
        status: 'online',
        lastSeenAt: new Date().toISOString(),
        uptimeSec: 120,
        controllers: {
          security: {
            kind: 'security',
            fresh: true,
            receivedAt: new Date().toISOString(),
            data: { enabled: true, readyToArm: true, armed: false, items: [] },
          },
        },
      },
    ],
  };
  const engine: HubEngine = {
    async start() {},
    async stop() {},
    snapshot: () => structuredClone(state),
    rename() {},
    async command(deviceId, controller, itemId, value) {
      commands++;
      return {
        id: 'cmd',
        deviceId,
        controller,
        itemId,
        value,
        sequence: 1,
        status: 'applied',
        createdAt: '',
        completedAt: '',
        error: null,
      } satisfies CommandView;
    },
    async service() {
      services++;
      return {
        schemaVersion: 1,
        requestId: 'request',
        bootId: 'boot',
        sequence: 1,
        status: 200,
        data: { ok: true },
      };
    },
  };
  const scenes = new Scenes(engine);
  const custom = scenes.create('Охрана в сценарии', '', [
    { id: 'a', deviceId: 'fcplcn-test', controller: 'security', itemId: 'alarm', value: false },
  ]);
  const control = new HubControl({
    engine,
    scenes,
    product: { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' },
    mode: 'demo',
    onBusy: (value) => busy.push(value),
  });
  try {
    await assert.rejects(
      control.dispatch(
        'POST',
        '/scenes/' + custom.id + '/run',
        {},
        { actor: { userId: 'operator', role: 'operator', securityControl: false } },
      ),
      /охраной/,
    );
    assert.equal(commands, 0);
    const release = control.holdMaintenance();
    await assert.rejects(control.command('fcplcn-test', 'sockets', 'socket-1', true), /обновления/);
    await assert.rejects(control.service('fcplcn-test', 'POST', '/config', {}), /обслуживание/);
    assert.throws(() => control.runScene('home'), /текущей команды/);
    assert.equal(
      (await control.service('fcplcn-test', 'POST', '/firmware/abort', {}, { maintenance: true }))
        .status,
      200,
    );
    assert.equal(services, 1);
    release();
    release();
    assert.equal(busy.at(-1), false);
  } finally {
    control.close();
    await scenes.stop();
  }
});
