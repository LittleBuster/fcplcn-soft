/** @file Virtual PLCs share the tested local web-service, I/O, persistence and controller model. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
  ControllerKind,
  ManagementReply,
  ManagementRequest,
  Product,
} from '../../shared/types.js';
import { HubRegistry, type CommandPacket } from './registry.js';
import { DemoPLC, demoRoms, demoKeys } from './demo-plc.js';
import { demoPresets } from './demo-presets.js';
import { remoteTankReference } from '../../shared/irrigation.js';

type RemoteTank = Parameters<
  DemoPLC['fixture']['controllers']['setRemoteIrrigationTanks']
>[0][number];
interface WaterRound {
  sequence: number;
  rows: Map<string, RemoteTank>;
}

/** @brief Start an isolated object; no operation is sent to real MQTT, GPIO or network configuration. */
export function createDemo(
  registry: HubRegistry,
  product: Product,
  options: { dataDir?: string } = {},
): {
  command(topic: string, payload: string): void;
  securityTouch(deviceId: string, keyId?: string): Promise<{ status: number; data: unknown }>;
  service(
    deviceId: string,
    request: ManagementRequest,
  ): Promise<Pick<ManagementReply, 'status' | 'data'>>;
  stop(): Promise<void>;
} {
  const temporary = !options.dataDir;
  const directory = options.dataDir
    ? join(options.dataDir, 'demo-plcs')
    : mkdtempSync(join(tmpdir(), 'fcplcn-hub-demo-'));
  const devices: DemoPLC[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const waterRounds = new Map<DemoPLC, WaterRound>();
  let waterSequence = 0;
  let waterPollAt = 0;
  let stopped = false;

  function publish(device: DemoPLC): void {
    if (stopped) return;
    const up = device.uptimeMs();
    registry.receive(
      product.id + '/' + device.preset.id + '/system/status',
      JSON.stringify({
        deviceId: device.preset.id,
        product: product.name,
        schemaVersion: 1,
        boardId: device.boardId(),
        firmwareVersion: device.fixture.firmware.snapshot().version,
        bootId: device.bootId,
        sequence: ++device.heartbeatSequence,
        uptimeSec: Math.floor(up / 1000),
        socketCommandSequence: device.sequences.sockets,
        lightCommandSequence: device.sequences.lights,
        thermostatCommandSequence: device.sequences.thermostats,
        securityCommandSequence: device.sequences.security,
        tankCommandSequence: device.sequences.tanks,
        irrigationCommandSequence: device.sequences.irrigation,
        managementVersion: 1,
        managementSequence: device.managementSequence,
      }),
    );
    for (const [kind, data] of Object.entries(device.snapshots()))
      registry.receive(
        product.id + '/' + device.preset.id + '/controllers/' + kind + '/status',
        JSON.stringify({
          ...data,
          commandSequence:
            kind === 'meteo' ? undefined : device.sequences[kind as keyof typeof device.sequences],
          bootId: device.bootId,
          uptimeMs: up,
        }),
      );
  }

  function exchangeTankReports(): void {
    // Emit the actual local safety observation, independently from the public tank dashboard.
    for (const device of devices) {
      const { bootId, preset } = device;
      registry.receive(
        `${product.id}/${preset.id}/irrigation-water/source`,
        JSON.stringify({
          bootId,
          uptimeMs: device.uptimeMs(),
          items: device.fixture.controllers.irrigationWaterSource(),
        }),
      );
    }
    for (const device of devices) {
      const controllers = device.fixture.controllers;
      const requested = controllers.exportSettings().irrigation.items;
      const sources = Array.isArray(requested)
        ? [
            ...new Set(
              requested.map(({ tankId }) => tankId).filter((ref) => remoteTankReference(ref)),
            ),
          ]
        : [];
      const started = performance.now();
      const round = { sequence: ++waterSequence, rows: new Map<string, RemoteTank>() };
      waterRounds.set(device, round);
      registry.receive(
        `${product.id}/${device.preset.id}/irrigation-water/request`,
        JSON.stringify({
          bootId: device.bootId,
          sequence: round.sequence,
          sources,
        }),
      );
      waterRounds.delete(device);
      controllers.setRemoteIrrigationTanks(
        [...round.rows.values()],
        Math.floor(3000 - (performance.now() - started)),
      );
      publish(device);
    }
  }
  try {
    for (const preset of demoPresets(product, demoRoms, demoKeys)) {
      const device = new DemoPLC(
        preset,
        join(directory, preset.id),
        () => publish(device),
        (event) =>
          registry.receive(
            `${product.id}/${preset.id}/controllers/security/event`,
            JSON.stringify(event),
          ),
      );
      devices.push(device);
      publish(device);
      if (registry.snapshot().devices.find((entry) => entry.id === preset.id)?.name === preset.id)
        registry.rename(preset.id, preset.name, preset.room);
    }
  } catch (error) {
    for (const device of devices) void device.stop();
    if (temporary) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const interval = setInterval(() => {
    for (const device of devices) publish(device);
    const now = performance.now();
    if (now >= waterPollAt) {
      exchangeTankReports();
      waterPollAt = now + 1000;
    }
  }, 500).unref();
  return {
    command(topic, payload) {
      if (stopped) throw new Error('Demo stopped');
      const parts = topic.split('/');
      const device = devices.find((entry) => entry.preset.id === parts[1]);
      if (parts[2] === 'irrigation-water' && parts[3] === 'reply') {
        const round = device && waterRounds.get(device);
        const reply = JSON.parse(payload);
        const id = `${reply.source}/${reply.id}`;
        if (
          round &&
          reply.bootId === device.bootId &&
          reply.sequence === round.sequence &&
          !round.rows.has(id)
        )
          round.rows.set(id, {
            id,
            name: reply.name,
            deviceName: reply.sourceName,
            waterAvailable: reply.water,
          });
        return;
      }
      const kind = parts[3] as ControllerKind;
      if (
        !device ||
        !['sockets', 'lights', 'thermostats', 'security', 'tanks', 'irrigation'].includes(kind)
      )
        throw new Error('Demo PLC not found');
      if (parts[4] === 'hub' && kind === 'security') {
        device.receiveSecurityLease(JSON.parse(payload));
        return;
      }
      const packet = JSON.parse(payload) as CommandPacket;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (stopped) return;
        void (async () => {
          let result: Pick<ManagementReply, 'status' | 'data'>;
          try {
            result = await device.command(kind, packet);
          } catch (error) {
            result = {
              status: 503,
              data: {
                error: error instanceof Error ? error.message : 'Виртуальный PLC недоступен',
              },
            };
          }
          if (stopped) return;
          device.sequences[kind as keyof typeof device.sequences] = packet.sequence;
          registry.receive(
            topic.replace(/\/set$/, '/ack'),
            JSON.stringify({
              ok: result.status === 200,
              bootId: device.bootId,
              sequence: packet.sequence,
              id: packet.id,
              value: packet.value,
              duplicate: false,
              ...(result.status !== 200
                ? { error: !Array.isArray(result.data) ? result.data.error : 'Команда отклонена' }
                : {}),
            }),
          );
          publish(device);
        })();
      }, 100).unref();
      timers.add(timer);
    },
    async service(deviceId, request) {
      const device = devices.find((entry) => entry.preset.id === deviceId);
      if (!device || stopped) return { status: 503, data: { error: 'Виртуальный PLC недоступен' } };
      return device.service(request);
    },
    async securityTouch(deviceId, keyId) {
      const device = devices.find((entry) => entry.preset.id === deviceId);
      if (!device || stopped) return { status: 503, data: { error: 'Виртуальный PLC недоступен' } };
      return device.securityTouch(keyId);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.all(devices.map((device) => device.stop()));
      if (temporary) rmSync(directory, { recursive: true, force: true });
    },
  };
}
