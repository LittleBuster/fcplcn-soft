/** @file PostgreSQL-backed cloud auth, home isolation and private operation authorization. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HubSnapshot } from '../../hub/shared/types.js';
import type { CloudActor, CloudHubView, CloudMethod } from '../../hub/shared/cloud.js';
import { CloudDatabase } from '../server/db.js';
import { createCloudServer } from '../server/http.js';
import { CloudBridgeError } from '../server/bridge.js';
import type { CloudConfig } from '../server/config.js';
import { totp } from '../server/totp.js';
import type { CloudSession, HomeView } from '../shared/api.js';

const databaseUrl = process.env.FCPLCN_CLOUD_TEST_DATABASE_URL;
const options = { skip: !databaseUrl, timeout: 30000 };
const product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };

test(
  'a durable pending intent exists before actuation and completes in the same row',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home();
    await f.claim(home.id);
    let intentId: string | undefined;
    f.duringRequest(async () => {
      const entries = (
        await f.db.query(
          'SELECT id,status,actor_id,detail FROM cloud_audit WHERE home_id=$1 AND operation=$2',
          [home.id, 'POST /devices/fcplcn-test/commands'],
        )
      ).rows;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, 'pending');
      assert.equal(entries[0].actor_id, f.ownerSession.user!.id);
      assert.equal(entries[0].detail, null);
      intentId = entries[0].id;
    });
    const result = await f.owner.call(`/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`, {
      controller: 'sockets',
      itemId: 'outlet',
      value: true,
    });
    assert.equal(result.status, 200);
    assert.ok(intentId);
    const entries = (
      await f.db.query('SELECT id,status FROM cloud_audit WHERE home_id=$1 AND operation=$2', [
        home.id,
        'POST /devices/fcplcn-test/commands',
      ])
    ).rows;
    assert.deepEqual(entries, [{ id: intentId, status: 'confirmed' }]);
  },
);

test(
  'a failed intent commit prevents dispatch and a restart marks unfinished intents unknown',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home();
    await f.claim(home.id);
    const intentId = await f.server.homes.audit(
      home.id,
      f.ownerSession.user!.id,
      'POST /devices/fcplcn-test/commands',
      'hub',
      'pending',
    );
    await f.server.homes.recoverPendingAudit();
    const recovered = (
      await f.db.query('SELECT status,detail FROM cloud_audit WHERE id=$1', [intentId])
    ).rows[0];
    assert.equal(recovered.status, 'unknown');
    assert.match(recovered.detail, /перезапущен/);
    await f.db.query(
      "ALTER TABLE cloud_audit ADD CONSTRAINT reject_pending CHECK (status <> 'pending')",
    );
    const before = f.requests.length;
    const result = await f.owner.call(`/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`, {
      controller: 'sockets',
      itemId: 'outlet',
      value: true,
    });
    assert.equal(result.status, 503);
    assert.equal(
      f.requests.length,
      before,
      'Without durable intent no external mutation is attempted',
    );
    assert.equal(
      (await f.db.query('SELECT status FROM cloud_audit WHERE id=$1', [intentId])).rows[0].status,
      'unknown',
    );
  },
);

test(
  'the journal distinguishes a known unsent refusal from an unconfirmed sent command',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home();
    await f.claim(home.id);
    const path = `/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`;
    f.duringRequest(async () => {
      throw new CloudBridgeError('Запрос не отправлен', 503, false);
    });
    assert.equal(
      (await f.owner.call(path, { controller: 'sockets', itemId: 'outlet', value: true })).status,
      503,
    );
    f.duringRequest(async () => {
      throw new CloudBridgeError('Ответ не получен', 504, true);
    });
    assert.equal(
      (await f.owner.call(path, { controller: 'sockets', itemId: 'outlet', value: false })).status,
      504,
    );
    const rows = (
      await f.db.query(
        'SELECT status FROM cloud_audit WHERE home_id=$1 AND operation=$2 ORDER BY created_at',
        [home.id, 'POST /devices/fcplcn-test/commands'],
      )
    ).rows;
    assert.deepEqual(
      rows.map((row) => row.status),
      ['rejected', 'unknown'],
    );
  },
);
function snapshot(): HubSnapshot {
  return {
    product,
    mode: 'demo',
    now: new Date().toISOString(),
    broker: { connected: true, error: null },
    commands: [],
    devices: [
      {
        id: 'fcplcn-test',
        name: 'Гостиная',
        room: 'Дом',
        boardId: 'fcplcn-161608-1v0',
        firmwareVersion: 'test',
        bootId: 'test-boot',
        status: 'online',
        online: true,
        lastSeenAt: new Date().toISOString(),
        uptimeSec: 100,
        controllers: {
          sockets: {
            kind: 'sockets',
            fresh: true,
            receivedAt: new Date().toISOString(),
            data: {
              enabled: true,
              items: [{ id: 'outlet', name: 'Розетка', actual: false, available: true }],
            },
          },
        },
      },
    ],
    scenes: {
      definitions: [
        { id: 'home', name: 'Я дома', description: '', revision: 1, actions: [] },
        {
          id: 'prepare',
          name: 'Готовлюсь',
          description: '',
          revision: 1,
          actions: [
            {
              id: 'arm',
              deviceId: 'fcplcn-test',
              controller: 'security',
              itemId: 'alarm',
              value: true,
            },
          ],
        },
      ],
      activeRun: null,
      runs: [],
    },
  };
}
async function fixture(t: TestContext, defaultAdmin = false) {
  const schema = 'cloud_test_' + randomBytes(8).toString('hex');
  const admin = new CloudDatabase(databaseUrl!);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new CloudDatabase(databaseUrl!, { schema });
  await db.migrate(await readFile(resolve('server/migrations/001_initial.sql'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'fcplcn-cloud-backend-'));
  const webDir = join(directory, 'web'),
    portalDir = join(directory, 'portal'),
    plcDir = join(directory, 'plc');
  await Promise.all([mkdir(webDir), mkdir(portalDir), mkdir(plcDir)]);
  await writeFile(join(webDir, 'index.html'), '<h1>FCPLCn</h1>');
  await writeFile(
    join(portalDir, 'index.html'),
    '<html><head><meta name="fcplcn-hub-api-base" content="__FCPLCN_HUB_API_BASE__"><meta name="fcplcn-csrf-token" content="__FCPLCN_CSRF_TOKEN__"><meta name="fcplcn-cloud-role" content="__FCPLCN_CLOUD_ROLE__"></head></html>',
  );
  await writeFile(
    join(plcDir, 'index.html'),
    '<html><head><meta name="fcplcn-api-base" content="__FCPLCN_API_BASE__"></head></html>',
  );
  const config: CloudConfig = {
    host: '127.0.0.1',
    port: 4100,
    publicOrigin: 'http://127.0.0.1:4100',
    secureCookies: false,
    databaseUrl: databaseUrl!,
    setupKey: 'test-setup-' + randomBytes(24).toString('hex'),
    masterKey: randomBytes(32),
    dataDir: directory,
    brokerUrl: 'mqtts://127.0.0.1:8883',
    mqttUsername: 'test',
    mqttPassword: 'test-credential',
    publicBrokerUrl: 'mqtts://127.0.0.1:8883',
    allowInsecureLoopback: false,
  };
  const views = new Map<string, CloudHubView>(),
    credentials = new Map<string, string>(),
    requests: { hubId: string; method: CloudMethod; path: string; actor: CloudActor }[] = [];
  let duringRequest: (() => Promise<void>) | null = null;
  const bridge = {
    snapshot: (id: string) =>
      views.get(id) || { online: false, sessionId: null, lastSeenAt: null, snapshot: null },
    revoke: (id: string) => {
      views.delete(id);
    },
    async request(
      hubId: string,
      method: CloudMethod,
      path: string,
      _body: unknown,
      actor: CloudActor,
    ) {
      requests.push({ hubId, method, path, actor });
      if (duringRequest) await duringRequest();
      return {
        status: 200,
        data: path.includes('/config/backup')
          ? { secret: 'private-network-and-account-backup' }
          : { ok: true },
      };
    },
  };
  const broker = {
    async provision(id: string) {
      const password = randomBytes(32).toString('base64url');
      credentials.set(id, password);
      return { username: id, password, brokerUrl: config.publicBrokerUrl };
    },
    async revoke(id: string) {
      credentials.delete(id);
    },
  };
  const serverOptions = {
    config,
    db,
    product,
    bridge,
    broker,
    webDir,
    portalDir,
    plcDir,
  };
  let server = createCloudServer(serverOptions);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
    await rm(directory, { recursive: true, force: true });
  });
  function client() {
    let cookie = '',
      csrf = '';
    return {
      cookie: () => cookie,
      async call(
        path: string,
        data?: unknown,
        method = data === undefined ? 'GET' : 'POST',
        origin = base,
        withCSRF = true,
      ) {
        return fetch(base + path, {
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
            Origin: origin,
            ...(withCSRF && csrf ? { 'X-FCPLCN-CSRF': csrf } : {}),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
      },
      async session(response: Response) {
        const data = (await response.json()) as CloudSession;
        const header = response.headers.get('set-cookie');
        if (header) cookie = header.split(';')[0];
        csrf = data.csrfToken || '';
        return data;
      },
    };
  }
  const owner = client();
  const bootstrap = defaultAdmin
    ? await owner.call('/api/v1/auth/login', { username: 'admin', password: '' })
    : await owner.call('/api/v1/auth/setup', {
        setupKey: config.setupKey,
        email: 'owner@example.test',
        name: 'Владелец',
        password: 'Owner-password-123',
      });
  assert.equal(bootstrap.status, defaultAdmin ? 200 : 201);
  const ownerSession = await owner.session(bootstrap);
  async function home(name = 'Дом') {
    const response = await owner.call('/api/v1/homes', { name });
    assert.equal(response.status, 201);
    return (await response.json()) as HomeView;
  }
  async function invite(
    homeId: string,
    role: 'owner' | 'operator' | 'viewer',
    securityControl = false,
    email = 'member@example.test',
  ) {
    const response = await owner.call(`/api/v1/homes/${homeId}/invites`, {
      role,
      securityControl,
      email,
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { token: string }).token;
  }
  async function claim(homeId: string) {
    const codeResponse = await owner.call(`/api/v1/homes/${homeId}/pairing`, {});
    assert.equal(codeResponse.status, 201);
    const { code } = (await codeResponse.json()) as { code: string };
    const anon = client();
    const response = await anon.call('/api/v1/hubs/claim', {
      code,
      installationId: 'installation_' + randomBytes(12).toString('hex'),
      name: 'Хаб дома',
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      hubId: string;
      homeId: string;
      broker: { password: string };
    };
    views.set(data.hubId, {
      online: true,
      sessionId: 'wan-test',
      lastSeenAt: new Date().toISOString(),
      snapshot: snapshot(),
    });
    return { ...data, code };
  }
  return {
    db,
    get server() {
      return server;
    },
    owner,
    ownerSession,
    client,
    home,
    invite,
    claim,
    views,
    credentials,
    requests,
    duringRequest(callback: () => Promise<void>) {
      duringRequest = callback;
    },
    config,
    async restart() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = createCloudServer(serverOptions);
      await server.ready;
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    },
  };
}

test(
  'default admin accepts an empty password once and edited account credentials survive actual server restart',
  options,
  async (t) => {
    const f = await fixture(t, true);
    assert.equal(f.ownerSession.user!.username, 'admin');
    assert.equal(f.ownerSession.user!.email, null);
    assert.equal(f.ownerSession.setupRequired, false);
    assert.equal((await f.db.query('SELECT count(*) FROM cloud_users')).rows[0].count, '1');
    const second = f.client();
    await second.session(
      await second.call('/api/v1/auth/login', { username: 'ADMIN', password: '' }),
    );
    assert.equal(
      (
        await f.owner.call('/api/v1/auth/account', {
          username: 'house-owner',
          currentPassword: 'wrong',
        })
      ).status,
      403,
    );
    const changed = await f.owner.call('/api/v1/auth/account', {
      username: 'House-Owner',
      name: 'Хозяин дома',
      currentPassword: '',
      password: 'New-owner-password-123',
    });
    assert.equal(changed.status, 200);
    const next = await f.owner.session(changed);
    assert.equal(next.user!.username, 'house-owner');
    assert.equal(next.user!.name, 'Хозяин дома');
    assert.notEqual(next.csrfToken, f.ownerSession.csrfToken);
    assert.equal(
      (await second.call('/api/v1/homes')).status,
      401,
      'Changing account credentials revokes every old session',
    );
    const before = (
      await f.db.query('SELECT id,username,password_hash,auth_version FROM cloud_users')
    ).rows;
    await f.restart();
    assert.deepEqual(
      (await f.db.query('SELECT id,username,password_hash,auth_version FROM cloud_users')).rows,
      before,
    );
    const fresh = f.client();
    assert.equal(
      (await fresh.call('/api/v1/auth/login', { username: 'admin', password: '' })).status,
      401,
    );
    assert.equal(
      (await fresh.call('/api/v1/auth/login', { username: 'house-owner', password: '' })).status,
      401,
    );
    const login = await fresh.call('/api/v1/auth/login', {
      username: 'house-owner',
      password: 'New-owner-password-123',
    });
    assert.equal(login.status, 200);
    await fresh.session(login);
    assert.equal((await fresh.call('/api/v1/homes', { name: 'Дом нового владельца' })).status, 201);
    assert.equal(
      (
        await fresh.call('/api/v1/auth/account', {
          username: 'another-owner',
          currentPassword: 'New-owner-password-123',
        })
      ).status,
      200,
      'Omitting password preserves its verifier',
    );
    assert.equal(
      (
        await f
          .client()
          .call('/api/v1/auth/login', {
            username: 'another-owner',
            password: 'New-owner-password-123',
          })
      ).status,
      200,
    );
  },
);

test(
  'account usernames are independent of email, unique without case differences, and migrations preserve existing owners',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home();
    const token = await f.invite(home.id, 'viewer');
    const member = f.client();
    const accepted = await member.call('/api/v1/invites/accept', {
      token,
      email: 'member@example.test',
      username: 'guest',
      name: 'Наблюдатель',
      password: 'Member-password-123',
    });
    assert.equal(accepted.status, 200);
    assert.equal((await member.session(accepted)).user!.username, 'guest');
    const before = (
      await f.db.query('SELECT username,password_hash,auth_version FROM cloud_users WHERE id=$1', [
        f.ownerSession.user!.id,
      ])
    ).rows[0];
    assert.equal(
      (
        await f.owner.call('/api/v1/auth/account', {
          username: 'GUEST',
          currentPassword: 'Owner-password-123',
        })
      ).status,
      409,
    );
    assert.deepEqual(
      (
        await f.db.query(
          'SELECT username,password_hash,auth_version FROM cloud_users WHERE id=$1',
          [f.ownerSession.user!.id],
        )
      ).rows[0],
      before,
    );
    assert.equal(
      (await f.owner.call('/api/v1/homes')).status,
      200,
      'A collision does not revoke the existing session',
    );
    assert.equal(
      (
        await f.owner.call('/api/v1/auth/account', {
          username: 'bad login',
          currentPassword: 'Owner-password-123',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f
          .client()
          .call('/api/v1/auth/login', {
            email: 'member@example.test',
            password: 'Member-password-123',
          })
      ).status,
      200,
      'Legacy email login remains available after an independent username is chosen',
    );
    const oldOwner = (
      await f.db.query('SELECT id,password_hash FROM cloud_users WHERE id=$1', [
        f.ownerSession.user!.id,
      ])
    ).rows[0];
    await f.db.query('ALTER TABLE cloud_users DROP COLUMN username');
    await f.db.query('ALTER TABLE cloud_users DROP COLUMN default_admin');
    await f.db.migrate(await readFile(resolve('server/migrations/001_initial.sql'), 'utf8'));
    await f.restart();
    assert.deepEqual(
      (await f.db.query('SELECT id,password_hash FROM cloud_users WHERE id=$1', [oldOwner.id]))
        .rows[0],
      oldOwner,
    );
    assert.equal(
      (await f.db.query('SELECT username FROM cloud_users WHERE id=$1', [oldOwner.id])).rows[0]
        .username,
      'owner@example.test',
    );
    assert.equal(
      (await f.db.query("SELECT count(*) FROM cloud_users WHERE username='admin'")).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await f
          .client()
          .call('/api/v1/auth/login', {
            username: 'owner@example.test',
            password: 'Owner-password-123',
          })
      ).status,
      200,
    );
  },
);

test(
  'a used default account cannot reopen legacy setup after logout, and empty passwords work with MFA',
  options,
  async (t) => {
    const f = await fixture(t, true);
    await f.owner.call('/api/v1/auth/logout', {});
    assert.equal(
      (
        await f.client().call('/api/v1/auth/setup', {
          setupKey: f.config.setupKey,
          email: 'takeover@example.test',
          name: 'Other',
          password: 'Other-password-123',
        })
      ).status,
      409,
    );
    await f.owner.session(
      await f.owner.call('/api/v1/auth/login', { username: 'admin', password: '' }),
    );
    const setup = await f.owner.call('/api/v1/auth/totp/setup', { password: '' });
    assert.equal(setup.status, 200);
    const { secret } = (await setup.json()) as { secret: string };
    assert.equal(
      (await f.owner.call('/api/v1/auth/totp/confirm', { code: totp(secret) })).status,
      200,
    );
    const fresh = f.client();
    assert.equal(
      (await fresh.call('/api/v1/auth/login', { username: 'admin', password: '' })).status,
      401,
    );
    const login = await fresh.call('/api/v1/auth/login', {
      username: 'admin',
      password: '',
      totp: totp(secret),
    });
    assert.equal(login.status, 200);
    await fresh.session(login);
    const changed = await fresh.call('/api/v1/auth/account', {
      username: 'secure-admin',
      currentPassword: '',
      password: '',
      code: totp(secret),
    });
    assert.equal(changed.status, 200);
    await fresh.session(changed);
    assert.equal(
      (await fresh.call('/api/v1/auth/account', { name: 'Secure', currentPassword: '' })).status,
      403,
      'An empty password does not bypass the active second factor',
    );
    assert.equal(
      (
        await f
          .client()
          .call('/api/v1/auth/login', {
            username: 'secure-admin',
            password: '',
            totp: totp(secret),
          })
      ).status,
      200,
    );
  },
);

test(
  'first-owner setup is one-use; persistent sessions and CSRF protect every mutation',
  options,
  async (t) => {
    const f = await fixture(t),
      anon = f.client();
    assert.equal((await anon.call('/api/v1/homes')).status, 401);
    const login = await anon.call('/api/v1/auth/login', {
      email: 'owner@example.test',
      password: 'Owner-password-123',
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    await anon.session(login);
    assert.equal(
      (await anon.call('/api/v1/homes', { name: 'Forbidden' }, 'POST', undefined, false)).status,
      403,
    );
    assert.equal(
      (await anon.call('/api/v1/homes', { name: 'Forbidden' }, 'POST', 'https://external.invalid'))
        .status,
      403,
    );
    assert.equal(
      (
        await f.owner.call('/api/v1/auth/setup', {
          setupKey: f.config.setupKey,
          email: 'second@example.test',
          name: 'Other',
          password: 'Other-password-123',
        })
      ).status,
      409,
    );
    assert.equal((await f.owner.call('/api/v1/session')).headers.get('cache-control'), 'no-store');
    assert.equal((await f.owner.call('/api/v1/auth/logout', {})).status, 200);
    assert.equal((await f.owner.call('/api/v1/homes')).status, 401);
    assert.equal(
      (await anon.call('/api/v1/homes')).status,
      200,
      'Another authorized session remains valid',
    );
  },
);
test(
  'home memberships isolate tenants, viewer reads and owner-only private PLC configuration',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home(),
      other = await f.home('Другой дом'),
      claim = await f.claim(home.id),
      token = await f.invite(home.id, 'viewer');
    const viewer = f.client();
    const accepted = await viewer.call('/api/v1/invites/accept', {
      token,
      email: 'member@example.test',
      name: 'Наблюдатель',
      password: 'Viewer-password-123',
    });
    assert.equal(accepted.status, 200);
    await viewer.session(accepted);
    assert.equal((await viewer.call(`/api/v1/homes/${home.id}`)).status, 200);
    assert.equal((await viewer.call(`/api/v1/homes/${other.id}`)).status, 404);
    assert.equal((await viewer.call(`/api/v1/homes/${home.id}/members`)).status, 403);
    assert.equal((await viewer.call(`/api/v1/homes/${home.id}/hub/overview`)).status, 200);
    const privatePath = `/api/v1/homes/${home.id}/hub/devices/fcplcn-test/service/config/backup`;
    assert.equal((await viewer.call(privatePath)).status, 403);
    assert.equal(
      (
        await viewer.call(`/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`, {
          controller: 'sockets',
          itemId: 'outlet',
          value: true,
        })
      ).status,
      403,
    );
    const backup = await f.owner.call(privatePath);
    assert.equal(backup.status, 200);
    assert.match(await backup.text(), /private-network/);
    assert.equal(f.requests.at(-1)?.hubId, claim.hubId);
    const audit = await f.owner.call(`/api/v1/homes/${home.id}/history`).then((r) => r.text());
    assert.equal(audit.includes('private-network'), false);
    const iframe = await f.owner.call(`/plc/${home.id}/fcplcn-test/`);
    assert.equal(iframe.status, 200);
    assert.match(
      await iframe.text(),
      new RegExp(`/api/v1/homes/${home.id}/hub/devices/fcplcn-test/service`),
    );
  },
);
test(
  'invites are single-use, owner removal is guarded and operator security covers custom scenes',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home();
    await f.claim(home.id);
    const token = await f.invite(home.id, 'operator', false);
    const member = f.client(),
      accepted = await member.call('/api/v1/invites/accept', {
        token,
        email: 'member@example.test',
        name: 'Пользователь',
        password: 'Member-password-123',
      });
    await member.session(accepted);
    assert.equal(
      (
        await f.client().call('/api/v1/invites/accept', {
          token,
          email: 'another@example.test',
          name: 'Другой',
          password: 'Other-password-123',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await member.call(`/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`, {
          controller: 'sockets',
          itemId: 'outlet',
          value: true,
        })
      ).status,
      200,
    );
    for (const scene of ['home', 'away', 'prepare'])
      assert.equal(
        (await member.call(`/api/v1/homes/${home.id}/hub/scenes/${scene}/run`, {})).status,
        403,
      );
    assert.equal(
      (
        await member.call(`/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`, {
          controller: 'security',
          itemId: 'alarm',
          value: false,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.owner.call(
          `/api/v1/homes/${home.id}/members/${f.ownerSession.user!.id}`,
          {},
          'DELETE',
        )
      ).status,
      409,
    );
    const row = (
      await f.db.query('SELECT id FROM cloud_users WHERE email=$1', ['member@example.test'])
    ).rows[0];
    assert.equal(
      (
        await f.owner.call(
          `/api/v1/homes/${home.id}/members/${row.id}`,
          { role: 'operator', securityControl: true },
          'PATCH',
        )
      ).status,
      200,
    );
    assert.equal(
      (await member.call(`/api/v1/homes/${home.id}/hub/scenes/prepare/run`, {})).status,
      200,
    );
    assert.equal(
      (await f.owner.call(`/api/v1/homes/${home.id}/members/${row.id}`, {}, 'DELETE')).status,
      200,
    );
    assert.equal((await member.call(`/api/v1/homes/${home.id}/hub/overview`)).status, 404);
  },
);
test(
  'pairing is one-use, revocation invalidates private credentials and offline commands never queue',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home(),
      hub = await f.claim(home.id),
      anon = f.client();
    assert.equal(
      (
        await anon.call('/api/v1/hubs/claim', {
          code: hub.code,
          installationId: 'another_installation_123456',
        })
      ).status,
      404,
    );
    const row = (
      await f.db.query('SELECT broker_secret_hash FROM cloud_hubs WHERE id=$1', [hub.hubId])
    ).rows[0];
    assert.notEqual(row.broker_secret_hash, hub.broker.password);
    assert.equal(row.broker_secret_hash.length, 64);
    const view = f.views.get(hub.hubId)!;
    view.online = false;
    const count = f.requests.length;
    assert.equal(
      (
        await f.owner.call(`/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`, {
          controller: 'sockets',
          itemId: 'outlet',
          value: true,
        })
      ).status,
      503,
    );
    assert.equal(f.requests.length, count);
    const cached = (await f.owner
      .call(`/api/v1/homes/${home.id}/hub/overview`)
      .then((r) => r.json())) as HubSnapshot;
    assert.equal(cached.devices[0].online, false);
    assert.equal(cached.devices[0].controllers.sockets?.fresh, false);
    assert.equal(
      (await f.owner.call(`/api/v1/homes/${home.id}/hubs/${hub.hubId}`, {}, 'DELETE')).status,
      200,
    );
    assert.equal(f.credentials.has(hub.hubId), false);
    assert.equal(await f.server.pairing.authorized(hub.hubId), false);
    assert.equal(
      (
        await f.owner.call(`/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`, {
          controller: 'sockets',
          itemId: 'outlet',
          value: true,
        })
      ).status,
      503,
    );
  },
);
test(
  'TOTP enrollment confirms password and current codes; recovery codes are consumed once',
  options,
  async (t) => {
    const f = await fixture(t);
    assert.equal(
      (await f.owner.call('/api/v1/auth/totp/setup', { password: 'wrong-password' })).status,
      403,
    );
    const enrollment = await f.owner.call('/api/v1/auth/totp/setup', {
      password: 'Owner-password-123',
    });
    assert.equal(enrollment.status, 200);
    const { secret } = (await enrollment.json()) as { secret: string };
    const confirmed = await f.owner.call('/api/v1/auth/totp/confirm', { code: totp(secret) });
    assert.equal(confirmed.status, 200);
    const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
    assert.equal(recoveryCodes.length, 10);
    const client = f.client();
    assert.equal(
      (
        await client.call('/api/v1/auth/login', {
          email: 'owner@example.test',
          password: 'Owner-password-123',
        })
      ).status,
      401,
    );
    const recovered = await client.call('/api/v1/auth/login', {
      email: 'owner@example.test',
      password: 'Owner-password-123',
      totp: recoveryCodes[0],
    });
    assert.equal(recovered.status, 200);
    await client.session(recovered);
    assert.equal(
      (
        await f.client().call('/api/v1/auth/login', {
          email: 'owner@example.test',
          password: 'Owner-password-123',
          totp: recoveryCodes[0],
        })
      ).status,
      401,
    );
    const persistent = (
      await f.db.query('SELECT totp_secret,recovery_hashes FROM cloud_users WHERE id=$1', [
        f.ownerSession.user!.id,
      ])
    ).rows[0];
    assert.notEqual(persistent.totp_secret, secret);
    assert.equal(persistent.recovery_hashes.includes(recoveryCodes[0]), false);
  },
);

test(
  'a hub disconnect requires its own bearer credential and revokes the broker identity',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home(),
      hub = await f.claim(home.id);
    const installation = (
      await f.db.query('SELECT installation_id FROM cloud_hubs WHERE id=$1', [hub.hubId])
    ).rows[0].installation_id;
    const base = 'http://127.0.0.1:' + (f.server.address() as AddressInfo).port;
    const disconnect = (password: string) =>
      fetch(base + '/api/v1/hubs/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + password },
        body: JSON.stringify({ hubId: hub.hubId, installationId: installation }),
      });
    assert.equal((await disconnect('x'.repeat(43))).status, 401);
    assert.equal(await f.server.pairing.authorized(hub.hubId), true);
    const accepted = await disconnect(hub.broker.password);
    assert.equal(accepted.status, 200);
    assert.equal(await f.server.pairing.authorized(hub.hubId), false);
    assert.equal(f.credentials.has(hub.hubId), false);
    const publicView = await f.owner
      .call(`/api/v1/homes/${home.id}`)
      .then((response) => response.text());
    assert.equal(publicView.includes(hub.broker.password), false);
  },
);

test(
  "removing an owner invalidates that owner's unused invitations and pairing codes",
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home();
    const token = await f.invite(home.id, 'owner', true, 'coowner@example.test');
    const coowner = f.client();
    const accepted = await coowner.call('/api/v1/invites/accept', {
      token,
      email: 'coowner@example.test',
      name: 'Другой владелец',
      password: 'Coowner-password-123',
    });
    assert.equal(accepted.status, 200);
    await coowner.session(accepted);
    const outstanding = await f.invite(home.id, 'viewer', false, 'newperson@example.test');
    const pair = (await f.owner
      .call(`/api/v1/homes/${home.id}/pairing`, {})
      .then((response) => response.json())) as { code: string };
    assert.equal(
      (
        await coowner.call(
          `/api/v1/homes/${home.id}/members/${f.ownerSession.user!.id}`,
          {},
          'DELETE',
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.client().call('/api/v1/invites/accept', {
          token: outstanding,
          email: 'newperson@example.test',
          name: 'Человек',
          password: 'Person-password-123',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.client().call('/api/v1/hubs/claim', {
          code: pair.code,
          installationId: 'new_installation_after_revoke',
        })
      ).status,
      404,
    );
    assert.equal(
      (await f.db.query('SELECT 1 FROM cloud_users WHERE email=$1', ['newperson@example.test']))
        .rowCount,
      0,
    );
  },
);

test('concurrent MFA confirmations cannot clear the enabled factor', options, async (t) => {
  const f = await fixture(t);
  const setup = (await f.owner
    .call('/api/v1/auth/totp/setup', { password: 'Owner-password-123' })
    .then((response) => response.json())) as { secret: string };
  const code = totp(setup.secret);
  const results = await Promise.all([
    f.owner.call('/api/v1/auth/totp/confirm', { code }),
    f.owner.call('/api/v1/auth/totp/confirm', { code }),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 400]);
  const stored = (
    await f.db.query('SELECT totp_secret,totp_pending FROM cloud_users WHERE id=$1', [
      f.ownerSession.user!.id,
    ])
  ).rows[0];
  assert.ok(stored.totp_secret);
  assert.equal(stored.totp_pending, null);
});
test(
  'an old password verified before a security change cannot issue a fresh session afterward',
  options,
  async (t) => {
    const f = await fixture(t);
    const candidate = await f.server.auth.login(
      { email: 'owner@example.test', password: 'Owner-password-123' },
      'race-test',
    );
    const active = await f.server.auth.session({
      headers: { cookie: f.owner.cookie() },
    } as IncomingMessage);
    assert.ok(active);
    await f.server.auth.changePassword(
      active,
      'Owner-password-123',
      'Replacement-password-123',
      undefined,
    );
    await assert.rejects(
      f.server.auth.issue(candidate, { setHeader() {} } as unknown as ServerResponse),
      /изменились/,
    );
    assert.equal((await f.owner.call('/api/v1/homes')).status, 401);
    assert.equal(
      (
        await f.client().call('/api/v1/auth/login', {
          email: 'owner@example.test',
          password: 'Replacement-password-123',
        })
      ).status,
      200,
    );
  },
);

test(
  'a known RPC confirmation remains one confirmed journal entry when access is revoked before response',
  options,
  async (t) => {
    const f = await fixture(t),
      home = await f.home();
    await f.claim(home.id);
    const token = await f.invite(home.id, 'owner', true, 'otherowner@example.test');
    const other = f.client();
    const accepted = await other.call('/api/v1/invites/accept', {
      token,
      email: 'otherowner@example.test',
      name: 'Второй владелец',
      password: 'Otherowner-password-123',
    });
    assert.equal(accepted.status, 200);
    await other.session(accepted);
    f.duringRequest(async () => {
      const change = await other.call(
        `/api/v1/homes/${home.id}/members/${f.ownerSession.user!.id}`,
        { role: 'viewer', securityControl: false },
        'PATCH',
      );
      assert.equal(change.status, 200);
    });
    const command = await f.owner.call(
      `/api/v1/homes/${home.id}/hub/devices/fcplcn-test/commands`,
      { controller: 'sockets', itemId: 'outlet', value: true },
    );
    assert.equal(command.status, 403, 'Revoked actor does not receive a newly privileged response');
    const entries = (
      await f.db.query('SELECT status FROM cloud_audit WHERE home_id=$1 AND operation=$2', [
        home.id,
        'POST /devices/fcplcn-test/commands',
      ])
    ).rows;
    assert.deepEqual(
      entries.map((row) => row.status),
      ['confirmed'],
    );
  },
);
