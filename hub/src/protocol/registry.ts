import { remoteTankReference, validIrrigationTelemetry } from '../../shared/irrigation.js';
import { validTankTelemetry } from '../../shared/tanks.js';
/** @file Bounded MQTT registry, freshness checks and confirmed command correlation. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_DEVICE_ILLUSTRATION,
  isDeviceIllustrationId,
  type DeviceIllustrationId,
} from '../../shared/device-art.js';
import type { DeviceOutage } from '../../shared/activity.js';
import {
  controllerKinds,
  type CommandView,
  type ControllerKind,
  type ControllerView,
  type DeviceLabel,
  type DeviceView,
  type EngineOptions,
  type EngineSnapshot,
  type WritableControllerKind,
} from '../../shared/types.js';
import {
  SECURITY_LEASE_MS,
  isSecurityCommandFence,
  isSecurityLeaseInput,
  isSecurityTouchPacket,
  type SecurityCommandFence,
  type SecurityLeaseInput,
  type SecurityLeasePacket,
  type SecurityTouchEvent,
} from '../../shared/security-sync.js';

const MAX_DEVICES = 256;
const MAX_ACTIVITY_ENTRIES = 100;
const MAX_MESSAGE_BYTES = 65_536;
const MAX_SEQUENCE = 0xffff_ffff;
const MAX_REMOTE_TANKS = 96;
const WATER_FRESH_MS = 2000;
const REMOTE_REQUEST_MIN_INTERVAL_MS = 500;
const reservedKeys = new Set(['__proto__', 'prototype', 'constructor']);
const sequenceFields: Record<WritableControllerKind, string> = {
  sockets: 'socketCommandSequence',
  lights: 'lightCommandSequence',
  thermostats: 'thermostatCommandSequence',
  security: 'securityCommandSequence',
  tanks: 'tankCommandSequence',
  irrigation: 'irrigationCommandSequence',
};

export interface CommandPacket extends Partial<SecurityCommandFence> {
  bootId: string;
  id: string;
  value: boolean;
  sequence: number;
  expiresAtUptimeMs: number;
}

export interface RegistryTransport {
  /** Publish once; implementations must never queue or retransmit an offline command. */
  publish(topic: string, payload: string, expirySeconds: number): Promise<void>;
}

interface Observation {
  data: Record<string, unknown>;
  at: number;
  wall: string;
  live: boolean;
  epoch: number;
}

interface WaterSource {
  id: string;
  name: string;
  water: boolean | null;
}

interface WaterReport {
  bootId: string;
  uptimeMs: number;
  at: number;
  sampleAgeMs: number;
  generation: number;
  items: WaterSource[];
}

interface Device {
  id: string;
  heartbeat?: Observation;
  controllers: Map<ControllerKind, Observation>;
  availability: 'online' | 'offline' | 'unknown';
  retiredBoots: Set<string>;
  sequences: Map<WritableControllerKind, { bootId: string; value: number }>;
  securityLeaseSequence: number;
  connectionGeneration: number;
  securityEvent?: { bootId: string; sequence: number };
  waterReport?: WaterReport;
  waterRequest?: { bootId: string; sequence: number; at: number };
}
interface IssuedSecurityLease {
  packet: SecurityLeasePacket;
  at: number;
  uptime: number;
  epoch: number;
}

interface Pending {
  view: CommandView;
  bootId: string;
  deadline: number;
  sent: boolean;
  recorded?: Promise<void>;
  resolve(result: CommandView): void;
  timer: ReturnType<typeof setTimeout>;
}

/** @brief An operational refusal that the local HTTP API may report without a stack trace. */
export class EngineError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function identifier(value: unknown, maximum: number): value is string {
  return text(value, maximum) && /^[a-zA-Z0-9_-]+$/.test(value) && !reservedKeys.has(value);
}

function waterSource(value: unknown): value is WaterSource {
  return (
    object(value) &&
    identifier(value.id, 32) &&
    text(value.name, 64) &&
    (value.water === null || typeof value.water === 'boolean')
  );
}

function wireLabel(label: string): string {
  let byteCount = 0;
  let result = '';
  for (const char of label) {
    byteCount += Buffer.byteLength(char);
    if (byteCount > 64) break;
    result += char;
  }
  return result;
}

function heartbeatUptime(heartbeat: Observation, at: number): number {
  return (heartbeat.data.uptimeSec as number) * 1000 + Math.floor(at - heartbeat.at);
}

/** @brief Parse bounded JSON and reject poison keys and excessive nesting before publication. */
function decode(payload: Uint8Array | string): Record<string, unknown> | null {
  if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) return null;
  try {
    let nodes = 0;
    const value: unknown = JSON.parse(
      typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'),
    );
    const valid = (part: unknown, depth: number): boolean => {
      if (++nodes > 8192 || depth > 16) return false;
      if (Array.isArray(part)) return part.every((child) => valid(child, depth + 1));
      if (object(part))
        return Object.entries(part).every(
          ([key, child]) => !reservedKeys.has(key) && valid(child, depth + 1),
        );
      return (
        part === null ||
        typeof part === 'string' ||
        typeof part === 'boolean' ||
        (typeof part === 'number' && Number.isFinite(part))
      );
    };
    return object(value) && valid(value, 0) ? value : null;
  } catch {
    return null;
  }
}

