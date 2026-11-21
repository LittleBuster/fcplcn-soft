/** @file Authenticate the private PLC proxy and scope the embedded editor to one device. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HubEngine, ManagementReply, Product } from '../shared/types.js';
import { loadConfig } from '../server/config.js';
import { createHubServer } from '../server/http.js';

test('PLC frame and service proxy require hub login, preserve private arrays and do not leak backups', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fcplcn-mgmt-http-'));
  const webDir = join(directory, 'web'),
    plcDir = join(directory, 'plc');
  await mkdir(webDir);
  await mkdir(plcDir);
  await writeFile(join(webDir, 'index.html'), '<title>FCPLCn</title>');
  await writeFile(
    join(plcDir, 'index.html'),
    '<meta name="fcplcn-api-base" content="__FCPLCN_API_BASE__">',
  );
  await writeFile(join(plcDir, 'app.js'), '/* canonical PLC service UI */');
  const product: Product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };
  const config = loadConfig(
    { FCPLCN_HUB_PASSWORD: 'mgmt-test-password', FCPLCN_HUB_DATA_DIR: directory },
    [],
  );
  const seen: { id: string; method: string; path: string; body: unknown }[] = [];
  let busy = false;
  let finishWrite: (() => void) | undefined;
  const engine: HubEngine = {
    async start() {},
    async stop() {},
    rename() {},
    snapshot: () => ({
      broker: { connected: true, error: null },
      commands: [],
      devices: [
        {
          id: 'fcplcn-test',
          name: 'PLC',
          room: '',
          boardId: 'fcplcn-161608-1v0',
          firmwareVersion: 'test',
          bootId: 'boot',
          online: true,
          status: 'online',
          lastSeenAt: new Date().toISOString(),
          uptimeSec: 1,
          controllers: {},
          management: { version: 1, supported: true, sequence: 0, busy },
        },
      ],
    }),
    async command() {
      throw new Error('Control path should not be invoked');
    },
    async service(id, method, path, body): Promise<ManagementReply> {
      seen.push({ id, method, path, body });
      if (method === 'POST')
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
      return {
        schemaVersion: 1,
        requestId: 'test',
        bootId: 'boot',
        sequence: 1,
        status: 200,
        data:
          path === '/board-profiles'
            ? [{ boardId: 'fcplcn-161608-1v0' }]
            : path === '/config/backup'
              ? { password: 'private-backup-only' }
              : { ok: true, user: { username: 'admin' } },
      };
    },
  };
  const server = createHubServer({
    config,
    engine,
    product,
    webDir,
    plcDir,
    onManualCommandBusy: (value) => {
      busy = value;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = (path: string, method = 'GET', body?: unknown, origin?: string) =>
    fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await call('/plc/fcplcn-test/')).status, 401);
    assert.equal((await call('/api/v1/devices/fcplcn-test/service/config')).status, 401);
    const login = await call('/api/v1/auth/login', 'POST', {
      username: 'admin',
      password: config.password,
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    const frame = await call('/plc/fcplcn-test/');
    assert.equal(frame.status, 200);
    assert.match(frame.headers.get('content-security-policy')!, /frame-ancestors 'self'/);
    assert.match(await frame.text(), /content="\/api\/v1\/devices\/fcplcn-test\/service"/);
    assert.equal((await call('/plc/fcplcn-unknown/')).status, 404);
    assert.equal((await call('/plc-assets/app.js')).status, 200);
    assert.equal((await call('/plc-assets/index.html')).status, 404);
    const profiles = await call('/api/v1/devices/fcplcn-test/service/board-profiles');
    assert.deepEqual(await profiles.json(), [{ boardId: 'fcplcn-161608-1v0' }]);
    const backup = await call('/api/v1/devices/fcplcn-test/service/config/backup');
    assert.equal(backup.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await backup.json(), { password: 'private-backup-only' });
    assert.equal(
      (await call('/api/v1/overview').then((reply) => reply.text())).includes(
        'private-backup-only',
      ),
      false,
    );
    assert.equal((await call('/api/v1/devices/fcplcn-test/service/anything')).status, 404);
    const write = call('/api/v1/devices/fcplcn-test/service/config', 'POST', {
      baseRevision: 1,
      device: { name: 'New name' },
    });
    for (let index = 0; index < 50 && !finishWrite; ++index)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(busy, true);
    assert.equal((await call('/api/v1/scenes/home/run', 'POST', {})).status, 409);
    assert.equal(
      (
        await call('/api/v1/devices/fcplcn-test/commands', 'POST', {
          controller: 'sockets',
          itemId: 'socket-1',
          value: true,
        })
      ).status,
      409,
    );
    finishWrite!();
    assert.equal((await write).status, 200);
    assert.equal(busy, false);
    assert.equal(
      (
        await call(
          '/api/v1/devices/fcplcn-test/service/config',
          'POST',
          {},
          'http://external.invalid',
        )
      ).status,
      403,
    );
    assert.equal(seen.at(-1)!.id, 'fcplcn-test');
    assert.deepEqual(seen.at(-1)!.body, { baseRevision: 1, device: { name: 'New name' } });
    const localLogin = await call('/api/v1/devices/fcplcn-test/service/login', 'POST', {});
    assert.equal(localLogin.status, 200);
    assert.equal(seen.at(-1)!.method, 'GET');
    assert.equal(seen.at(-1)!.path, '/config');
    assert.equal(
      (await call('/api/v1/devices/fcplcn-test/service/logout', 'POST', {})).status,
      200,
    );
    assert.equal(
      (await call('/api/v1/overview')).status,
      200,
      'PLC view logout never revokes the hub session',
    );
  } finally {
    finishWrite?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
