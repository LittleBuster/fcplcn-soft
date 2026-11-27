/** @file Verify scene editing and execution through the authenticated HTTP boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { Product, SceneDefinition, ScenesSnapshot } from '../shared/types.js';
import { createEngine } from '../src/engine.js';
import { loadConfig, engineOptions } from '../server/config.js';
import { createHubServer } from '../server/http.js';
import { Scenes } from '../server/scenes.js';
import { SceneScheduler } from '../server/scheduler.js';

const product: Product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('HTTP persists editable actions and schedules, protects builtins and serializes scenes with manual commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fcplcn-scenes-api-'));
  const config = loadConfig(
    {
      FCPLCN_HUB_MODE: 'demo',
      FCPLCN_HUB_PASSWORD: 'scene-api-password',
      FCPLCN_HUB_DATA_DIR: directory,
    },
    [],
  );
  const engine = createEngine(engineOptions(config, product, { labels: {}, onLabelsChanged() {} }));
  await engine.start();
  const scenes = new Scenes(engine, { directory, demo: true });
  let manualBusy = false;
  const scheduler = new SceneScheduler(scenes, { directory, canRun: () => !manualBusy });
  const server = createHubServer({
    config,
    engine,
    product,
    webDir: directory,
    scenes,
    scheduler,
    onManualCommandBusy: (busy) => {
      manualBusy = busy;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const request = (route: string, method = 'GET', data?: unknown) =>
    fetch(base + '/api/v1' + route, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  const snapshot = () =>
    request('/scenes').then((response) => response.json()) as Promise<ScenesSnapshot>;
  async function idle() {
    for (let index = 0; index < 100; ++index) {
      if (!(await snapshot()).activeRun) return;
      await wait(20);
    }
    assert.fail('Scene did not finish');
  }
  try {
    assert.equal((await request('/scenes')).status, 401);
    const login = await request('/auth/login', 'POST', {
      username: 'admin',
      password: config.password,
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    const initial = await snapshot();
    assert.deepEqual(
      initial.definitions.map((scene) => scene.name),
      ['Я дома', 'Ушел', 'Готовлюсь'],
    );
    const home = initial.definitions.find((scene) => scene.id === 'home')!;
    const action = {
      id: 'contactor',
      deviceId: 'fcplcn-demo-living',
      controller: 'sockets',
      itemId: 'socket-window',
      value: true,
    };
    const edit = await request('/scenes/home', 'PUT', {
      baseRevision: home.revision,
      actions: [action],
    });
    assert.equal(edit.status, 200);
    assert.equal(((await edit.json()) as SceneDefinition).actions[0].value, true);
    assert.equal(
      (await request('/scenes/home', 'PUT', { baseRevision: home.revision, actions: [] })).status,
      409,
    );
    const changedHome = (await snapshot()).definitions.find((scene) => scene.id === 'home')!;
    assert.ok(
      (await request('/scenes/home', 'DELETE', { baseRevision: changedHome.revision })).status >=
        400,
    );
    const schedule = {
      enabled: true,
      days: [1, 3, 5],
      time: '18:30',
      timeZone: 'Asia/Novosibirsk',
    };
    const created = await request('/scenes', 'POST', {
      name: 'Вечерний свет',
      description: 'Включить подсветку',
      actions: [{ ...action, id: 'evening', controller: 'lights', itemId: 'light-evening' }],
      schedule,
    });
    assert.equal(created.status, 201);
    const custom = (await created.json()) as SceneDefinition;
    assert.match(custom.id, /^scene-/);
    assert.deepEqual(custom.schedule, schedule);
    const invalid = await request('/scenes/' + custom.id, 'PUT', {
      baseRevision: custom.revision,
      actions: custom.actions,
      schedule: { ...schedule, time: '25:99' },
    });
    assert.equal(invalid.status, 400);
    const schedulePath = '/scenes/' + custom.id + '/schedule';
    const setSchedule = (baseRevision: number, enabled: boolean) =>
      request(schedulePath, 'PUT', { baseRevision, enabled });
    assert.equal(
      (
        await request('/scenes/home/schedule', 'PUT', {
          baseRevision: changedHome.revision,
          enabled: true,
        })
      ).status,
      400,
    );
    const pausedResponse = await setSchedule(custom.revision, false);
    assert.equal(pausedResponse.status, 200);
    const paused = (await pausedResponse.json()) as SceneDefinition;
    assert.deepEqual(paused, {
      ...custom,
      revision: custom.revision + 1,
      schedule: { ...schedule, paused: true },
    });
    assert.equal((await setSchedule(custom.revision, true)).status, 409);
    const editedResponse = await request('/scenes/' + custom.id, 'PUT', {
      baseRevision: paused.revision,
      actions: custom.actions,
      schedule,
    });
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json()) as SceneDefinition;
    assert.deepEqual(edited.schedule, paused.schedule, 'Editing a schedule preserves a pause');
    const reconstructed = new Scenes(engine, { directory });
    assert.deepEqual(
      reconstructed.snapshot().definitions.find((scene) => scene.id === custom.id)?.schedule,
      paused.schedule,
    );
    await reconstructed.stop();
    const resumedResponse = await setSchedule(edited.revision, true);
    assert.equal(resumedResponse.status, 200);
    const resumed = (await resumedResponse.json()) as SceneDefinition;
    assert.deepEqual(resumed.schedule, { ...schedule, paused: false });
    assert.equal((await snapshot()).runs.length, 0, 'Toggling schedules never runs their actions');
    const started = await request('/scenes/home/run', 'POST', {});
    assert.equal(started.status, 202);
    assert.equal(
      (
        await request('/devices/fcplcn-demo-living/commands', 'POST', {
          controller: 'sockets',
          itemId: 'socket-tv',
          value: false,
        })
      ).status,
      409,
    );
    assert.equal((await request('/scenes/away/run', 'POST', {})).status, 409);
    await idle();
    assert.equal((await snapshot()).runs[0].status, 'completed');
    assert.equal(
      engine.snapshot().devices.find((device) => device.id === 'fcplcn-demo-living')?.controllers
        .sockets?.data.items instanceof Array,
      true,
    );
    const slowPayload = JSON.stringify({ controller: 'lights', itemId: 'light-main', value: true });
    const slowRequest = httpRequest(base + '/api/v1/devices/fcplcn-demo-living/commands', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(slowPayload),
      },
    });
    const slowResponse = new Promise<number | undefined>((resolve, reject) => {
      slowRequest.once('response', (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      slowRequest.once('error', reject);
    });
    slowRequest.write(slowPayload.slice(0, 10));
    await wait(5);
    assert.equal((await request('/scenes/home/run', 'POST', {})).status, 202);
    slowRequest.end(slowPayload.slice(10));
    assert.equal(
      await slowResponse,
      409,
      'A command body received after a scene starts cannot bypass the lock',
    );
    await idle();
    const manual = request('/devices/fcplcn-demo-living/commands', 'POST', {
      controller: 'lights',
      itemId: 'light-main',
      value: false,
    });
    for (let attempt = 0; attempt < 30 && !manualBusy; ++attempt) await wait(2);
    assert.equal(manualBusy, true);
    assert.equal((await request('/scenes/prepare/run', 'POST', {})).status, 409);
    assert.equal((await manual).status, 200);
    const deletion = await request('/scenes/' + custom.id, 'DELETE', {
      baseRevision: resumed.revision,
    });
    assert.equal(deletion.status, 200);
    assert.equal(
      (await snapshot()).definitions.some((scene) => scene.id === custom.id),
      false,
    );
    assert.equal((await request('/scenes/home/run', 'POST', { retain: true })).status, 400);
  } finally {
    scheduler.stop();
    await Promise.all([scenes.stop(), engine.stop()]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