/** @brief Do not relay allowlisted key serials or credential-like fields to browsers. */
function publicData(value: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(value);
  const redact = (part: unknown): void => {
    if (Array.isArray(part)) part.forEach(redact);
    else if (object(part)) {
      for (const key of Object.keys(part)) {
        if (['keys', 'password', 'secret', 'token', 'credentials'].includes(key.toLowerCase()))
          delete part[key];
        else redact(part[key]);
      }
    }
  };
  redact(result);
  return result;
}

/** @brief Keep display snapshots separate from evidence authorizing operative commands. */
export class HubRegistry {
  private readonly devices = new Map<string, Device>();
  private readonly history: CommandView[];
  private readonly outages: DeviceOutage[];
  private readonly openOutages = new Map<string, DeviceOutage>();
  private readonly activityWrites = new Set<Promise<void>>();
  private readonly pending = new Map<string, Pending>();
  private labels: Record<string, DeviceLabel>;
  private connected = false;
  private brokerError: string | null = null;
  private epoch = 0;
  private readonly securityLeases = new Map<string, IssuedSecurityLease[]>();
  private readonly securityListeners = new Set<(event: SecurityTouchEvent) => void>();

  constructor(
    private readonly options: EngineOptions,
    private readonly transport: RegistryTransport,
    private readonly now: () => number = () => performance.now(),
    private readonly wallNow: () => string = () => new Date().toISOString(),
  ) {
    this.labels = structuredClone(options.labels);
    this.history = structuredClone(options.activity?.commands ?? []).slice(0, MAX_ACTIVITY_ENTRIES);
    this.outages = structuredClone(options.activity?.outages ?? []);
    for (const outage of this.outages)
      if (outage.onlineAt === null) this.openOutages.set(outage.deviceId, outage);
  }

  /** @brief Invalidate freshness and outstanding work whenever the MQTT connection is lost. */
  setConnection(connected: boolean, error: string | null = null): void {
    if (this.connected !== connected) {
      this.epoch++;
      this.securityLeases.clear();
      for (const device of this.devices.values()) device.connectionGeneration++;
      if (!connected) this.finishAll('Связь с брокером потеряна; результат команды неизвестен');
    }
    this.connected = connected;
    this.brokerError = error;
  }

  /** @brief Accept only known topic shapes and structurally valid firmware snapshots. */
  receive(topic: string, payload: Uint8Array | string, retained = false): void {
    if (!this.connected || Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) return;
    const parts = topic.split('/');
    if (
      parts[0] !== this.options.product.id ||
      !identifier(parts[1], 104) ||
      !parts[1].startsWith(`${this.options.product.id}-`)
    )
      return;
    const id = parts[1];
    if (parts.length === 3 && parts[2] === 'availability') {
      const value = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
      if (value !== 'online' && value !== 'offline') return;
      const device = this.device(id);
      if (!device) return;
      if (value === 'online' && device.availability === 'offline') device.connectionGeneration++;
      device.availability = value;
      if (value === 'offline') {
        if (!retained && device.heartbeat?.live && device.heartbeat.epoch === this.epoch)
          this.openOutage(device, 'availability');
        this.securityLeases.delete(id);
        if (device.heartbeat) device.heartbeat.live = false;
        for (const observation of device.controllers.values()) observation.live = false;
        this.finishDevice(id, 'PLC отключён; результат команды неизвестен');
      }
      return;
    }
    if (parts.length === 4 && parts[2] === 'irrigation-water') {
      if (retained || Buffer.byteLength(payload) > 4096) return;
      const data = decode(payload);
      if (!data) return;
      if (parts[3] === 'source') this.receiveWaterReport(id, data);
      if (parts[3] === 'request') this.replyToWaterRequest(id, data);
      return;
    }
    const data = decode(payload);
    if (!data) return;
    if (parts.length === 4 && parts[2] === 'system' && parts[3] === 'status') {
      this.heartbeat(id, data, retained);
      return;
    }
    if (
      parts.length !== 5 ||
      parts[2] !== 'controllers' ||
      !controllerKinds.includes(parts[3] as ControllerKind)
    )
      return;
    const kind = parts[3] as ControllerKind;
    if (kind === 'security' && parts[4] === 'event') {
      this.securityTouch(id, data, retained);
      return;
    }
    if (parts[4] === 'ack' && kind !== 'meteo') this.acknowledge(id, kind, data, retained);
    else if (parts[4] === 'status') this.controller(id, kind, data, retained);
  }

  private liveHeartbeat(device: Device, at: number): Observation | undefined {
    const heartbeat = device.heartbeat;
    return this.connected &&
      heartbeat?.live &&
      heartbeat.epoch === this.epoch &&
      at - heartbeat.at <= this.options.staleAfterMs &&
      device.availability !== 'offline'
      ? heartbeat
      : undefined;
  }

