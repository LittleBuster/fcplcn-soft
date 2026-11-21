/** @file Exercise the real HTTP boundary: LAN authentication, origin checks and durable labels. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { HubEngine, Product } from '../shared/types.js';
import { createHubServer } from '../server/http.js';
import { loadConfig } from '../server/config.js';
import { LabelStore } from '../server/storage.js';

const product: Product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };
function fixtureEngine(): HubEngine {
  return {
    async start() {},
    async stop() {},
    snapshot: () => ({ broker: { connected: false, error: null }, devices: [], commands: [] }),
    command: async (deviceId, controller, itemId, value) => ({
      id: 'request-1',
      deviceId,
      controller,
      itemId,
      value,
      sequence: 1,
      status: 'unknown',
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: 'Нет подтверждения PLC',
    }),
    rename() {},
  };
}

test('LAN listener supports the default account and malformed broker settings fail before listening', () => {
  assert.equal(loadConfig({ FCPLCN_HUB_HOST: '0.0.0.0' }, []).password, '');
  assert.throws(() => loadConfig({ FCPLCN_HUB_PASSWORD: 'short' }, []), /Пароль/);
  assert.throws(() => loadConfig({ FCPLCN_HUB_MQTT_URL: 'https://example.com' }, []), /брокера/);
  const config = loadConfig({}, ['--demo']);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.mode, 'demo');
});

test('Hub labels survive a restart; invalid storage is reported instead of silently discarded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fcplcn-hub-labels-'));
  try {
    const store = new LabelStore(directory);
    assert.deepEqual(store.load(), {});
    const labels = { 'fcplcn-unit-1': { name: 'Котельная', room: 'Первый этаж' } };
    store.save(labels);
    assert.deepEqual({ ...new LabelStore(directory).load() }, labels);
    await writeFile(store.path, '{"version":0,"devices":{}}');
    assert.throws(() => store.load(), /формат/);
    await writeFile(store.path, '{"version":1,"devices":{"__proto__":{"name":"x","room":"y"}}}');
    assert.throws(() => store.load(), /Повреждены/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Real HTTP requires login, rejects cross-origin writes and keeps an unconfirmed command unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fcplcn-hub-http-'));
  const webDir = join(directory, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>FCPLCn</title>');
  const config = loadConfig(
    { FCPLCN_HUB_PASSWORD: 'local-hub-test-password', FCPLCN_HUB_DATA_DIR: directory },
    [],
  );
  const server = createHubServer({ config, engine: fixtureEngine(), product, webDir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, data: unknown, headers: Record<string, string> = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/api/v1/overview')).status, 401);
    assert.equal(
      ((await fetch(base + '/api/v1/session').then((r) => r.json())) as { authenticated: boolean })
        .authenticated,
      false,
    );
    assert.equal(
      (
        await post(
          '/api/v1/auth/login',
          { username: 'admin', password: config.password },
          { Origin: 'http://foreign.local' },
        )
      ).status,
      403,
    );
    assert.equal(
      (await post('/api/v1/auth/login', { username: 'admin', password: 'wrong' })).status,
      401,
    );
    const login = await post('/api/v1/auth/login', {
      username: 'admin',
      password: config.password,
    });
    assert.equal(login.status, 200);
    assert.equal(((await login.json()) as { authenticated: boolean }).authenticated, true);
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const headers = { Cookie: cookie.split(';')[0] };
    const overview = await fetch(base + '/api/v1/overview', { headers });
    assert.equal(overview.status, 200);
    assert.equal(overview.headers.get('cache-control'), 'no-store');
    assert.equal(
      (
        await post(
          '/api/v1/devices/fcplcn-unit-1/commands',
          { controller: 'sockets', itemId: 'socket-1', value: 'toggle' },
          headers,
        )
      ).status,
      400,
    );
    const command = await post(
      '/api/v1/devices/fcplcn-unit-1/commands',
      { controller: 'sockets', itemId: 'socket-1', value: true },
      headers,
    );
    assert.equal(command.status, 200);
    assert.equal(((await command.json()) as { status: string }).status, 'unknown');
    assert.equal((await post('/api/v1/auth/logout', {}, headers)).status, 200);
    assert.equal((await fetch(base + '/api/v1/overview', { headers })).status, 401);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(base + '/health', { headers: { Host: 'rebound.invalid' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on('error', reject)
        .end();
    });
    assert.equal(wrongHost, 403);
    const oversized = await post('/api/v1/auth/login', { padding: 'x'.repeat(9000) });
    assert.equal(oversized.status, 413);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Repeated wrong passwords are bounded before expensive derivation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fcplcn-hub-throttle-'));
  const config = loadConfig(
    { FCPLCN_HUB_PASSWORD: 'local-hub-test-password', FCPLCN_HUB_DATA_DIR: directory },
    [],
  );
  const server = createHubServer({ config, engine: fixtureEngine(), product, webDir: '.' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/auth/login`;
  try {
    for (let count = 0; count < 5; ++count)
      assert.equal(
        (
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"username":"admin","password":"wrong"}',
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: config.password }),
        })
      ).status,
      429,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
