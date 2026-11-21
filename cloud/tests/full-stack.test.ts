/** @file Public cloud HTTP → PostgreSQL auth → TLS MQTT → hub → virtual PLC, including OTA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type {
  EngineOptions,
  HubEngine,
  HubSnapshot,
  SceneDefinition,
  ScenesSnapshot,
} from '../../hub/shared/types.js';
import { HubControl } from '../../hub/server/control.js';
import { Scenes } from '../../hub/server/scenes.js';
import { HubCloudStore } from '../../hub/server/cloud/store.js';
import { HubCloud } from '../../hub/server/cloud/uplink.js';
import { CloudFirmwareInstaller, type FirmwareJob } from '../../hub/server/cloud/firmware.js';
import { cloudAppImage } from '../../hub/tests/cloud-fixtures.js';
import { CloudDatabase } from '../server/db.js';
import { loadCloudConfig } from '../server/config.js';
import { BrokerAdmin } from '../server/broker.js';
import { CloudBridge } from '../server/bridge.js';
import { CloudArtifacts, type ArtifactView } from '../server/artifacts.js';
import { createCloudServer } from '../server/http.js';
import type { CloudSession, HomeView } from '../shared/api.js';

type Data = Record<string, unknown>;
const product = { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' };
const living = 'fcplcn-demo-living';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(40);
  }
  assert.fail(message);
}

test(
  'the real public cloud stack configures and controls its paired hub and installs a verified PLC image',
  { timeout: 90000 },
  async (t) => {
    const env = process.env;
    if (!env.FCPLCN_CLOUD_TEST_DATABASE_URL || !env.FCPLCN_CLOUD_MQTT_URL) {
      t.skip('Requires the isolated PostgreSQL test database and TLS/dynamic-security broker');
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'fcplcn-cloud-full-stack-'));
    const schema = 'cloud_e2e_' + randomBytes(8).toString('hex');
    const adminDb = new CloudDatabase(env.FCPLCN_CLOUD_TEST_DATABASE_URL);
    const db = new CloudDatabase(env.FCPLCN_CLOUD_TEST_DATABASE_URL, { schema });
    const cloudDir = join(directory, 'cloud'),
      hubDir = join(directory, 'hub');
    await Promise.all([mkdir(cloudDir), mkdir(hubDir)]);
    const config = loadCloudConfig({
      ...env,
      FCPLCN_CLOUD_DATABASE_URL: env.FCPLCN_CLOUD_TEST_DATABASE_URL,
      FCPLCN_CLOUD_DATABASE_URL_FILE: '',
      FCPLCN_CLOUD_DATA_DIR: cloudDir,
      FCPLCN_CLOUD_PUBLIC_ORIGIN: 'http://127.0.0.1:4100',
      FCPLCN_CLOUD_ALLOW_INSECURE_LOOPBACK: '1',
      FCPLCN_CLOUD_SETUP_KEY: randomBytes(32).toString('hex'),
      FCPLCN_CLOUD_SETUP_KEY_FILE: '',
      FCPLCN_CLOUD_MASTER_KEY: randomBytes(32).toString('hex'),
      FCPLCN_CLOUD_MASTER_KEY_FILE: '',
    });
    const brokerOptions = {
      brokerUrl: config.brokerUrl,
      username: config.mqttUsername,
      password: config.mqttPassword,
      ca: config.mqttCa,
      publicBrokerUrl: config.publicBrokerUrl,
      publicCa: config.publicMqttCa,
    };
    const broker = new BrokerAdmin(brokerOptions);
    const bridge = new CloudBridge({
      ...brokerOptions,
      requestTimeoutMs: 8000,
      staleAfterMs: 1200,
      authorizeHub: async (id) =>
        Boolean(
          (await db.query('SELECT 1 FROM cloud_hubs WHERE id=$1 AND revoked_at IS NULL', [id]))
            .rowCount,
        ),
      onSnapshot: async (id, view) => {
        if (view.snapshot)
          await db.query(
            'UPDATE cloud_hubs SET snapshot=$2,last_seen_at=now(),snapshot_at=now() WHERE id=$1 AND revoked_at IS NULL',
            [id, JSON.stringify(view.snapshot)],
          );
      },
    });
    const server = createCloudServer({
      config,
      db,
      product,
      bridge,
      broker,
      artifacts: new CloudArtifacts(cloudDir),
      webDir: cloudDir,
      portalDir: cloudDir,
      plcDir: cloudDir,
    });
    let engine: HubEngine | undefined, scenes: Scenes | undefined, control: HubControl | undefined;
    let uplink: HubCloud | undefined,
      installer: CloudFirmwareInstaller | undefined,
      hubId = '';
    t.after(async () => {
      await installer?.stop();
      await uplink?.stop();
      control?.close();
      await scenes?.stop();
      await engine?.stop();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((done) => server.close(() => done()));
      if (hubId) await broker.revoke(hubId).catch(() => {});
      await bridge.stop();
      await broker.stop();
      await db.close();
      await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminDb.close();
      await rm(directory, { recursive: true, force: true });
    });
    await adminDb.query(`CREATE SCHEMA ${schema}`);
    await db.migrate(await readFile(resolve('server/migrations/001_initial.sql'), 'utf8'));
    await Promise.all([broker.start(), bridge.start()]);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    function client() {
      let cookie = '',
        csrf = '';
      return {
        async call(path: string, data?: unknown, method = data === undefined ? 'GET' : 'POST') {
          return fetch(origin + '/api/v1' + path, {
            method,
            headers: {
              Origin: origin,
              ...(cookie ? { Cookie: cookie } : {}),
              ...(csrf ? { 'X-FCPLCN-CSRF': csrf } : {}),
              ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
        },
        async remember(response: Response) {
          const data = (await response.json()) as CloudSession;
          cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
          csrf = data.csrfToken || '';
          return data;
        },
        async upload(path: string, image: Buffer) {
          return fetch(origin + '/api/v1' + path, {
            method: 'POST',
            headers: {
              Origin: origin,
              Cookie: cookie,
              'X-FCPLCN-CSRF': csrf,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(image.length),
            },
            body: Uint8Array.from(image),
          });
        },
      };
    }
    const owner = client(),
      anonymous = client();
    assert.equal((await anonymous.call('/homes')).status, 401);
    const setup = await owner.call('/auth/setup', {
      setupKey: config.setupKey,
      email: 'owner@e2e.example.test',
      name: 'Владелец дома',
      password: 'E2E-owner-password-123',
    });
    assert.equal(setup.status, 201);
    await owner.remember(setup);
    const created = await owner.call('/homes', { name: 'Полный испытательный дом' });
    assert.equal(created.status, 201);
    const home = (await created.json()) as HomeView;
    const root = '/homes/' + home.id,
      hub = root + '/hub';
    const codeResponse = await owner.call(root + '/pairing', {});
    assert.equal(codeResponse.status, 201);
    const { code } = (await codeResponse.json()) as { code: string };

    // The demo engine is already built by the hub suite. Its PLC-only fixtures stay out of cloud production bundles.
    const { createEngine } = (await import(
      pathToFileURL(resolve('../hub/dist/src/engine.js')).href
    )) as {
      createEngine(options: EngineOptions): HubEngine;
    };
    engine = createEngine({
      product,
      mode: 'demo',
      demoDataDir: hubDir,
      brokerUrl: 'mqtt://127.0.0.1:1',
      clientId: 'fcplcn-full-stack-' + schema,
      staleAfterMs: 45000,
      commandTimeoutMs: 8000,
      labels: {},
      onLabelsChanged() {},
    });
    await engine.start();
    scenes = new Scenes(engine, { directory: hubDir, demo: true });
    control = new HubControl({ engine, scenes, product, mode: 'demo' });
    const store = new HubCloudStore(hubDir, true);
    uplink = new HubCloud(store, control, { allowInsecureLoopback: true, publishIntervalMs: 100 });
    installer = new CloudFirmwareInstaller({
      control,
      origin: () => store.publicConfig().url,
      hubId: () => store.publicConfig().hubId,
      isActive: () => uplink!.snapshot().status.state === 'online',
      connection: () => uplink!.sessionId(),
      dataDir: hubDir,
    });
    control.setFirmware(installer);
    await uplink.pair({ url: origin, code, name: 'Полный испытательный хаб' });
    hubId = store.publicConfig().hubId;
    assert.ok(hubId);
    await until(
      () => bridge.snapshot(hubId).online && bridge.snapshot(hubId).snapshot?.devices.length === 3,
      'Paired TLS hub never became online',
    );
    t.diagnostic(
      'Owner enrollment, one-use HTTP pairing and individually authenticated TLS uplink succeeded',
    );
    assert.equal(
      (
        await anonymous.call('/hubs/claim', {
          code,
          installationId: randomBytes(24).toString('hex'),
        })
      ).status,
      404,
    );
    const overview = await owner.call(hub + '/overview');
    assert.equal(overview.status, 200);
    const live = (await overview.json()) as HubSnapshot;
    assert.equal(live.devices.length, 3);
    const command = await owner.call(hub + '/devices/' + living + '/commands', {
      controller: 'sockets',
      itemId: 'socket-tv',
      value: false,
    });
    assert.equal(command.status, 200);
    assert.equal(((await command.json()) as { status: string }).status, 'applied');
    const service = hub + '/devices/' + living + '/service';
    const socketResponse = await owner.call(service + '/controllers/sockets');
    assert.equal(socketResponse.status, 200);
    const sockets = (await socketResponse.json()) as { revision: number; items: Data[] };
    assert.equal(sockets.items.find((row) => row.id === 'socket-tv')?.actual, false);
    const savedSockets = await owner.call(service + '/controllers/sockets', {
      baseRevision: sockets.revision,
      enabled: true,
      items: [
        ...sockets.items.map(({ id, name, relayId, inputId }) => ({ id, name, relayId, inputId })),
        { id: 'cloud-socket', name: 'Розетка из облака', relayId: 'rly-0/13', inputId: 'in-0/10' },
      ],
    });
    assert.equal(savedSockets.status, 200);
    assert.equal(
      (
        await owner.call(hub + '/devices/' + living + '/commands', {
          controller: 'sockets',
          itemId: 'cloud-socket',
          value: true,
        })
      ).status,
      200,
    );
    const privateSecret = 'e2e-private-wifi-' + randomBytes(16).toString('hex');
    const plcConfig = (await owner
      .call(service + '/config')
      .then((response) => response.json())) as Data;
    const savedConfig = await owner.call(service + '/config', {
      baseRevision: plcConfig.revision,
      device: { name: 'PLC настроен из облака' },
      wifi: { sta: { ssid: 'FCPLCn-E2E', password: privateSecret } },
    });
    assert.equal(savedConfig.status, 200);
    const backupResponse = await owner.call(service + '/config/backup');
    assert.equal(backupResponse.status, 200);
    const backup = await backupResponse.text();
    assert.ok(
      backup.includes(privateSecret),
      'Only the direct private backup contains the configured credential',
    );
    const sceneResponse = await owner.call(hub + '/scenes', {
      name: 'Вечер из облака',
      description: 'Испытательное действие',
      actions: [
        {
          id: 'evening',
          deviceId: living,
          controller: 'lights',
          itemId: 'light-evening',
          value: true,
        },
        {
          id: 'utility-light',
          deviceId: 'fcplcn-demo-utility',
          controller: 'lights',
          itemId: 'light-utility',
          value: true,
        },
      ],
    });
    assert.equal(sceneResponse.status, 201);
    const scene = (await sceneResponse.json()) as SceneDefinition;
    assert.equal((await owner.call(hub + '/scenes/' + scene.id + '/run', {})).status, 202);
    await until(async () => {
      const response = await owner.call(hub + '/scenes');
      const snapshot = (await response.json()) as ScenesSnapshot;
      return snapshot.runs.some((run) => run.sceneId === scene.id && run.status === 'completed');
    }, 'Explicit cloud scene was not confirmed by its PLC');
    t.diagnostic(
      'Confirmed output control, relay/input assignment, private configuration/backup and multi-action scene RPC succeeded',
    );

    const invitation = await owner.call(root + '/invites', {
      email: 'viewer@e2e.example.test',
      role: 'viewer',
      securityControl: false,
    });
    assert.equal(invitation.status, 201);
    const { token } = (await invitation.json()) as { token: string };
    const viewer = client();
    const accepted = await viewer.call('/invites/accept', {
      token,
      email: 'viewer@e2e.example.test',
      name: 'Наблюдатель',
      password: 'E2E-viewer-password-123',
    });
    assert.equal(accepted.status, 200);
    await viewer.remember(accepted);
    assert.equal((await viewer.call(hub + '/overview')).status, 200);
    assert.equal((await viewer.call(service + '/config')).status, 403);
    assert.equal(
      (
        await viewer.call(hub + '/devices/' + living + '/commands', {
          controller: 'sockets',
          itemId: 'socket-tv',
          value: true,
        })
      ).status,
      403,
    );
    assert.equal((await viewer.call(hub + '/scenes/' + scene.id + '/run', {})).status, 403);
    const other = (await owner
      .call('/homes', { name: 'Другой дом' })
      .then((response) => response.json())) as HomeView;
    assert.equal((await viewer.call('/homes/' + other.id)).status, 404);

    const image = env.FCPLCN_CLOUD_TEST_FIRMWARE
      ? await readFile(env.FCPLCN_CLOUD_TEST_FIRMWARE)
      : cloudAppImage(32768);
    assert.equal((await viewer.upload(root + '/firmware', image)).status, 403);
    const upload = await owner.upload(root + '/firmware', image);
    assert.equal(upload.status, 201);
    const artifact = (await upload.json()) as ArtifactView;
    assert.equal(artifact.size, image.length);
    const install = await owner.call(root + '/firmware/' + artifact.id + '/install', {
      deviceId: living,
    });
    assert.equal(install.status, 202);
    const { jobId } = (await install.json()) as { jobId: string };
    let completed: FirmwareJob | undefined;
    await until(
      async () => {
        const response = await owner.call(root + '/firmware/jobs/' + jobId);
        assert.equal(response.status, 200);
        const { job } = (await response.json()) as { job: FirmwareJob };
        if (job.state === 'failed' || job.state === 'unknown')
          assert.fail('OTA did not confirm boot: ' + job.error);
        if (job.state === 'completed') completed = job;
        return Boolean(completed);
      },
      'Cloud firmware job never confirmed its new image and partition',
      45000,
    );
    assert.equal(completed?.progress, 100);
    const running = (await owner
      .call(service + '/firmware')
      .then((response) => response.json())) as Data;
    assert.equal(running.imageId, artifact.imageId);
    assert.equal(running.version, artifact.version);
    const afterConfig = (await owner
      .call(service + '/config')
      .then((response) => response.json())) as Data;
    assert.equal((afterConfig.device as Data).name, 'PLC настроен из облака');
    assert.equal((afterConfig.wifi as { sta: Data }).sta.ssid, 'FCPLCn-E2E');
    const afterSockets = (await owner
      .call(service + '/controllers/sockets')
      .then((response) => response.json())) as { items: Data[] };
    assert.ok(
      afterSockets.items.some((row) => row.id === 'cloud-socket' && row.relayId === 'rly-0/13'),
    );
    t.diagnostic(
      'Raw HTTP firmware upload → one-use artifact download → LAN chunking → verified new boot completed; PLC settings survived',
    );

    await until(async () => {
      const row = (await db.query('SELECT snapshot FROM cloud_hubs WHERE id=$1', [hubId])).rows[0];
      return Boolean(row?.snapshot);
    }, 'Public telemetry checkpoint missing');
    const history = await owner.call(root + '/history').then((response) => response.text());
    const persisted = JSON.stringify(
      (await db.query('SELECT snapshot FROM cloud_hubs WHERE id=$1', [hubId])).rows,
    );
    assert.equal(history.includes(privateSecret), false);
    assert.equal(persisted.includes(privateSecret), false);
    assert.equal(JSON.stringify(bridge.snapshot(hubId)).includes(privateSecret), false);
    assert.equal(
      (await db.query("SELECT 1 FROM cloud_audit WHERE home_id=$1 AND status='pending'", [home.id]))
        .rowCount,
      0,
    );

    await uplink.stop();
    await until(
      () => !bridge.snapshot(hubId).online,
      'Cloud did not expire disconnected hub state',
    );
    const commandCount = engine.snapshot().commands.length;
    assert.equal(
      (
        await owner.call(hub + '/devices/' + living + '/commands', {
          controller: 'sockets',
          itemId: 'socket-tv',
          value: true,
        })
      ).status,
      503,
    );
    const offline = (await owner
      .call(hub + '/overview')
      .then((response) => response.json())) as HubSnapshot;
    assert.equal(offline.devices.find((device) => device.id === living)?.online, false);
    uplink.start();
    await until(() => bridge.snapshot(hubId).online, 'Hub did not recover its outbound connection');
    await sleep(150);
    assert.equal(
      engine.snapshot().commands.length,
      commandCount,
      'An offline cloud command was never queued or replayed',
    );
    const revoked = await owner.call(root + '/hubs/' + hubId, {}, 'DELETE');
    assert.equal(revoked.status, 200);
    assert.equal(bridge.snapshot(hubId).online, false);
    assert.equal(
      (
        await owner.call(hub + '/devices/' + living + '/commands', {
          controller: 'sockets',
          itemId: 'socket-tv',
          value: true,
        })
      ).status,
      503,
    );
    assert.ok(
      (await db.query('SELECT revoked_at FROM cloud_hubs WHERE id=$1', [hubId])).rows[0].revoked_at,
    );
    t.diagnostic(
      'Viewer/tenant isolation, private-data boundaries, offline no-replay and individual hub revocation succeeded',
    );
  },
);