  private receiveWaterReport(id: string, data: Record<string, unknown>): void {
    const device = this.devices.get(id);
    const at = this.now();
    const heartbeat = device && this.liveHeartbeat(device, at);
    if (
      !device ||
      !heartbeat ||
      !identifier(data.bootId, 96) ||
      heartbeat.data.bootId !== data.bootId ||
      !integer(data.uptimeMs) ||
      !Array.isArray(data.items) ||
      data.items.length > 16 ||
      !data.items.every(waterSource) ||
      new Set(data.items.map((item) => item.id)).size !== data.items.length
    )
      return;
    const previous = device.waterReport;
    if (previous?.bootId === data.bootId && data.uptimeMs <= previous.uptimeMs) return;
    // Coarse PLC heartbeat uptime decoded at arrival gives a lower bound on actual sample age.
    const uptimeFloor = heartbeatUptime(heartbeat, at);
    if (Math.abs(uptimeFloor - data.uptimeMs) > WATER_FRESH_MS) return;
    device.waterReport = {
      bootId: data.bootId,
      uptimeMs: data.uptimeMs,
      at,
      sampleAgeMs: Math.max(0, uptimeFloor - data.uptimeMs),
      generation: device.connectionGeneration,
      items: data.items.map(({ id, name, water }) => ({ id, name, water })),
    };
  }

  /** Use legacy tank status for names alone. Only the live source protocol can authorize water. */
  private waterSources(device: Device, at: number): WaterSource[] {
    const report = device.waterReport;
    const heartbeat = this.liveHeartbeat(device, at);
    if (report && report.bootId === device.heartbeat?.data.bootId) {
      const fresh =
        heartbeat &&
        report.generation === device.connectionGeneration &&
        Math.max(
          at - report.at + report.sampleAgeMs,
          heartbeatUptime(heartbeat, at) - report.uptimeMs,
        ) < WATER_FRESH_MS;
      return fresh ? report.items : report.items.map((item) => ({ ...item, water: null }));
    }
    const catalogue = device.controllers.get('tanks')?.data.items;
    return Array.isArray(catalogue)
      ? catalogue.filter(object).map((item) => ({
          id: item.id as string,
          name: item.name as string,
          water: null,
        }))
      : [];
  }

  private replyToWaterRequest(id: string, data: Record<string, unknown>): void {
    const target = this.devices.get(id);
    const at = this.now();
    const heartbeat = target && this.liveHeartbeat(target, at);
    if (
      !target ||
      !heartbeat ||
      heartbeat.data.bootId !== data.bootId ||
      !identifier(data.bootId, 96) ||
      !integer(data.sequence, MAX_SEQUENCE) ||
      data.sequence < 1
    )
      return;
    const requested = data.sources === undefined ? [] : data.sources;
    if (!Array.isArray(requested) || requested.length > 16) return;
    const preferred = requested.map(remoteTankReference);
    if (preferred.some((reference) => !reference)) return;
    const previous = target.waterRequest;
    if (
      previous?.bootId === data.bootId &&
      (data.sequence <= previous.sequence || at - previous.at < REMOTE_REQUEST_MIN_INTERVAL_MS)
    )
      return;
    target.waterRequest = { bootId: data.bootId, sequence: data.sequence, at };

    const sent = new Set<string>();
    const topic = `${this.options.product.id}/${id}/irrigation-water/reply`;
    const send = (source: string, item: WaterSource) => {
      const key = `${source}/${item.id}`;
      if (sent.has(key) || sent.size >= MAX_REMOTE_TANKS) return;
      sent.add(key);
      const label = this.labels[source]?.name;
      const payload = JSON.stringify({
        bootId: data.bootId,
        sequence: data.sequence,
        source,
        sourceName: wireLabel(text(label, 128) && label ? label : source),
        id: item.id,
        name: wireLabel(item.name || item.id),
        water: item.water,
      });
      // The PLC also checks its own request deadline. Never queue or retry a reply.
      void this.transport.publish(topic, payload, 1).catch(() => {});
    };

    for (const reference of preferred) {
      if (!reference || reference.deviceId === id) continue;
      const { deviceId, tankId } = reference;
      const source = this.devices.get(deviceId);
      const item = source && this.waterSources(source, at).find((row) => row.id === tankId);
      send(deviceId, item ?? { id: tankId, name: tankId, water: null });
    }
    for (const source of this.devices.values()) {
      if (sent.size >= MAX_REMOTE_TANKS) break;
      if (source.id === id) continue;
      for (const item of this.waterSources(source, at)) send(source.id, item);
    }
  }

  /** @brief Return detached display values, always recalculating freshness from monotonic time. */
  snapshot(): EngineSnapshot {
    return {
      broker: { connected: this.connected, error: this.brokerError },
      devices: [...this.devices.values()]
        .map((device) => this.deviceView(device))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      commands: structuredClone(this.history),
      outages: structuredClone(this.outages),
    };
  }

  /** Observe a missed PLC heartbeat only while the local broker is reachable. */
  checkOutages(): void {
    if (!this.connected) return;
    const at = this.now();
    for (const device of this.devices.values()) this.checkHeartbeatTimeout(device, at);
  }

  private checkHeartbeatTimeout(device: Device, at: number): void {
    const heartbeat = device.heartbeat;
    if (
      heartbeat?.live &&
      heartbeat.epoch === this.epoch &&
      device.availability !== 'offline' &&
      at - heartbeat.at > this.options.staleAfterMs
    )
      this.openOutage(device, 'timeout');
  }

