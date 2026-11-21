/** @file Exercise the actual TLS broker, individual credentials and outbound hub RPC with isolated I/O. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';
import { BrokerAdmin } from '../server/broker.js';
import { CloudBridge } from '../server/bridge.js';
import { HubCloudStore } from '../../hub/server/cloud/store.js';
import { HubCloud } from '../../hub/server/cloud/uplink.js';
import { HubControl } from '../../hub/server/control.js';
import { Scenes } from '../../hub/server/scenes.js';
import type { CommandView, EngineSnapshot, HubEngine } from '../../hub/shared/types.js';
import type { CloudRequest, CloudState } from '../../hub/shared/cloud.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error('Cloud bridge condition timed out');
    await sleep(20);
  }
}
test(
  'TLS cloud↔hub RPC is scoped, correlated, deadline bounded and never replays across reconnect',
  { timeout: 30000 },
  async (t) => {
    const env = process.env;
    if (!env.FCPLCN_CLOUD_MQTT_URL) {
      t.skip('Set the isolated TLS/dynamic-security broker variables');
      return;
    }
    const options = {
      brokerUrl: env.FCPLCN_CLOUD_MQTT_URL,
      username: env.FCPLCN_CLOUD_MQTT_USERNAME!,
      password: env.FCPLCN_CLOUD_MQTT_PASSWORD!,
      ca: pem(env.FCPLCN_CLOUD_MQTT_CA),
      publicBrokerUrl: env.FCPLCN_CLOUD_PUBLIC_MQTT_URL!,
      publicCa: pem(env.FCPLCN_CLOUD_PUBLIC_MQTT_CA),
    };
    const admin = new BrokerAdmin(options);
    t.after(() => admin.stop());
    await admin.start();
    const hubId = randomUUID(),
      homeId = randomUUID();
    const credentials = await admin.provision(hubId);
    const probe = await mqtt.connectAsync(credentials.brokerUrl, {
      protocolVersion: 5,
      clientId: hubId,
      username: credentials.username,
      password: credentials.password,
      ca: credentials.ca,
      rejectUnauthorized: true,
      clean: true,
      reconnectPeriod: 0,
      queueQoSZero: false,
    });
    probe.on('error', () => {});
    try {
      await probe.subscribeAsync(`fcplcn-cloud/v1/hubs/${hubId}/request`, { qos: 0 });
      await assert.rejects(
        probe.subscribeAsync('fcplcn-cloud/v1/hubs/another-house/request', { qos: 0 }),
        /authorized/i,
      );
      await assert.rejects(
        probe.publishAsync('fcplcn-cloud/v1/hubs/another-house/state', '{}', {
          qos: 1,
          retain: false,
        }),
        /authorized/i,
      );
    } finally {
      await new Promise<void>((resolve) => probe.end(true, {}, () => resolve()));
    }

    const directory = mkdtempSync(join(tmpdir(), 'fcplcn-cloud-uplink-'));
    let calls = 0,
      lastBudget = 0;
    let hold: Promise<void> | null = null;
    const state: EngineSnapshot = {
      broker: { connected: true, error: null },
      commands: [],
      devices: [
        {
          id: 'fcplcn-cloud-test',
          boardId: 'fcplcn-161608-1v0',
          firmwareVersion: 'test',
          bootId: 'plc-boot',
          name: 'Испытательный PLC',
          room: '',
          online: true,
          status: 'online',
          uptimeSec: 120,
          lastSeenAt: new Date().toISOString(),
          controllers: {
            sockets: {
              kind: 'sockets',
              fresh: true,
              receivedAt: new Date().toISOString(),
              data: {
                enabled: true,
                revision: 1,
                items: [{ id: 'socket-1', name: 'Розетка', available: true, actual: false }],
              },
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
      async command(deviceId, controller, itemId, value, budget) {
        calls++;
        lastBudget = budget || 0;
        if (hold) await hold;
        (state.devices[0].controllers.sockets!.data.items as { actual: boolean }[])[0].actual =
          value;
        return {
          id: randomUUID(),
          deviceId,
          controller,
          itemId,
          value,
          sequence: calls,
          status: 'applied',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: null,
        } satisfies CommandView;
      },
      async service(_id, _method, path, _body, _signal, budget) {
        lastBudget = budget || 0;
        return {
          schemaVersion: 1,
          requestId: randomUUID(),
          bootId: 'plc-boot',
          sequence: 1,
          status: 200,
          data: path === '/config' ? { password: 'private-test-secret' } : { ok: true },
        };
      },
    };
    const scenes = new Scenes(engine);
    const control = new HubControl({
      engine,
      scenes,
      product: { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' },
      mode: 'demo',
    });
    const store = new HubCloudStore(directory, true);
    store.pair(
      'http://127.0.0.1:4100',
      { protocolVersion: 1, hubId, homeId, broker: credentials },
      'Тестовый хаб',
    );
    const uplink = new HubCloud(store, control, {
      allowInsecureLoopback: true,
      publishIntervalMs: 50,
    });
    const bridge = new CloudBridge({
      ...options,
      requestTimeoutMs: 1000,
      staleAfterMs: 300,
      authorizeHub: async (id) => id === hubId,
    });
    t.after(() => bridge.stop());
    await bridge.start();
    const observer = await mqtt.connectAsync(options.brokerUrl, {
      protocolVersion: 5,
      clientId: 'cloud-observer-' + randomUUID(),
      username: options.username,
      password: options.password,
      ca: options.ca,
      rejectUnauthorized: true,
      reconnectPeriod: 0,
      clean: true,
      queueQoSZero: false,
    });
    t.after(() => new Promise<void>((resolve) => observer.end(true, {}, () => resolve())));
    let lastState: CloudState | null = null;
    const replies: unknown[] = [];
    observer.on('message', (topic, bytes) => {
      if (!topic.startsWith(`fcplcn-cloud/v1/hubs/${hubId}/`)) return;
      const body: unknown = JSON.parse(bytes.toString());
      if (topic.endsWith('/state') || topic.endsWith('/hello')) lastState = body as CloudState;
      if (topic.endsWith('/reply')) replies.push(body);
    });
    await observer.subscribeAsync(
      ['hello', 'state', 'reply'].map((part) => `fcplcn-cloud/v1/hubs/+/${part}`),
      { qos: 0, rap: true, rh: 2 },
    );
    uplink.start();
    t.after(async () => {
      await uplink.stop();
      await bridge.stop();
      await admin.revoke(hubId).catch(() => {});
      await admin.stop();
      control.close();
      await scenes.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    await until(() => bridge.snapshot(hubId).online && lastState !== null);
    const actor = { userId: 'integration-owner', role: 'owner' as const };
    const result = await bridge.request(
      hubId,
      'POST',
      '/devices/fcplcn-cloud-test/commands',
      { controller: 'sockets', itemId: 'socket-1', value: true },
      actor,
    );
    assert.equal(result.status, 200);
    assert.equal(calls, 1);
    assert.ok(lastBudget >= 250 && lastBudget <= 1000, 'WAN budget is not extended on the LAN hop');
    await assert.rejects(
      bridge.request(
        hubId,
        'POST',
        '/devices/fcplcn-cloud-test/commands',
        { controller: 'sockets', itemId: 'socket-1', value: false },
        { userId: 'viewer', role: 'viewer' },
      ),
      /разрешения/,
    );
    const privateReply = await bridge.request(
      hubId,
      'GET',
      '/devices/fcplcn-cloud-test/service/config',
      undefined,
      actor,
    );
    assert.equal((privateReply.data as { password: string }).password, 'private-test-secret');
    assert.equal(JSON.stringify(bridge.snapshot(hubId)).includes('private-test-secret'), false);
    await until(() => Boolean(lastState && lastState.requestSequence >= 2));
    const observed = lastState as unknown as CloudState;
    const request: CloudRequest = {
      version: 1,
      id: randomUUID(),
      hubId,
      sessionId: observed.sessionId,
      sequence: observed.requestSequence + 1,
      expiresAtUptimeMs: observed.uptimeMs + 5000,
      method: 'POST',
      path: '/devices/fcplcn-cloud-test/commands',
      body: { controller: 'sockets', itemId: 'socket-1', value: false },
      actor,
    };
    const previousReplies = replies.length;
    await observer.publishAsync(`fcplcn-cloud/v1/hubs/${hubId}/request`, JSON.stringify(request), {
      qos: 0,
      retain: false,
    });
    await until(() => replies.length > previousReplies);
    assert.equal(calls, 2);
    await observer.publishAsync(`fcplcn-cloud/v1/hubs/${hubId}/request`, JSON.stringify(request), {
      qos: 0,
      retain: false,
    });
    await until(() => replies.length > previousReplies + 1);
    assert.equal(calls, 2, 'Identical duplicate returns cached reply without actuation');
    let release!: () => void;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const uncertain = bridge.request(
      hubId,
      'POST',
      '/devices/fcplcn-cloud-test/commands',
      { controller: 'sockets', itemId: 'socket-1', value: true },
      actor,
    );
    await until(() => calls === 3);
    const oldSession = bridge.snapshot(hubId).sessionId;
    await uplink.stop();
    await assert.rejects(uncertain, (error: unknown) =>
      Boolean(error && typeof error === 'object' && 'unknown' in error && error.unknown),
    );
    release();
    hold = null;
    await sleep(30);
    uplink.start();
    await until(
      () => bridge.snapshot(hubId).online && bridge.snapshot(hubId).sessionId !== oldSession,
    );
    await sleep(150);
    assert.equal(calls, 3, 'Reconnect does not replay the unconfirmed command');
    assert.equal(
      (
        await bridge.request(
          hubId,
          'POST',
          '/devices/fcplcn-cloud-test/commands',
          { controller: 'sockets', itemId: 'socket-1', value: false },
          actor,
        )
      ).status,
      200,
    );
    assert.equal(calls, 4);
    bridge.revoke(hubId);
    await admin.revoke(hubId);
    assert.equal(bridge.snapshot(hubId).online, false);
    await assert.rejects(
      bridge.request(hubId, 'GET', '/overview', undefined, actor),
      /связи|отозвано/,
    );
  },
);
const pem = (value: string | undefined) =>
  value && !value.includes('-----BEGIN') ? readFileSync(value, 'utf8') : value;
