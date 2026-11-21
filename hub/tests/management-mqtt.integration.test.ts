/** @file Exercise private PLC configuration over MQTT5 against an isolated real broker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mqtt, { type IPublishPacket, type MqttClient } from 'mqtt';
import type { ManagementReply, ManagementRequest } from '../shared/types.js';
import { createEngine } from '../src/engine.js';
import { ManagementError } from '../src/protocol/management.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Private MQTT management condition timed out');
    await delay(20);
  }
}
async function vacantPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function end(client: MqttClient): Promise<void> {
  await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
}

test(
  'MQTT management preserves private large replies, CAS errors and correlation without replay',
  { timeout: 25_000 },
  async (t) => {
    const executable =
      [
        '/opt/homebrew/sbin/mosquitto',
        '/usr/sbin/mosquitto',
        '/usr/bin/mosquitto',
        '/usr/local/sbin/mosquitto',
      ].find(existsSync) || spawnSync('which', ['mosquitto'], { encoding: 'utf8' }).stdout?.trim();
    if (!executable) {
      t.skip('Mosquitto is not installed');
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), 'fcplcn-hub-management-mqtt-'));
    const port = await vacantPort(),
      url = `mqtt://127.0.0.1:${port}`;
    const configuration = join(directory, 'mosquitto.conf');
    writeFileSync(
      configuration,
      `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\nmax_packet_size 131072\n`,
    );
    const id = 'fcplcn-management-integration',
      bootId = 'management-test-boot';
    const prefix = `fcplcn/${id}`;
    const sent: { request: ManagementRequest; packet: IPublishPacket }[] = [];
    let broker: ChildProcess | undefined, plc: MqttClient | undefined, parseError: unknown;
    const startedAt = Date.now();
    const engine = createEngine({
      product: { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' },
      mode: 'mqtt',
      brokerUrl: url,
      clientId: 'fcplcn-private-integration-hub',
      staleAfterMs: 35_000,
      commandTimeoutMs: 700,
      labels: {},
      onLabelsChanged() {},
    });
    const service = engine.service;
    assert.ok(service, 'The real engine exposes private configuration management');
    const startBroker = async () => {
      broker = spawn(executable, ['-c', configuration], { stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const attempt = () => {
          const socket = net.connect(port, '127.0.0.1');
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', () => {
            socket.destroy();
            if (Date.now() > deadline) reject(new Error('Isolated Mosquitto failed to start'));
            else setTimeout(attempt, 20);
          });
        };
        attempt();
      });
    };
    const stopBroker = async () => {
      if (!broker || broker.exitCode !== null) return;
      const active = broker;
      const exited = new Promise<void>((resolve) => active.once('exit', () => resolve()));
      active.kill('SIGTERM');
      await exited;
    };
    const connectPLC = async () => {
      plc = await mqtt.connectAsync(url, { protocolVersion: 5, reconnectPeriod: 0, clientId: id });
      plc.on('message', (topic, payload, packet) => {
        if (topic !== `${prefix}/management/request`) return;
        try {
          sent.push({ request: JSON.parse(payload.toString()) as ManagementRequest, packet });
        } catch (error) {
          parseError = error;
        }
      });
      await plc.subscribeAsync(`${prefix}/management/request`, { qos: 0, rap: true, rh: 2 });
    };
    const announce = async (sequence: number, managementSequence = 0) => {
      const uptimeMs = 100_000 + Date.now() - startedAt;
      await plc!.publishAsync(
        `${prefix}/system/status`,
        JSON.stringify({
          schemaVersion: 1,
          product: 'FCPLCn',
          deviceId: id,
          boardId: 'fcplcn-161608-1v0',
          firmwareVersion: 'management-integration',
          bootId,
          sequence,
          uptimeSec: Math.floor(uptimeMs / 1000),
          managementVersion: 1,
          managementSequence,
          socketCommandSequence: 0,
          lightCommandSequence: 0,
          thermostatCommandSequence: 0,
          securityCommandSequence: 0,
        }),
        { retain: false },
      );
      await plc!.publishAsync(
        `${prefix}/controllers/sockets/status`,
        JSON.stringify({
          bootId,
          uptimeMs,
          commandSequence: 0,
          enabled: true,
          items: [
            {
              id: 'socket-1',
              name: 'Розетка',
              relayId: 'rly-0/1',
              inputId: '',
              state: false,
              actual: false,
              available: true,
            },
          ],
        }),
        { retain: false },
      );
      await until(() => engine.snapshot().devices[0]?.online === true);
      await delay(50); // Both independent subscriptions must receive their SUBACKs.
    };
    const request = async (index: number) => {
      await until(() => sent.length > index || Boolean(parseError));
      assert.equal(parseError, undefined);
      const observed = sent[index];
      assert.equal(observed.packet.retain, false);
      assert.equal(observed.packet.qos, 0);
      assert.ok((observed.packet.properties?.messageExpiryInterval || 0) > 0);
      assert.equal(observed.request.schemaVersion, 1);
      assert.equal(observed.request.bootId, bootId);
      assert.equal(observed.request.sequence, index + 1);
      assert.match(observed.request.requestId, /^[a-f0-9-]{36}$/);
      assert.ok(observed.request.expiresAtUptimeMs > 100_000);
      assert.ok(observed.request.expiresAtUptimeMs <= 160_000 + Date.now() - startedAt);
      return observed.request;
    };
    const reply = (
      packet: ManagementRequest,
      status: number,
      data: ManagementReply['data'],
      overrides: Partial<ManagementReply> = {},
    ) => ({
      schemaVersion: 1 as const,
      requestId: packet.requestId,
      bootId: packet.bootId,
      sequence: packet.sequence,
      status,
      data,
      ...overrides,
    });
    const publishReply = async (value: ManagementReply, retain = false) =>
      plc!.publishAsync(`${prefix}/management/reply`, JSON.stringify(value), { qos: 0, retain });
    try {
      await startBroker();
      await connectPLC();
      await engine.start();
      await until(() => engine.snapshot().broker.connected);
      await delay(60);
      await announce(1);
      const getConfig = service(id, 'GET', '/config');
      let complete = false;
      void getConfig.then(
        () => {
          complete = true;
        },
        () => {
          complete = true;
        },
      );
      const first = await request(0);
      assert.equal(first.method, 'GET');
      assert.equal(first.path, '/config');
      assert.equal(first.body, undefined);
      const secret = 'private-password-never-telemetry';
      const privateData = {
        revision: 2,
        linux: { password: secret },
        user: { keys: ['private-ibutton-rom'] },
        padding: 'x'.repeat(40 * 1024),
      };
      const validReply = reply(first, 200, privateData);
      assert.ok(Buffer.byteLength(JSON.stringify(validReply)) > 32 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(validReply)) < 48 * 1024);
      await publishReply(validReply, true);
      await publishReply(reply(first, 200, privateData, { requestId: randomUUID() }));
      await publishReply(reply(first, 200, privateData, { bootId: 'retired-boot' }));
      await publishReply(reply(first, 200, privateData, { sequence: first.sequence + 1 }));
      await delay(80);
      assert.equal(
        complete,
        false,
        'Retained and unrelated private replies cannot complete the request',
      );
      await publishReply(validReply);
      assert.deepEqual((await getConfig).data, privateData);
      assert.equal(JSON.stringify(engine.snapshot()).includes(secret), false);
      assert.equal(JSON.stringify(engine.snapshot()).includes('private-ibutton-rom'), false);
      assert.equal(
        engine.snapshot().commands.length,
        0,
        'Management operations are excluded from public command history',
      );

      const profiles = service(id, 'GET', '/board-profiles');
      const second = await request(1);
      const catalog = [{ boardId: 'fcplcn-161608-1v0', name: 'FCPLCN-161608-1v0' }];
      await publishReply(reply(second, 200, catalog));
      assert.deepEqual((await profiles).data, catalog, 'Array replies retain their original shape');

      const stale = service(id, 'POST', '/controllers/sockets', {
        baseRevision: 1,
        enabled: true,
        items: [],
      });
      const third = await request(2);
      assert.equal(third.body?.baseRevision, 1);
      await publishReply(reply(third, 409, { error: 'Настройки изменились', revision: 2 }));
      assert.equal((await stale).status, 409, 'The hub preserves the PLC CAS rejection');
      const save = service(id, 'POST', '/controllers/sockets', {
        baseRevision: 2,
        enabled: true,
        items: [{ id: 'socket-1', name: 'Новая розетка', relayId: 'rly-0/1', inputId: '' }],
      });
      const fourth = await request(3);
      assert.equal(fourth.body?.baseRevision, 2);
      await publishReply(reply(fourth, 200, { ok: true, revision: 3 }));
      assert.deepEqual((await save).data, { ok: true, revision: 3 });

      const silent = service(id, 'POST', '/config', {
        baseRevision: 3,
        device: { name: 'Не подтверждено' },
      });
      const silentCheck = assert.rejects(
        silent,
        (error: unknown) =>
          error instanceof ManagementError && error.statusCode === 504 && error.unknown,
      );
      await request(4);
      await silentCheck;
      await delay(80);
      assert.equal(sent.length, 5, 'A timed-out mutation is not automatically retried');

      const interrupted = service(id, 'POST', '/config', {
        baseRevision: 3,
        device: { name: 'Без повторной отправки' },
      });
      const interruptedCheck = assert.rejects(
        interrupted,
        (error: unknown) => error instanceof ManagementError && error.unknown,
      );
      await request(5);
      await stopBroker();
      await interruptedCheck;
      await until(() => !engine.snapshot().broker.connected);
      await end(plc!);
      plc = undefined;
      await startBroker();
      await connectPLC();
      await until(() => engine.snapshot().broker.connected);
      await delay(120);
      await assert.rejects(service(id, 'GET', '/config'), /свежей связи/);
      assert.equal(sent.length, 6, 'Reconnect cannot replay a pending configuration write');
      await announce(2, 6);
      const freshRead = service(id, 'GET', '/config');
      const seventh = await request(6);
      await publishReply(reply(seventh, 200, { revision: 3 }));
      assert.deepEqual((await freshRead).data, { revision: 3 });
      assert.equal(sent.length, 7, 'Only the explicit fresh read was sent after reconnect');
      const beginUpload = service(id, 'POST', '/firmware/begin', {
        size: 12288,
        sha256: '1'.repeat(64),
      });
      const beginPacket = await request(7);
      assert.equal(beginPacket.path, '/firmware/begin');
      await publishReply(
        reply(beginPacket, 200, { ok: true, uploadId: 'test-upload', chunkSize: 12288 }),
      );
      assert.equal((await beginUpload).status, 200);
      const binary = Buffer.alloc(12288, 0xab).toString('base64');
      const uploadChunk = service(id, 'POST', '/firmware/chunk', {
        uploadId: 'test-upload',
        offset: 0,
        data: binary,
      });
      const chunkPacket = await request(8);
      assert.equal(chunkPacket.path, '/firmware/chunk');
      assert.equal(
        chunkPacket.body?.data,
        binary,
        'A complete bounded binary block crosses real MQTT unchanged',
      );
      await publishReply(reply(chunkPacket, 200, { ok: true, received: 12288 }));
      assert.equal((await uploadChunk).status, 200);
      const finishUpload = service(id, 'POST', '/firmware/finish', { uploadId: 'test-upload' });
      const finishPacket = await request(9);
      assert.equal(finishPacket.path, '/firmware/finish');
      await publishReply(
        reply(finishPacket, 200, {
          ok: true,
          rebootRequired: true,
          imageId: '2'.repeat(64),
          targetPartition: 'ota_1',
        }),
      );
      assert.equal((await finishUpload).status, 200);
      assert.equal(JSON.stringify(engine.snapshot()).includes(binary), false);
      assert.equal(
        engine.snapshot().commands.length,
        0,
        'Firmware bytes never enter telemetry or command history',
      );
      assert.equal(JSON.stringify(engine.snapshot()).includes(secret), false);
    } finally {
      await engine.stop();
      if (plc) await end(plc);
      await stopBroker();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