  private openOutage(device: Device, reason: DeviceOutage['reason']): void {
    if (this.openOutages.has(device.id)) return;
    const outage: DeviceOutage = {
      id: randomUUID(),
      deviceId: device.id,
      deviceName: this.labels[device.id]?.name || device.id,
      offlineAt: this.wallNow(),
      onlineAt: null,
      reason,
    };
    this.openOutages.set(device.id, outage);
    this.recordOutage(outage);
  }

  private recoverOutage(deviceId: string): void {
    const outage = this.openOutages.get(deviceId);
    if (!outage) return;
    this.openOutages.delete(deviceId);
    const observed = this.wallNow();
    // The real-time clock can move backwards while this controller is offline.
    const onlineAt = observed >= outage.offlineAt ? observed : outage.offlineAt;
    this.recordOutage({ ...outage, onlineAt });
  }

  private recordOutage(outage: DeviceOutage): void {
    const index = this.outages.findIndex(({ id }) => id === outage.id);
    if (index !== -1) this.outages.splice(index, 1);
    this.outages.unshift(outage);
    if (this.outages.length - this.openOutages.size > MAX_ACTIVITY_ENTRIES) {
      const oldestClosed = this.outages.findLastIndex(({ onlineAt }) => onlineAt !== null);
      this.outages.splice(oldestClosed, 1);
    }
    this.options.activity?.outageChanged?.({ ...outage });
  }

  /** @brief Register a synchronous observer of already validated, authorized source events. */
  onSecurityTouch(handler: (event: SecurityTouchEvent) => void): () => void {
    this.securityListeners.add(handler);
    return () => {
      this.securityListeners.delete(handler);
    };
  }

