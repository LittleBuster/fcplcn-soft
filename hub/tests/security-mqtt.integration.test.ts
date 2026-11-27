/** @file Exercise per-PLC MQTT5 ACLs and the hub channels for iButton and irrigation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mqtt, { type IPublishPacket, type MqttClient } from 'mqtt';
import { createEngine } from '../src/engine.js';
import type {
  SecurityLeasePacket,
  SecurityTouchEvent,
  SecurityTouchPacket,
} from '../shared/security-sync.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 5000) {
  const limit = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > limit) throw new Error('Security MQTT condition timed out');
    await delay(20);
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const end = (client: MqttClient | undefined) =>
  client
    ? new Promise<void>((resolve) => client.end(true, {}, () => resolve()))
    : Promise.resolve();

test(
  'real broker scopes iButton and irrigation, rejects retained reports and retires reconnect authority',
  { timeout: 25000 },
  async (t) => {
    const find = (name: string, paths: string[]) =>
      paths.find(existsSync) || spawnSync('which', [name], { encoding: 'utf8' }).stdout?.trim();
    const executable = find('mosquitto', [
      '/opt/homebrew/sbin/mosquitto',
      '/usr/sbin/mosquitto',
      '/usr/bin/mosquitto',
    ]);
    const passwd = find('mosquitto_passwd', [
      '/opt/homebrew/bin/mosquitto_passwd',
      '/usr/bin/mosquitto_passwd',
      '/usr/sbin/mosquitto_passwd',
    ]);
    if (!executable || !passwd) {
      t.skip('Mosquitto and mosquitto_passwd are not installed');
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), 'fcplcn-security-mqtt-'));
    chmodSync(directory, 0o755);
    const id = 'fcplcn-security-integration',
      other = 'fcplcn-security-outsider',
      hub = 'fcplcn-security-test-hub',
      bootId = 'security-boot';
    const passwords = join(directory, 'passwords'),
      acl = join(directory, 'acl'),
      config = join(directory, 'mosquitto.conf');
    // All credentials in this file belong exclusively to the disposable loopback fixture.
    writeFileSync(
      passwords,
      `${hub}:fixture-hub-password\n${id}:fixture-plc-password\n${other}:fixture-other-password\n`,
      { mode: 0o600 },
    );
    assert.equal(spawnSync(passwd, ['-U', passwords], { stdio: 'ignore' }).status, 0);
    chmodSync(passwords, 0o644);
    const scriptPath = [
      new URL('../../deploy/setup-broker.sh', import.meta.url),
      join(process.cwd(), 'hub/deploy/setup-broker.sh'),
      join(process.cwd(), 'deploy/setup-broker.sh'),
    ].find((path) => existsSync(path));
    assert.ok(scriptPath);
    const script = readFileSync(scriptPath, 'utf8');
    const template = /cat > "\$acl_file" <<EOF\n([\s\S]*?)\nEOF/.exec(script)?.[1];
    assert.ok(template);
    writeFileSync(acl, template.replaceAll('$hub_user', hub), { mode: 0o644 });
    const port = await freePort(),
      url = `mqtt://127.0.0.1:${port}`;
    writeFileSync(
      config,
      `listener ${port} 127.0.0.1\nallow_anonymous false\npassword_file ${passwords}\nacl_file ${acl}\npersistence false\n`,
      { mode: 0o644 },
    );
    let broker: ChildProcess | undefined,
      plc: MqttClient | undefined,
      outsider: MqttClient | undefined;
    const began = Date.now(),
      up = () => 100000 + Date.now() - began;
    const leases: { body: SecurityLeasePacket; packet: IPublishPacket }[] = [],
      commands: Record<string, unknown>[] = [],
      events: SecurityTouchEvent[] = [],
      tankReplies: { body: Record<string, unknown>; packet: IPublishPacket }[] = [];
    let heartbeatSequence = 0,
      commandSequence = 0;
    const engine = createEngine({
      product: { id: 'fcplcn', name: 'FCPLCn', fullName: 'Future City PLC Next' },
      mode: 'mqtt',
      brokerUrl: url,
      username: hub,
      password: 'fixture-hub-password',
      clientId: hub,
      staleAfterMs: 35000,
      commandTimeoutMs: 900,
      labels: {},
      onLabelsChanged() {},
    });
    engine.onSecurityTouch!((event) => events.push(event));
    const stopBroker = async () => {
      if (!broker || broker.exitCode !== null) return;
      const active = broker;
      const stopped = new Promise<void>((resolve) => active.once('exit', () => resolve()));
      active.kill('SIGTERM');
      await stopped;
    };
    const startBroker = async () => {
      broker = spawn(executable, ['-c', config], { stdio: 'ignore' });
      const limit = Date.now() + 3000;
      await new Promise<void>((resolve, reject) => {
        const attempt = () => {
          const socket = net.connect(port, '127.0.0.1');
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', () => {
            socket.destroy();
            if (Date.now() > limit) reject(new Error('Isolated security broker did not start'));
            else setTimeout(attempt, 20);
          });
        };
        attempt();
      });
    };
    const connectPLC = async () => {
      plc = await mqtt.connectAsync(url, {
        protocolVersion: 5,
        username: id,
        password: 'fixture-plc-password',
        clientId: id,
        reconnectPeriod: 0,
        clean: true,
        queueQoSZero: false,
      });
      plc.on('message', (topic, bytes, packet) => {
        const data = JSON.parse(bytes.toString());
        if (topic.endsWith('/irrigation-water/reply')) tankReplies.push({ body: data, packet });
        if (topic.endsWith('/hub')) leases.push({ body: data as SecurityLeasePacket, packet });
        if (topic.endsWith('/set')) {
          commands.push(data);
          commandSequence = data.sequence;
          const current = leases.at(-1)!.body;
          const ok =
            data.hubEpoch === current.hubEpoch &&
            data.modeRevision === current.modeRevision &&
            data.leaseSequence === current.leaseSequence &&
            data.expiresAtUptimeMs <= current.expiresAtUptimeMs;
          void plc!.publishAsync(
            `fcplcn/${id}/controllers/security/ack`,
            JSON.stringify({ bootId, id: 'alarm', value: data.value, sequence: data.sequence, ok }),
            { qos: 0, retain: false },
          );
        }
      });
      await plc.subscribeAsync(
        [
          `fcplcn/${id}/controllers/security/hub`,
          `fcplcn/${id}/controllers/security/set`,
          `fcplcn/${id}/irrigation-water/reply`,
        ],
        { qos: 0, rap: true, rh: 2 },
      );
    };
    const announce = async () => {
      await plc!.publishAsync(
        `fcplcn/${id}/system/status`,
        JSON.stringify({
          schemaVersion: 1,
          deviceId: id,
          product: 'FCPLCn',
          bootId,
          sequence: ++heartbeatSequence,
          uptimeSec: Math.floor(up() / 1000),
          boardId: 'integration',
          firmwareVersion: 'security-sync',
          socketCommandSequence: 0,
          lightCommandSequence: 0,
          thermostatCommandSequence: 0,
          securityCommandSequence: commandSequence,
        }),
        { qos: 0, retain: false },
      );
      await plc!.publishAsync(
        `fcplcn/${id}/controllers/security/status`,
        JSON.stringify({
          bootId,
          uptimeMs: up(),
          enabled: true,
          armed: false,
          readyToArm: true,
          commandSequence,
          hubSync: { version: 1 },
          items: [{ id: 'zone-1', name: 'Дверь' }],
        }),
        { qos: 0, retain: false },
      );
    };
    const touch = (lease: SecurityLeasePacket, eventSequence: number): SecurityTouchPacket => ({
      schemaVersion: 1,
      bootId,
      hubEpoch: lease.hubEpoch,
      modeRevision: lease.modeRevision,
      leaseSequence: lease.leaseSequence,
      eventSequence,
      eventAtUptimeMs: up(),
      value: lease.touchArmed,
      keyId: 'authorized-key',
      keyName: 'Ключ интеграции',
      localApplied: true,
    });
    try {
      await startBroker();
      await connectPLC();
      await engine.start();
      await until(() => engine.snapshot().broker.connected);
      await delay(80);
      await announce();
      await until(
        () =>
          engine.snapshot().devices.find((device) => device.id === id)?.controllers.security
            ?.fresh === true,
      );
      outsider = await mqtt.connectAsync(url, {
        protocolVersion: 5,
        username: other,
        password: 'fixture-other-password',
        clientId: other,
        reconnectPeriod: 0,
      });
      let foreignLeases = 0;
      outsider.on('message', () => {
        foreignLeases++;
      });
      await outsider
        .subscribeAsync(`fcplcn/${id}/controllers/security/hub`)
        .catch((error) => assert.match(String(error), /authorized|failed/i));
      await assert.rejects(
        outsider.publishAsync(`fcplcn/${id}/controllers/security/event`, '{}', { qos: 1 }),
        /authorized/i,
      );
      const sourceBoot = 'water-source-boot';
      const tankReference = other + '/tank-water';
      await outsider.publishAsync(
        `fcplcn/${other}/system/status`,
        JSON.stringify({
          schemaVersion: 1,
          deviceId: other,
          product: 'FCPLCn',
          bootId: sourceBoot,
          sequence: 1,
          uptimeSec: Math.floor(up() / 1000),
          boardId: 'integration',
          firmwareVersion: 'tank-feed',
          socketCommandSequence: 0,
          lightCommandSequence: 0,
          thermostatCommandSequence: 0,
          securityCommandSequence: 0,
        }),
      );
      await until(() =>
        engine.snapshot().devices.some((device) => device.id === other && device.online),
      );
      await assert.rejects(
        outsider.publishAsync(`fcplcn/${id}/irrigation-water/reply`, '{}', { qos: 1 }),
        /authorized/i,
      );
      const report = (water: boolean, retain: boolean) =>
        outsider!.publishAsync(
          `fcplcn/${other}/irrigation-water/source`,
          JSON.stringify({
            bootId: sourceBoot,
            uptimeMs: up(),
            items: [{ id: 'tank-water', name: 'Бак', water }],
          }),
          { qos: 1, retain },
        );
      const requestTank = async (sequence: number) => {
        if (sequence > 1) await delay(525);
        await plc!.publishAsync(
          `fcplcn/${id}/irrigation-water/request`,
          JSON.stringify({ bootId, sequence, sources: [tankReference] }),
          { qos: 1 },
        );
        const reply = () =>
          tankReplies.find(({ body }) => body.sequence === sequence && body.source === other);
        await until(() => Boolean(reply()));
        assert.equal(reply()!.packet.retain, false);
        assert.equal(reply()!.packet.qos, 0);
        return reply()!.body.water;
      };
      await report(true, true);
      assert.equal(await requestTank(1), null, 'Retained water never authorizes watering');
      await report(true, false);
      assert.equal(await requestTank(2), true);
      await report(false, false);
      assert.equal(await requestTank(3), false);
      await outsider.publishAsync(`fcplcn/${other}/availability`, 'offline', { qos: 1 });
      await until(
        () => engine.snapshot().devices.find((device) => device.id === other)?.online === false,
      );
      assert.equal(await requestTank(4), null);
      const fence = await engine.sendSecurityLease!(id, {
        hubEpoch: 'integration-hub-epoch',
        modeRevision: 0,
        touchArmed: true,
        busy: false,
      });
      await until(() => leases.length === 1);
      await delay(30);
      assert.equal(foreignLeases, 0, 'Another PLC cannot receive this device authority');
      assert.equal(leases[0].packet.qos, 0);
      assert.equal(leases[0].packet.retain, false);
      assert.ok((leases[0].packet.properties?.messageExpiryInterval || 0) <= 4);
      const first = touch(leases[0].body, 1);
      await plc!.publishAsync(`fcplcn/${id}/controllers/security/event`, JSON.stringify(first), {
        qos: 0,
        retain: true,
      });
      await delay(50);
      assert.equal(
        events.length,
        0,
        'Retained source messages are rejected even on an existing subscription',
      );
      await plc!.publishAsync(`fcplcn/${id}/controllers/security/event`, JSON.stringify(first), {
        qos: 0,
        retain: false,
      });
      await until(() => events.length === 1);
      await plc!.publishAsync(`fcplcn/${id}/controllers/security/event`, JSON.stringify(first), {
        qos: 0,
        retain: false,
      });
      await delay(40);
      assert.equal(events.length, 1);
      assert.equal(
        (await engine.command(id, 'security', 'alarm', true, undefined, fence)).status,
        'applied',
      );
      const sentBefore = commands.length;
      await stopBroker();
      await until(() => !engine.snapshot().broker.connected);
      await end(plc);
      plc = undefined;
      await end(outsider);
      outsider = undefined;
      await startBroker();
      await connectPLC();
      await until(() => engine.snapshot().broker.connected);
      await delay(80);
      await announce();
      await until(
        () =>
          engine.snapshot().devices.find((device) => device.id === id)?.controllers.security
            ?.fresh === true,
      );
      const next = await engine.sendSecurityLease!(id, {
        hubEpoch: 'integration-hub-epoch',
        modeRevision: 1,
        touchArmed: false,
        busy: false,
      });
      await until(() => leases.length === 2);
      assert.ok(next.leaseSequence > fence.leaseSequence);
      await plc!.publishAsync(
        `fcplcn/${id}/controllers/security/event`,
        JSON.stringify({ ...first, eventSequence: 2, eventAtUptimeMs: up() }),
        { qos: 0, retain: false },
      );
      await delay(50);
      assert.equal(events.length, 1);
      assert.equal(commands.length, sentBefore, 'Reconnect creates no SET replay');
      const delayed = touch(leases.at(-1)!.body, 2);
      await delay(1600);
      await plc!.publishAsync(`fcplcn/${id}/controllers/security/event`, JSON.stringify(delayed), {
        qos: 0,
        retain: false,
      });
      await delay(50);
      assert.equal(events.length, 1, 'Source event age is bounded independently of lease expiry');
      await plc!.publishAsync(
        `fcplcn/${id}/controllers/security/event`,
        JSON.stringify(touch(leases.at(-1)!.body, 2)),
        { qos: 0, retain: false },
      );
      await until(() => events.length === 2);
    } finally {
      await engine.stop();
      await end(plc);
      await end(outsider);
      await stopBroker();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
