/** @file Persisted administrator credentials, explicit empty-password login and revocation boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HubEngine } from '../shared/types.js';
import { CredentialStore } from '../server/credentials.js';
import { createHubServer } from '../server/http.js';
import { loadConfig } from '../server/config.js';

test('private account bootstraps once, preserves hashes on rename and rejects damaged or linked files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-account-store-'));
  try {
    const store = new CredentialStore(directory);
    assert.deepEqual(store.snapshot(), { username: 'admin' });
    assert.equal(store.matches('admin', ''), true);
    assert.equal(store.matches('other', ''), false);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    store.update('owner', 'private-current-password');
    const saved = JSON.parse(readFileSync(store.path, 'utf8')) as { passwordHash: string };
    assert.equal(readFileSync(store.path, 'utf8').includes('private-current-password'), false);
    store.update('renamed');
    assert.equal(
      (JSON.parse(readFileSync(store.path, 'utf8')) as typeof saved).passwordHash,
      saved.passwordHash,
    );
    const restarted = new CredentialStore(directory, 'environment-does-not-reset');
    assert.equal(restarted.matches('renamed', 'private-current-password'), true);
    assert.equal(restarted.matches('admin', 'environment-does-not-reset'), false);
    writeFileSync(store.path, '{broken');
    assert.throws(() => new CredentialStore(directory), /Повреждён/);
    assert.equal(readFileSync(store.path, 'utf8'), '{broken');
    writeFileSync(store.path, 'x'.repeat(4097));
    assert.throws(() => new CredentialStore(directory), /обычном файле/);
    rmSync(store.path);
    symlinkSync(join(directory, 'missing'), store.path);
    assert.throws(() => new CredentialStore(directory), /обычном файле/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('default admin/empty still requires login, account changes reauthenticate all sessions and survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-account-http-'));
  const engine: HubEngine = {
    async start() {},
    async stop() {},
    rename() {},
    snapshot: () => ({ broker: { connected: false, error: null }, devices: [], commands: [] }),
    async command() {
      throw new Error('Account tests do not actuate equipment');
    },
  };
  async function open(password = '') {
    const config = loadConfig(
      {
        FCPLCN_HUB_MODE: 'demo',
        FCPLCN_HUB_HOST: '0.0.0.0',
        FCPLCN_HUB_DATA_DIR: directory,
        FCPLCN_HUB_PASSWORD: password,
      },
      [],
    );
    const server = createHubServer({
      config,
      engine,
      product: { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' },
      webDir: directory,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    return {
      server,
      call: (path: string, payload?: unknown, cookie = '', origin?: string) =>
        fetch(base + path, {
          method: payload === undefined ? 'GET' : 'POST',
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(origin ? { Origin: origin } : {}),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        }),
    };
  }
  const close = async (server: ReturnType<typeof createHubServer>) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  let fixture = await open();
  const cookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
  try {
    assert.equal((await fixture.call('/overview')).status, 401);
    assert.equal((await fixture.call('/account')).status, 401);
    const session = (await fixture.call('/session').then((response) => response.json())) as {
      authenticated: boolean;
      requiresLogin: boolean;
    };
    assert.equal(session.requiresLogin, true);
    assert.equal(session.authenticated, false);
    const first = await fixture.call('/auth/login', { username: 'admin', password: '' });
    const second = await fixture.call('/auth/login', { username: 'admin', password: '' });
    assert.equal(first.status, 200);
    const firstCookie = cookie(first),
      secondCookie = cookie(second);
    assert.deepEqual(
      await fixture.call('/account', undefined, firstCookie).then((response) => response.json()),
      { username: 'admin' },
    );
    assert.equal(
      (
        await fixture.call(
          '/account',
          { username: 'owner', currentPassword: '' },
          firstCookie,
          'https://foreign.example',
        )
      ).status,
      403,
    );
    assert.equal(
      (await fixture.call('/account', { username: 'owner', currentPassword: 'wrong' }, firstCookie))
        .status,
      403,
    );
    assert.equal(
      (
        await fixture.call(
          '/account',
          { username: 'owner', currentPassword: '', newPassword: 'short' },
          firstCookie,
        )
      ).status,
      400,
    );
    assert.equal((await fixture.call('/overview', undefined, firstCookie)).status, 200);
    const changed = await fixture.call(
      '/account',
      { username: 'owner', currentPassword: '', newPassword: 'owner-password' },
      firstCookie,
    );
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal((await fixture.call('/overview', undefined, firstCookie)).status, 401);
    assert.equal((await fixture.call('/overview', undefined, secondCookie)).status, 401);
    assert.equal(
      (await fixture.call('/auth/login', { username: 'admin', password: '' })).status,
      401,
    );
    let login = await fixture.call('/auth/login', {
      username: 'owner',
      password: 'owner-password',
    });
    assert.equal(login.status, 200);
    assert.equal(
      (
        await fixture.call(
          '/account',
          { username: 'owner-two', currentPassword: 'owner-password' },
          cookie(login),
        )
      ).status,
      200,
    );
    await close(fixture.server);
    fixture = await open('bootstrap-is-ignored');
    login = await fixture.call('/auth/login', {
      username: 'owner-two',
      password: 'owner-password',
    });
    assert.equal(login.status, 200);
    assert.equal(
      (
        await fixture.call(
          '/account',
          { username: 'owner-two', currentPassword: 'owner-password', newPassword: '' },
          cookie(login),
        )
      ).status,
      200,
    );
    login = await fixture.call('/auth/login', { username: 'owner-two', password: '' });
    assert.equal(login.status, 200);
    assert.equal((await fixture.call('/auth/logout', {}, cookie(login))).status, 200);
    assert.equal((await fixture.call('/overview', undefined, cookie(login))).status, 401);
  } finally {
    await close(fixture.server);
    rmSync(directory, { recursive: true, force: true });
  }
});
