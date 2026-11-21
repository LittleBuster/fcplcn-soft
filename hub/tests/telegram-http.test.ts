/** @file Administrator Telegram settings and one shared control gate for web and bot actions. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createEngine } from '../src/engine.js';
import { loadConfig, engineOptions } from '../server/config.js';
import { createHubServer } from '../server/http.js';
import { Scenes } from '../server/scenes.js';
import { TelegramStore } from '../server/telegram/store.js';
import { TelegramAPIError } from '../server/telegram/client.js';
import type { TelegramActions } from '../server/telegram/menu.js';
import type { TelegramRuntimeStatus, TelegramView } from '../shared/telegram.js';

const product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };
const token = '123456789:' + 'A'.repeat(35);

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-telegram-http-'));
  const config = loadConfig(
    {
      FCPLCN_HUB_MODE: 'demo',
      FCPLCN_HUB_PASSWORD: 'telegram-http-check',
      FCPLCN_HUB_DATA_DIR: directory,
    },
    [],
  );
  const engine = createEngine(
    engineOptions(config, product, {
      labels: {},
      onLabelsChanged() {},
    }),
  );
  await engine.start();
  const scenes = new Scenes(engine, { directory, demo: true });
  const store = new TelegramStore(directory);
  const status: TelegramRuntimeStatus = {
    state: 'disabled',
    botUsername: '',
    botName: '',
    lastPollAt: null,
    error: null,
  };
  let actions!: TelegramActions;
  let checks = 0;
  let checkError: TelegramAPIError | null = null;
  let schedulerBusy = false;
  const server = createHubServer({
    config,
    product,
    engine,
    scenes,
    webDir: directory,
    telegram: {
      snapshot: () => ({ ...store.snapshot(), status }),
      update(patch) {
        store.update(patch);
        return { ...store.snapshot(), status };
      },
      async test() {
        checks++;
        if (checkError) throw checkError;
        return { ok: true };
      },
    },
    onControlReady(value) {
      actions = value;
    },
    onManualCommandBusy(value) {
      schedulerBusy = value;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  let cookie = '';
  const call = (path: string, payload?: unknown, origin?: string) =>
    fetch(base + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  const login = async () => {
    const response = await call('/api/v1/auth/login', {
      username: 'admin',
      password: config.password,
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  };
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await scenes.stop();
    await engine.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    actions,
    engine,
    call,
    login,
    checks: () => checks,
    busy: () => schedulerBusy,
    testError(error: TelegramAPIError) {
      checkError = error;
    },
  };
}

test('Telegram settings require administrator login, reject cross-site writes and never expose the token', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/v1/telegram')).status, 401);
  assert.equal((await f.call('/api/v1/telegram', {})).status, 401);
  assert.equal((await f.call('/api/v1/telegram/test', {})).status, 401);
  assert.equal(f.checks(), 0);
  await f.login();
  const initial = await f.call('/api/v1/telegram');
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const view = (await initial.json()) as TelegramView;
  const patch = {
    baseRevision: view.config.revision,
    enabled: true,
    token,
    chats: [{ chatId: '12345678901', name: 'Сергей' }],
  };
  assert.equal((await f.call('/api/v1/telegram', patch, 'https://external.invalid')).status, 403);
  const saved = await f.call('/api/v1/telegram', patch);
  assert.equal(saved.status, 200);
  const serialized = await saved.text();
  assert.equal(serialized.includes(token), false);
  const confirmed = JSON.parse(serialized);
  assert.equal(confirmed.config.tokenConfigured, true);
  assert.equal(confirmed.config.chats[0].name, 'Сергей');
  assert.equal((await f.call('/api/v1/telegram', patch)).status, 409);
  f.store.observeContact({
    chatId: '9988776655',
    name: 'Анна',
    username: 'anna_fcplcn',
    receivedAt: new Date().toISOString(),
  });
  const latest = (await f
    .call('/api/v1/telegram')
    .then((response) => response.json())) as TelegramView;
  assert.ok(latest.lastContact);
  assert.equal(latest.lastContact.chatId, '9988776655');
  assert.equal(latest.lastContact.username, 'anna_fcplcn');
  assert.equal(f.store.allowed('9988776655'), false, 'Discovery never grants access');
  assert.equal((await f.call('/api/v1/telegram/test', { token })).status, 400);
  assert.equal(f.checks(), 0);
  assert.equal((await f.call('/api/v1/telegram/test', {})).status, 200);
  assert.equal(f.checks(), 1);
  f.testError(new TelegramAPIError('Telegram отклонил токен бота', 401));
  const rejected = await f.call('/api/v1/telegram/test', {});
  assert.equal(rejected.status, 400, 'A bad bot token does not expire the administrator session');
  assert.match(((await rejected.json()) as { error: string }).error, /отклонил токен/);
  f.testError(new TelegramAPIError('Нет связи с Telegram'));
  const disconnected = await f.call('/api/v1/telegram/test', {});
  assert.equal(disconnected.status, 503);
  assert.equal(((await disconnected.json()) as { error: string }).error, 'Нет связи с Telegram');
  assert.equal((await f.call('/api/v1/telegram')).status, 200);
  const overview = await f.call('/api/v1/overview').then((response) => response.text());
  assert.equal(overview.includes(token), false);
  assert.equal(overview.includes('9988776655'), false);
});

test('Trusted bot actions share OTA, scene and manual-command locks with the web and scheduler', async (t) => {
  const f = await fixture(t);
  await f.login();
  const id = 'fcplcn-demo-living';
  const service = '/api/v1/devices/' + id + '/service';
  const begin = await f.call(service + '/firmware/begin', { size: 16384, sha256: '1'.repeat(64) });
  assert.equal(begin.status, 200);
  const upload = (await begin.json()) as { uploadId: string };
  assert.equal(f.busy(), true);
  await assert.rejects(
    f.actions.command(id, 'sockets', 'socket-window', true),
    /обновления|настроек/,
  );
  assert.throws(() => f.actions.runScene('home'), /текущей команды/);
  assert.equal(f.engine.snapshot().commands.length, 0);
  assert.equal(
    (await f.call(service + '/firmware/abort', { uploadId: upload.uploadId })).status,
    200,
  );
  assert.equal(f.busy(), false);
  const command = f.actions.command(id, 'sockets', 'socket-window', true);
  assert.equal(f.busy(), true, 'A Telegram command pauses scheduled starts until its confirmation');
  assert.throws(() => f.actions.runScene('home'), /текущей команды/);
  assert.equal((await command).status, 'applied');
  assert.equal(f.busy(), false);
  const run = f.actions.runScene('prepare');
  assert.equal(run.status, 'running');
  await assert.rejects(f.actions.command(id, 'sockets', 'socket-window', false), /сценария/);
  const deadline = Date.now() + 5000;
  while (f.actions.scenes().activeRun && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.actions.scenes().activeRun, null);
});