  /** @brief Issue short authority once; reconnect clears evidence without reusing an old sequence. */
  async sendSecurityLease(
    deviceId: string,
    input: SecurityLeaseInput,
  ): Promise<SecurityCommandFence> {
    if (!isSecurityLeaseInput(input)) throw new EngineError('Некорректная сессия охраны', 400);
    const device = this.devices.get(deviceId);
    if (!device) throw new EngineError('PLC не найден', 404);
    const view = this.deviceView(device);
    if (!view.online || !view.controllers.security?.fresh)
      throw new EngineError('Нет свежего канала охраны PLC', 503);
    if (device.securityLeaseSequence >= MAX_SEQUENCE)
      throw new EngineError('Исчерпан счётчик сессии охраны');
    const at = this.now(),
      uptime = this.deviceUptime(device, at);
    if (!Number.isSafeInteger(uptime) || uptime > Number.MAX_SAFE_INTEGER - 5000)
      throw new EngineError('Некорректные системные часы PLC', 503);
    const packet: SecurityLeasePacket = {
      schemaVersion: 1,
      bootId: view.bootId!,
      hubEpoch: input.hubEpoch,
      modeRevision: input.modeRevision,
      leaseSequence: ++device.securityLeaseSequence,
      expiresAtUptimeMs: uptime + SECURITY_LEASE_MS,
      touchArmed: input.touchArmed,
      busy: input.busy,
    };
    const issued = { packet, at, uptime, epoch: this.epoch };
    const recent = (this.securityLeases.get(deviceId) || []).filter(
      (row) => at - row.at < SECURITY_LEASE_MS,
    );
    recent.push(issued);
    this.securityLeases.set(deviceId, recent.slice(-16));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.transport.publish(
          `${this.options.product.id}/${deviceId}/controllers/security/hub`,
          JSON.stringify(packet),
          4,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new EngineError('Отправка сессии охраны не подтверждена', 503)),
            1000,
          ).unref();
        }),
      ]);
      if (!this.connected || issued.epoch !== this.epoch)
        throw new EngineError('Сессия охраны прервана', 503);
    } catch (error) {
      const rows = this.securityLeases.get(deviceId);
      if (rows)
        this.securityLeases.set(
          deviceId,
          rows.filter((row) => row !== issued),
        );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {
      hubEpoch: packet.hubEpoch,
      modeRevision: packet.modeRevision,
      leaseSequence: packet.leaseSequence,
    };
  }

  private deviceUptime(device: Device, at = this.now()): number {
    const heartbeat = device.heartbeat!;
    const controller = device.controllers.get('security');
    return Math.max(
      heartbeatUptime(heartbeat, at),
      controller?.live &&
        controller.epoch === this.epoch &&
        controller.data.bootId === heartbeat.data.bootId
        ? (controller.data.uptimeMs as number) + Math.floor(at - controller.at)
        : 0,
    );
  }

  /** @brief Recent leases absorb pulse races, while latest mode/target and monotonic source sequence remain authoritative. */
  private securityTouch(deviceId: string, data: Record<string, unknown>, retained: boolean): void {
    if (retained || !isSecurityTouchPacket(data)) return;
    const device = this.devices.get(deviceId);
    if (
      !device ||
      !this.deviceView(device).online ||
      !this.deviceView(device).controllers.security?.fresh ||
      data.bootId !== device.heartbeat?.data.bootId
    )
      return;
    const rows = this.securityLeases.get(deviceId),
      latest = rows?.at(-1),
      now = this.now();
    const issued = rows?.find(
      (row) =>
        row.packet.leaseSequence === data.leaseSequence && row.packet.hubEpoch === data.hubEpoch,
    );
    // A delayed status packet may carry a newer sequence but an old sampled clock.
    // The locally issued lease anchor keeps that packet from making a queued touch young again.
    const uptime = issued
      ? Math.max(this.deviceUptime(device, now), issued.uptime + Math.floor(now - issued.at))
      : 0;
    if (
      !latest ||
      !issued ||
      issued.epoch !== this.epoch ||
      now - issued.at >= SECURITY_LEASE_MS ||
      now - latest.at >= SECURITY_LEASE_MS ||
      data.hubEpoch !== latest.packet.hubEpoch ||
      data.modeRevision !== latest.packet.modeRevision ||
      data.modeRevision !== issued.packet.modeRevision ||
      data.value !== latest.packet.touchArmed ||
      data.value !== issued.packet.touchArmed ||
      data.eventAtUptimeMs < issued.uptime ||
      data.eventAtUptimeMs > issued.packet.expiresAtUptimeMs ||
      uptime > issued.packet.expiresAtUptimeMs ||
      data.eventAtUptimeMs > uptime + 1000 ||
      uptime - data.eventAtUptimeMs > 1500 ||
      (device.securityEvent?.bootId === data.bootId &&
        data.eventSequence <= device.securityEvent.sequence)
    )
      return;
    device.securityEvent = { bootId: data.bootId, sequence: data.eventSequence };
    if (latest.packet.busy || issued.packet.busy) return;
    const event: SecurityTouchEvent = { ...data, deviceId };
    for (const listener of this.securityListeners) {
      try {
        listener(structuredClone(event));
      } catch {
        /* One observer cannot replay a consumed source event. */
      }
    }
  }

  /** @brief Persist hub-owned presentation; legacy renames retain the selected illustration. */
  rename(
    deviceId: string,
    name: string,
    room: string,
    illustrationId?: DeviceIllustrationId,
  ): void {
    if (!this.devices.has(deviceId)) throw new EngineError('PLC не найден', 404);
    if (illustrationId !== undefined && !isDeviceIllustrationId(illustrationId))
      throw new EngineError('Выберите изображение устройства из каталога', 400);
    const cleanName = name.trim(),
      cleanRoom = room.trim();
    if (!text(cleanName, 128) || !cleanName || !text(cleanRoom, 128))
      throw new EngineError('Проверьте название и помещение', 400);
    const selected = illustrationId ?? this.labels[deviceId]?.illustrationId;
    const labels = {
      ...this.labels,
      [deviceId]: {
        name: cleanName,
        room: cleanRoom,
        ...(selected === undefined ? {} : { illustrationId: selected }),
      },
    };
    this.options.onLabelsChanged(labels);
    this.labels = labels;
  }

  /** @brief Send one explicit target, then resolve only from a matching PLC ACK or uncertainty. */
  async command(
    deviceId: string,
    kind: WritableControllerKind,
    itemId: string,
    value: boolean,
    budgetMs?: number,
    fence?: SecurityCommandFence,
  ): Promise<CommandView> {
    const timeoutMs =
      budgetMs === undefined
        ? this.options.commandTimeoutMs
        : Math.min(this.options.commandTimeoutMs, Math.floor(budgetMs));
    // Local ACK timers may be short; only an explicit upstream budget has the 250 ms dispatch floor.
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      (budgetMs !== undefined && (!Number.isFinite(budgetMs) || budgetMs < 250))
    )
      throw new EngineError('Срок команды истёк до отправки', 408);
    if (
      !identifier(deviceId, 104) ||
      !deviceId.startsWith(`${this.options.product.id}-`) ||
      !identifier(itemId, 32) ||
      typeof value !== 'boolean' ||
      !['sockets', 'lights', 'thermostats', 'security', 'tanks', 'irrigation'].includes(kind)
    )
      throw new EngineError('Некорректная команда', 400);
    const device = this.devices.get(deviceId);
    if (!device) throw new EngineError('PLC не найден', 404);
    const { view, module } = this.commandTarget(device, kind, itemId, value);
    const pendingKey = this.key(deviceId, kind);
    if (this.pending.has(pendingKey))
      throw new EngineError('Предыдущая команда ещё ожидает подтверждения');
    const heartbeat = device.heartbeat!;
    const leaseDeadline = this.commandLeaseDeadline(device, kind, fence);
    const bootId = heartbeat.data.bootId as string;
    const last = device.sequences.get(kind);
    const heartbeatSequence = heartbeat.data[sequenceFields[kind]] as number;
    if (!integer(heartbeatSequence, MAX_SEQUENCE))
      throw new EngineError('PLC ещё не передал счётчик команд этого модуля', 503);
    const statusSequence = module.data.commandSequence as number;
    const previous = Math.max(
      last?.bootId === bootId ? last.value : 0,
      heartbeatSequence,
      statusSequence,
    );
    if (previous >= MAX_SEQUENCE)
      throw new EngineError('Исчерпан счётчик команд; требуется перезапуск PLC');
    const sequence = previous + 1;
    // Heartbeat uptime has one-second quantization; using its lower bound expires conservatively.
    const at = this.now();
    const deadline =
      heartbeatUptime(heartbeat, at) +
      (budgetMs === undefined ? Math.min(this.options.commandTimeoutMs + 3000, 20_000) : timeoutMs);
    const packet: CommandPacket = {
      bootId,
      id: itemId,
      value,
      sequence,
      expiresAtUptimeMs: Math.min(deadline, leaseDeadline),
      ...(fence
        ? {
            hubEpoch: fence.hubEpoch,
            modeRevision: fence.modeRevision,
            leaseSequence: fence.leaseSequence,
          }
        : {}),
    };
    const activity = this.options.activity;
    const context = activity?.context?.();
    const command: CommandView = {
      id: randomUUID(),
      deviceId,
      controller: kind,
      itemId,
      value,
      sequence,
      status: 'pending',
      createdAt: this.wallNow(),
      completedAt: null,
      error: null,
      deviceName: view.name,
      ...(context && { actor: { ...context.actor } }),
      ...(context?.sceneRunId && { sceneRunId: context.sceneRunId }),
    };
    device.sequences.set(kind, { bootId, value: sequence });
    this.history.unshift(command);
    this.history.splice(MAX_ACTIVITY_ENTRIES);
    const result = new Promise<CommandView>((resolve) => {
      const timer = setTimeout(
        () =>
          this.finish(
            pendingKey,
            'unknown',
            'PLC не подтвердил команду; проверьте фактическое состояние',
          ),
        timeoutMs,
      );
      this.pending.set(pendingKey, {
        view: command,
        bootId,
        deadline: at + timeoutMs,
        sent: false,
        resolve,
        timer,
      });
    });
    const pending = this.pending.get(pendingKey)!;
    const failed = () => {
      if (this.pending.get(pendingKey)?.view !== command) return;
      this.finish(
        pendingKey,
        'unknown',
        'Отправка не подтверждена; команда не будет повторена автоматически',
      );
    };
    const send = (remaining: number) => {
      pending.sent = true;
      try {
        // The ACK timer still bounds a transport write that never calls back.
        void this.transport
          .publish(
            `${this.options.product.id}/${deviceId}/controllers/${kind}/set`,
            JSON.stringify(packet),
            Math.ceil(remaining / 1000),
          )
          .catch(failed);
      } catch {
        failed();
      }
    };
    const started = activity?.commandStarted;
    if (!started) {
      send(timeoutMs);
    } else {
      const entry = structuredClone(command);
      const recorded = Promise.resolve().then(() => started(entry));
      pending.recorded = recorded;
      void recorded.then(
        () => {
          if (this.pending.get(pendingKey) !== pending) return;
          try {
            // A database wait can make the original command authorization or lease stale.
            const remaining = pending.deadline - this.now();
            if (remaining < (budgetMs === undefined ? 1 : 250))
              throw new EngineError('Срок ожидания истёк до отправки команды', 408);
            const current = this.commandTarget(device, kind, itemId, value);
            const latest = device.heartbeat!;
            const latestSequence = latest.data[sequenceFields[kind]];
            if (
              latest.data.bootId !== bootId ||
              !integer(latestSequence, MAX_SEQUENCE) ||
              latestSequence >= sequence ||
              (current.module.data.commandSequence as number) >= sequence
            )
              throw new EngineError('Состояние PLC изменилось до отправки команды');
            this.commandLeaseDeadline(device, kind, fence);
            const uptime = fence ? this.deviceUptime(device) : heartbeatUptime(latest, this.now());
            if (uptime >= packet.expiresAtUptimeMs)
              throw new EngineError('Срок команды истёк до отправки', 408);
            send(remaining);
          } catch (error) {
            this.finish(
              pendingKey,
              'rejected',
              error instanceof EngineError ? error.message : 'Команда не отправлена',
            );
          }
        },
        () => {
          if (this.pending.get(pendingKey) === pending)
            this.finish(
              pendingKey,
              'rejected',
              'Не удалось записать команду в журнал. Команда не отправлена',
            );
        },
      );
    }
    return result;
  }

  private commandTarget(
    device: Device,
    kind: WritableControllerKind,
    itemId: string,
    value: boolean,
  ) {
    const view = this.deviceView(device);
    const module = view.controllers[kind];
    if (!view.online || !module?.fresh)
      throw new EngineError('Нет свежих данных PLC; команда не отправлена', 503);
    if (module.data.enabled !== true && !(kind === 'security' && !value))
      throw new EngineError('Модуль выключен');
    if (kind === 'security') {
      if (itemId !== 'alarm') throw new EngineError('Неизвестная команда охраны', 400);
      if (value && module.data.readyToArm !== true)
        throw new EngineError(
          text(module.data.armBlockReason, 512)
            ? module.data.armBlockReason
            : 'Охрана ещё не готова к постановке',
        );
    } else {
      const item = (module.data.items as Record<string, unknown>[]).find(
        (item) => item.id === itemId,
      );
      if (!item) throw new EngineError('Канал не найден', 404);
      if (
        value &&
        !['thermostats', 'tanks', 'irrigation'].includes(kind) &&
        item.available !== true
      )
        throw new EngineError('Канал недоступен');
    }
    return { view, module };
  }

  private commandLeaseDeadline(
    device: Device,
    kind: WritableControllerKind,
    fence?: SecurityCommandFence,
  ): number {
    if (fence === undefined) return Number.MAX_SAFE_INTEGER;
    if (kind !== 'security' || !isSecurityCommandFence(fence))
      throw new EngineError('Некорректный барьер команды охраны', 400);
    const rows = this.securityLeases.get(device.id);
    const issued = rows?.find(
      (row) =>
        row.packet.leaseSequence === fence.leaseSequence && row.packet.hubEpoch === fence.hubEpoch,
    );
    const latest = rows?.at(-1);
    if (
      !issued ||
      !latest ||
      issued.epoch !== this.epoch ||
      issued.packet.bootId !== device.heartbeat?.data.bootId ||
      fence.modeRevision !== issued.packet.modeRevision ||
      fence.hubEpoch !== latest.packet.hubEpoch ||
      fence.modeRevision !== latest.packet.modeRevision ||
      fence.leaseSequence !== latest.packet.leaseSequence ||
      this.now() - issued.at >= SECURITY_LEASE_MS ||
      issued.packet.expiresAtUptimeMs - this.deviceUptime(device) < 250
    )
      throw new EngineError('Сессия команды охраны устарела', 409);
    return issued.packet.expiresAtUptimeMs;
  }

  /** @brief Stop all outstanding waits without claiming that physical actions were undone. */
  close(): void {
    this.finishAll('Хаб остановлен; результат команды неизвестен');
    this.setConnection(false);
  }

  async flushActivity(): Promise<void> {
    await Promise.all(this.activityWrites);
  }

  private device(id: string): Device | undefined {
    let device = this.devices.get(id);
    if (!device && this.devices.size < MAX_DEVICES) {
      device = {
        id,
        controllers: new Map(),
        availability: 'unknown',
        retiredBoots: new Set(),
        sequences: new Map(),
        securityLeaseSequence: 0,
        connectionGeneration: 1,
      };
      this.devices.set(id, device);
    }
    return device;
  }

  private heartbeat(id: string, data: Record<string, unknown>, retained: boolean): void {
    if (
      data.deviceId !== id ||
      data.product !== this.options.product.name ||
      data.schemaVersion !== 1 ||
      !identifier(data.bootId, 96) ||
      !integer(data.sequence, MAX_SEQUENCE) ||
      data.sequence < 1 ||
      !integer(data.uptimeSec, Math.floor((Number.MAX_SAFE_INTEGER - 60_000) / 1000)) ||
      !text(data.boardId, 64) ||
      !text(data.firmwareVersion, 64)
    )
      return;
    for (const [kind, key] of Object.entries(sequenceFields)) {
      if ((kind === 'tanks' || kind === 'irrigation') && data[key] === undefined) continue; // Optional modules on older firmware.
      if (!integer(data[key], MAX_SEQUENCE)) return;
    }
    const device = this.device(id);
    if (!device || device.retiredBoots.has(data.bootId)) return;
    const previous = device.heartbeat;
    // Reconnect caches must not lower the last observed heartbeat high-water mark.
    if (retained && previous) return;
    if (
      previous?.data.bootId === data.bootId &&
      !retained &&
      ((data.sequence as number) <= (previous.data.sequence as number) ||
        (data.uptimeSec as number) < (previous.data.uptimeSec as number))
    )
      return;
    const at = this.now();
    if (!retained) this.checkHeartbeatTimeout(device, at);
    if (previous && previous.data.bootId !== data.bootId) {
      if (!retained) {
        device.retiredBoots.add(previous.data.bootId as string);
        if (device.retiredBoots.size > 64)
          device.retiredBoots.delete(device.retiredBoots.values().next().value!);
      }
      device.sequences.clear();
      this.securityLeases.delete(id);
      device.securityEvent = undefined;
      for (const observation of device.controllers.values())
        if (observation.data.bootId !== data.bootId) observation.live = false;
      this.finishDevice(id, 'PLC перезапущен; результат предыдущей команды неизвестен');
    }
    if (!retained && device.availability === 'offline') device.connectionGeneration++;
    device.heartbeat = {
      data,
      at,
      wall: this.wallNow(),
      live: !retained,
      epoch: this.epoch,
    };
    if (!retained) {
      device.availability = 'online';
      this.recoverOutage(id);
    }
  }

  private controller(
    id: string,
    kind: ControllerKind,
    data: Record<string, unknown>,
    retained: boolean,
  ): void {
    if (
      !identifier(data.bootId, 96) ||
      !integer(data.uptimeMs) ||
      typeof data.enabled !== 'boolean' ||
      !Array.isArray(data.items) ||
      data.items.length > 16 ||
      data.items.some(
        (item) => !object(item) || !identifier(item.id, 32) || !text(item.name, 128),
      ) ||
      (kind !== 'meteo' && !integer(data.commandSequence, MAX_SEQUENCE))
    )
      return;
    if (kind === 'tanks' && data.items.some((item) => !validTankTelemetry(item))) return;
    if (kind === 'irrigation' && data.items.some((item) => !validIrrigationTelemetry(item))) return;
    const device = this.device(id);
    if (!device || device.retiredBoots.has(data.bootId)) return;
    const previous = device.controllers.get(kind);
    if (retained && previous) return;
    if (
      previous?.data.bootId === data.bootId &&
      (data.uptimeMs as number) < (previous.data.uptimeMs as number)
    )
      return;
    const observation = {
      data: publicData(data),
      at: this.now(),
      wall: this.wallNow(),
      live: !retained,
      epoch: this.epoch,
    };
    device.controllers.set(kind, observation);
    if (
      this.options.onMeteo &&
      kind === 'meteo' &&
      !retained &&
      data.enabled &&
      this.liveHeartbeat(device, observation.at)?.data.bootId === data.bootId
    )
      this.options.onMeteo(id, observation.data, observation.wall);
  }

  private acknowledge(
    id: string,
    kind: WritableControllerKind,
    data: Record<string, unknown>,
    retained: boolean,
  ): void {
    if (retained) return;
    const key = this.key(id, kind),
      pending = this.pending.get(key);
    if (
      !pending?.sent ||
      data.bootId !== pending.bootId ||
      data.sequence !== pending.view.sequence ||
      data.id !== pending.view.itemId ||
      data.value !== pending.view.value ||
      typeof data.ok !== 'boolean' ||
      (data.error !== undefined && !text(data.error, 1024))
    )
      return;
    this.finish(
      key,
      data.ok ? 'applied' : 'rejected',
      data.ok ? null : (data.error as string) || 'PLC отклонил команду',
    );
  }

  private deviceView(device: Device): DeviceView {
    const heartbeat = device.heartbeat;
    const at = this.now();
    const live = Boolean(this.liveHeartbeat(device, at));
    const controllers: Partial<Record<ControllerKind, ControllerView>> = {};
    for (const [kind, observation] of device.controllers) {
      controllers[kind] = {
        kind,
        receivedAt: observation.wall,
        fresh:
          live &&
          observation.live &&
          observation.epoch === this.epoch &&
          observation.data.bootId === heartbeat?.data.bootId &&
          this.now() - observation.at <= this.options.staleAfterMs,
        data: structuredClone(observation.data),
      };
      if (kind === 'irrigation') {
        const rows = controllers[kind]!.data.items as Record<string, unknown>[];
        for (const row of rows) {
          const reference = remoteTankReference(row.tankId);
          if (!reference) continue;
          const source = this.devices.get(reference.deviceId);
          const item =
            source && this.waterSources(source, at).find(({ id }) => id === reference.tankId);
          row.tankSourceLabel = `${this.labels[reference.deviceId]?.name || reference.deviceId} · ${item?.name || reference.tankId}`;
        }
      }
    }
    const label = this.labels[device.id];
    return {
      id: device.id,
      name: label?.name || device.id,
      room: label?.room || '',
      illustrationId: isDeviceIllustrationId(label?.illustrationId)
        ? label.illustrationId
        : DEFAULT_DEVICE_ILLUSTRATION,
      boardId: String(heartbeat?.data.boardId || ''),
      firmwareVersion: String(heartbeat?.data.firmwareVersion || ''),
      bootId: heartbeat ? String(heartbeat.data.bootId) : null,
      status: live
        ? 'online'
        : device.availability === 'offline'
          ? 'offline'
          : heartbeat
            ? 'stale'
            : 'unknown',
      online: live,
      connectionGeneration: device.connectionGeneration,
      lastSeenAt: heartbeat?.live ? heartbeat.wall : null,
      uptimeSec: heartbeat
        ? (heartbeat.data.uptimeSec as number) +
          (live ? Math.floor((this.now() - heartbeat.at) / 1000) : 0)
        : null,
      controllers,
      management: {
        version: integer(heartbeat?.data.managementVersion, 255)
          ? (heartbeat!.data.managementVersion as number)
          : 0,
        supported:
          heartbeat?.data.managementVersion === 1 &&
          integer(heartbeat.data.managementSequence, MAX_SEQUENCE),
        sequence: integer(heartbeat?.data.managementSequence, MAX_SEQUENCE)
          ? (heartbeat!.data.managementSequence as number)
          : 0,
        busy: false,
      },
    };
  }

  private key(id: string, kind: WritableControllerKind): string {
    return `${id}/${kind}`;
  }

  private finish(
    key: string,
    status: 'applied' | 'rejected' | 'unknown',
    error: string | null,
  ): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    const interruptedBeforeSend = !pending.sent && status === 'unknown';
    pending.view.status = interruptedBeforeSend ? 'rejected' : status;
    pending.view.error = interruptedBeforeSend ? 'Команда не отправлена' : error;
    pending.view.completedAt = this.wallNow();
    const result = structuredClone(pending.view);
    const finished = this.options.activity?.commandFinished;
    if (!finished) {
      pending.resolve(result);
      return;
    }
    const recorded = pending.recorded ?? Promise.resolve();
    const write = recorded
      .catch(() => {})
      .then(() => finished(result))
      .catch(() => {});
    this.activityWrites.add(write);
    void write.then(() => this.activityWrites.delete(write));
    // Report a PLC acknowledgement promptly even if the database stalls after dispatch.
    const remaining = pending.deadline - this.now();
    if (!pending.sent || status === 'unknown' || remaining <= 0) {
      pending.resolve(result);
      return;
    }
    const report = setTimeout(() => pending.resolve(result), remaining);
    void write.then(() => {
      clearTimeout(report);
      pending.resolve(result);
    });
  }

  private finishDevice(id: string, error: string): void {
    for (const [key, pending] of this.pending)
      if (pending.view.deviceId === id) this.finish(key, 'unknown', error);
  }

  private finishAll(error: string): void {
    for (const key of this.pending.keys()) this.finish(key, 'unknown', error);
  }
}
