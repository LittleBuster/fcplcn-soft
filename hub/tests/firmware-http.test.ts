/** @file OTA authentication and whole-upload scenario lock share the existing private service API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createEngine } from '../src/engine.js';
import { createHubServer } from '../server/http.js';
import { loadConfig } from '../server/config.js';

test('firmware upload requires hub login and pauses scenarios/control across chunk request gaps', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-ota-http-'));
  const product = { name: 'FCPLCn', id: 'fcplcn', fullName: 'Future City PLC Next' };
  const config = loadConfig(
    {
      FCPLCN_HUB_MODE: 'demo',
      FCPLCN_HUB_PASSWORD: 'ota-admin-password',
      FCPLCN_HUB_DATA_DIR: directory,
    },
    [],
  );
  const engine = createEngine({
    mode: 'demo',
    product,
    demoDataDir: directory,
    brokerUrl: 'mqtt://127.0.0.1:1883',
    clientId: 'ota-http',
    staleAfterMs: 45000,
    commandTimeoutMs: 8000,
    labels: {},
    onLabelsChanged() {},
  });
  await engine.start();
  let busy = false;
  const server = createHubServer({
    config,
    engine,
    product,
    webDir: directory,
    onManualCommandBusy: (value) => {
      busy = value;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const id = 'fcplcn-demo-living';
  const service = '/api/v1/devices/' + id + '/service';
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
  const upload = { size: 16080, sha256: '1'.repeat(64) };
  assert.equal((await call(service + '/firmware')).status, 401);
  assert.equal((await call(service + '/firmware/begin', upload)).status, 401);
  const login = await call('/api/v1/auth/login', { username: 'admin', password: config.password });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await call(service + '/firmware/begin', upload, 'https://external.invalid')).status,
    403,
  );
  const started = await call(service + '/firmware/begin', upload);
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  const { uploadId } = (await started.json()) as { uploadId: string };
  assert.equal(busy, true, 'Scheduler lock survives after the begin HTTP request completes');
  assert.equal((await call('/api/v1/scenes/home/run', {})).status, 409);
  assert.equal(
    (
      await call('/api/v1/devices/' + id + '/commands', {
        controller: 'sockets',
        itemId: 'socket-1',
        value: true,
      })
    ).status,
    409,
  );
  assert.equal((await call(service + '/reboot', {})).status, 409);
  assert.equal(
    (await call(service + '/config', { baseRevision: 1, device: { name: 'During OTA' } })).status,
    409,
  );
  assert.equal(
    ((await call(service + '/firmware').then((response) => response.json())) as { state: string })
      .state,
    'receiving',
  );
  assert.equal((await call(service + '/firmware/abort', { uploadId })).status, 200);
  assert.equal(busy, false, 'Confirmed cancellation releases the scheduler lock');
  const configReply = await call(service + '/config');
  const current = (await configReply.json()) as { revision: number };
  assert.equal(
    (
      await call(service + '/config', {
        baseRevision: current.revision,
        device: { name: 'After OTA cancellation' },
      })
    ).status,
    200,
  );
  assert.equal(engine.snapshot().commands.length, 0);
});
