/** @file Connect the autonomous-PLC registry to MQTT or an isolated demonstration object. */
import mqtt, { type MqttClient } from 'mqtt';
import type { EngineOptions, HubEngine, ManagementRequest } from '../shared/types.js';
import { HubRegistry } from './protocol/registry.js';
import { createDemo } from './protocol/demo.js';
import { ManagementClient, ManagementError } from './protocol/management.js';

/** @brief Create a hub that never connects a demonstration object to real equipment. */
export function createEngine(options: EngineOptions): HubEngine {
  let client: MqttClient | undefined;
  let stopDemo: (() => void | Promise<void>) | undefined;
  let managementReady = false;
  let securityReady = false;
  let started = false;
  let outageTimer: NodeJS.Timeout | undefined;
  const registry = new HubRegistry(options, {
    async publish(topic, payload, expirySeconds) {
      if (options.mode === 'demo') {
        demoCommand(topic, payload);
        return;
      }
      const active = client;
      if (!active?.connected || active.disconnecting) throw new Error('MQTT disconnected');
      await new Promise<void>((resolve, reject) => {
        active.publish(
          topic,
          payload,
          { qos: 0, retain: false, properties: { messageExpiryInterval: expirySeconds } },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    },
  });
  let demoCommand: (topic: string, payload: string) => void = () => {
    throw new Error('Demo stopped');
  };
  let demoService:
    | ((
        deviceId: string,
        request: ManagementRequest,
      ) => Promise<{ status: number; data: Record<string, unknown> | unknown[] }>)
    | undefined;
  let demoSecurityTouch: HubEngine['demoSecurityTouch'];
  const management = new ManagementClient(
    () => registry.snapshot(),
    async (deviceId, request, expiry) => {
      if (!managementReady)
        throw new ManagementError('Канал настройки недоступен. Проверьте права MQTT-брокера');
      if (options.mode === 'demo') {
        if (!demoService) throw new Error('Demo stopped');
        const reply = await demoService(deviceId, request);
        management.receive(
          deviceId,
          JSON.stringify({
            schemaVersion: 1,
            requestId: request.requestId,
            bootId: request.bootId,
            sequence: request.sequence,
            ...reply,
          }),
        );
        return;
      }
      const active = client;
      if (!active?.connected || active.disconnecting) throw new Error('MQTT disconnected');
      await new Promise<void>((resolve, reject) =>
        active.publish(
          `${options.product.id}/${deviceId}/management/request`,
          JSON.stringify(request),
          { qos: 0, retain: false, properties: { messageExpiryInterval: expiry } },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    },
    options.commandTimeoutMs,
  );
  return {
    async start() {
      if (started) return;
      started = true;
      outageTimer = setInterval(() => registry.checkOutages(), 1000).unref();
      if (options.mode === 'demo') {
        registry.setConnection(true);
        const demo = createDemo(registry, options.product, { dataDir: options.demoDataDir });
        demoCommand = demo.command;
        stopDemo = demo.stop;
        demoService = demo.service;
        demoSecurityTouch = demo.securityTouch;
        managementReady = true;
        securityReady = true;
        return;
      }
      const active = mqtt.connect(options.brokerUrl, {
        protocolVersion: 5,
        clientId: options.clientId,
        username: options.username,
        password: options.password,
        clean: true,
        reconnectPeriod: 2000,
        connectTimeout: 5000,
        queueQoSZero: false,
        resubscribe: false,
        properties: { maximumPacketSize: 131_072 },
      });
      client = active;
      const current = () => started && client === active;
      active.on('connect', () => {
        if (!current()) return;
        managementReady = false;
        securityReady = false;
        management.disconnect();
        registry.setConnection(false);
        // MQTT.js can deliver retained PUBLISH packets before the subscribe callback.
        // A new epoch still prevents every old snapshot from authorizing commands.
        registry.setConnection(true);
        active.subscribe(
          `${options.product.id}/+/controllers/security/event`,
          { qos: 0, rap: true, rh: 2 },
          (error, grants) => {
            if (current() && active.connected)
              securityReady =
                !error && Boolean(grants?.length) && grants!.every((grant) => grant.qos <= 2);
          },
        );
        active.subscribe(
          [
            `${options.product.id}/+/availability`,
            `${options.product.id}/+/system/status`,
            `${options.product.id}/+/controllers/+/status`,
            `${options.product.id}/+/controllers/+/ack`,
          ],
          { qos: 0, rap: false, rh: 0 },
          (error, grants) => {
            if (!current() || !active.connected) return;
            if (error || !grants || grants.some((grant) => grant.qos === 128)) {
              registry.setConnection(false, `Брокер отклонил подписку ${options.product.name}`);
              return;
            }
            registry.setConnection(true);
          },
        );
        active.subscribe(
          `${options.product.id}/+/management/reply`,
          { qos: 0, rap: true, rh: 2 },
          (error, grants) => {
            if (current() && active.connected)
              managementReady =
                !error && Boolean(grants?.length) && grants!.every((grant) => grant.qos <= 2);
          },
        );
        active.subscribe(
          [
            `${options.product.id}/+/irrigation-water/source`,
            `${options.product.id}/+/irrigation-water/request`,
          ],
          { qos: 0, rap: true, rh: 2 },
        );
      });
      active.on('message', (topic, payload, packet) => {
        if (!current() || !active.connected) return;
        const parts = topic.split('/');
        if (
          parts.length === 4 &&
          parts[0] === options.product.id &&
          parts[2] === 'management' &&
          parts[3] === 'reply'
        )
          management.receive(parts[1], payload, packet.retain);
        else {
          registry.receive(topic, payload, packet.retain);
          if (parts[2] !== 'irrigation-water') management.observe();
        }
      });
      active.on('offline', () => {
        if (current()) {
          managementReady = false;
          securityReady = false;
          management.disconnect();
          registry.setConnection(false, 'Нет связи с MQTT-брокером');
        }
      });
      active.on('close', () => {
        if (current()) {
          managementReady = false;
          securityReady = false;
          management.disconnect();
          registry.setConnection(false, 'Нет связи с MQTT-брокером');
        }
      });
      active.on('error', () => {
        if (current()) {
          managementReady = false;
          securityReady = false;
          management.disconnect();
          registry.setConnection(false, 'Не удалось подключиться к MQTT-брокеру');
        }
      });
    },
    async stop() {
      started = false;
      clearInterval(outageTimer);
      outageTimer = undefined;
      managementReady = false;
      securityReady = false;
      management.disconnect();
      const retiredDemo = stopDemo;
      stopDemo = undefined;
      demoService = undefined;
      demoSecurityTouch = undefined;
      registry.close();
      const active = client;
      client = undefined;
      await Promise.all([
        registry.flushActivity(),
        retiredDemo?.(),
        active
          ? new Promise<void>((resolve) => active.end(true, {}, () => resolve()))
          : Promise.resolve(),
      ]);
    },
    snapshot: () => {
      const snapshot = registry.snapshot();
      for (const device of snapshot.devices)
        if (device.management) device.management.busy = management.busy(device.id);
      return snapshot;
    },
    command: (deviceId, kind, itemId, value, timeoutMs, fence) =>
      registry.command(deviceId, kind, itemId, value, timeoutMs, fence),
    sendSecurityLease: (deviceId, input) =>
      securityReady
        ? registry.sendSecurityLease(deviceId, input)
        : Promise.reject(new Error('Канал iButton недоступен; проверьте права MQTT-брокера')),
    onSecurityTouch: (handler) => registry.onSecurityTouch(handler),
    demoSecurityTouch: (deviceId, keyId) =>
      options.mode === 'demo' && demoSecurityTouch
        ? demoSecurityTouch(deviceId, keyId)
        : Promise.resolve({
            status: 403,
            data: { error: 'Имитация таблетки доступна только в демонстрации' },
          }),
    rename: (deviceId, name, room, illustrationId) =>
      registry.rename(deviceId, name, room, illustrationId),
    service: (deviceId, method, path, body, signal, timeoutMs) => {
      if (!managementReady)
        return Promise.reject(
          new ManagementError(
            'Канал настройки недоступен. Проверьте соединение и права MQTT-брокера',
          ),
        );
      return management.request(deviceId, method, path, body, signal, timeoutMs);
    },
  };
}
