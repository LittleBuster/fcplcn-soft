/** @file Exercise MQTT5 discovery, retained snapshots and confirmed SET against an isolated broker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mqtt, { type MqttClient } from 'mqtt';
import { createEngine } from '../src/engine.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('MQTT integration condition timed out');
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
  'real MQTT5 broker confirms fresh commands and never replays a command after disconnect',
  { timeout: 20_000 },
  async (t) => {
    const executable =
      ['/opt/homebrew/sbin/mosquitto', '/usr/sbin/mosquitto', '/usr/bin/mosquitto'].find(
        existsSync,
      ) || spawnSync('which', ['mosquitto'], { encoding: 'utf8' }).stdout?.trim();
    if (!executable) {
      t.skip('Mosquitto is not installed');
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), 'fcplcn-hub-mqtt-'));
    const port = await vacantPort();
    const config = join(directory, 'mosquitto.conf');
    writeFileSync(config, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
    let broker: ChildProcess | undefined;
    let plc: MqttClient | undefined;
    const url = `mqtt://127.0.0.1:${port}`;
    const engine = createEngine({
      product: { name: 'FCPLCn', fullName: 'Future City PLC Next', id: 'fcplcn' },
      mode: 'mqtt',
      brokerUrl: url,
      clientId: 'fcplcn-hub-integration',
      staleAfterMs: 35_000,
      commandTimeoutMs: 2000,
      labels: {},
      onLabelsChanged() {},
    });
    const startBroker = async () => {
      broker = spawn(executable, ['-c', config], { stdio: 'ignore' });
      await until(() => broker?.exitCode === null, 1000);
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
            if (Date.now() > deadline) reject(new Error('Mosquitto failed to start'));
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
    const id = 'fcplcn-integration-plc';
    const heartbeat = (sequence: number) =>
      JSON.stringify({
        deviceId: id,
        product: 'FCPLCn',
        schemaVersion: 1,
        boardId: 'fcplcn-161608-1v0',
        firmwareVersion: 'integration',
        bootId: 'boot-integration',
        sequence,
        uptimeSec: 100,
        socketCommandSequence: 3,
        lightCommandSequence: 0,
        thermostatCommandSequence: 0,
        securityCommandSequence: 0,
      });
    const status = (actual = false, sequence = 3) =>
      JSON.stringify({
        enabled: true,
        commandSequence: sequence,
        bootId: 'boot-integration',
        uptimeMs: 100_000,
        items: [
          { id: 'socket-1', name: 'Тестовая розетка', state: actual, actual, available: true },
        ],
      });
    try {
      await startBroker();
      plc = await mqtt.connectAsync(url, { protocolVersion: 5, reconnectPeriod: 0, clientId: id });
      await plc.publishAsync(`fcplcn/${id}/system/status`, heartbeat(1), { retain: true });
      await plc.publishAsync(`fcplcn/${id}/controllers/sockets/status`, status(), { retain: true });
      const published: Record<string, unknown>[] = [];
      let acknowledge = true;
      await plc.subscribeAsync(`fcplcn/${id}/controllers/sockets/set`, { qos: 0, rap: true });
      plc.on('message', (topic, payload, packet) => {
        const data = JSON.parse(payload.toString()) as Record<string, unknown>;
        published.push(data);
        assert.equal(packet.retain, false);
        assert.equal(packet.qos, 0);
        assert.ok((packet.properties?.messageExpiryInterval || 0) > 0);
        if (!acknowledge) return;
        void plc!.publishAsync(
          topic.replace(/\/set$/, '/ack'),
          JSON.stringify({ ...data, ok: true, duplicate: false }),
        );
        void plc!.publishAsync(
          topic.replace(/\/set$/, '/status'),
          status(data.value as boolean, data.sequence as number),
          { retain: true },
        );
      });
      await engine.start();
      await until(() => engine.snapshot().devices.length === 1);
      assert.equal(
        engine.snapshot().devices[0].online,
        false,
        'Retained bootstrap is never fresh authority',
      );
      await assert.rejects(engine.command(id, 'sockets', 'socket-1', true), /свежих/);
      await plc.publishAsync(`fcplcn/${id}/system/status`, heartbeat(2), { retain: true });
      await plc.publishAsync(`fcplcn/${id}/controllers/sockets/status`, status(), { retain: true });
      await until(() => engine.snapshot().devices[0]?.controllers.sockets?.fresh === true);
      const applied = await engine.command(id, 'sockets', 'socket-1', true);
      assert.equal(applied.status, 'applied');
      assert.equal(published[0].sequence, 4);
      assert.equal(published[0].bootId, 'boot-integration');
      assert.ok(
        Number(published[0].expiresAtUptimeMs) > 100_000 &&
          Number(published[0].expiresAtUptimeMs) <= 160_000,
      );
      await until(
        () =>
          (
            engine.snapshot().devices[0].controllers.sockets!.data.items as Record<
              string,
              unknown
            >[]
          )[0].actual === true,
      );
      acknowledge = false;
      const uncertain = engine.command(id, 'sockets', 'socket-1', false);
      await until(() => published.length === 2);
      await stopBroker();
      assert.equal((await uncertain).status, 'unknown');
      await until(() => !engine.snapshot().broker.connected);
      await startBroker();
      await until(() => engine.snapshot().broker.connected);
      await delay(100);
      await assert.rejects(engine.command(id, 'sockets', 'socket-1', false), /свежих/);
      assert.equal(published.length, 2, 'Old command was never queued for reconnect replay');
      const stopping = engine.stop();
      await engine.start();
      await stopping;
      await until(() => engine.snapshot().broker.connected);
      await delay(100);
      assert.equal(
        engine.snapshot().broker.connected,
        true,
        'Retired client events cannot disconnect the replacement client',
      );
    } finally {
      await engine.stop();
      if (plc) await end(plc);
      await stopBroker();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
