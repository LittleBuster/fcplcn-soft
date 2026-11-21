/** @file Bounded MQTT registry, freshness checks and confirmed command correlation. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_DEVICE_ILLUSTRATION,
  isDeviceIllustrationId,
  type DeviceIllustrationId,
} from '../../shared/device-art.js';
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
const MAX_MESSAGE_BYTES = 65_536;
const MAX_SEQUENCE = 0xffff_ffff;
const reservedKeys = new Set(['__proto__', 'prototype', 'constructor']);
const sequenceFields: Record<WritableControllerKind, string> = {
  sockets: 'socketCommandSequence',
  lights: 'lightCommandSequence',
  thermostats: 'thermostatCommandSequence',
  security: 'securityCommandSequence',
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
  private readonly history: CommandView[] = [];
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
        this.securityLeases.delete(id);
        if (device.heartbeat) device.heartbeat.live = false;
        for (const observation of device.controllers.values()) observation.live = false;
        this.finishDevice(id, 'PLC отключён; результат команды неизвестен');
      }
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

  /** @brief Return detached display values, always recalculating freshness from monotonic time. */
  snapshot(): EngineSnapshot {
    return {
      broker: { connected: this.connected, error: this.brokerError },
      devices: [...this.devices.values()]
        .map((device) => this.deviceView(device))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      commands: structuredClone(this.history),
    };
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
      (heartbeat.data.uptimeSec as number) * 1000 + Math.floor(at - heartbeat.at),
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
      !['sockets', 'lights', 'thermostats', 'security'].includes(kind)
    )
      throw new EngineError('Некорректная команда', 400);
    const device = this.devices.get(deviceId);
    if (!device) throw new EngineError('PLC не найден', 404);
    const view = this.deviceView(device);
    const module = view.controllers[kind];
    if (!this.connected || !view.online || !module?.fresh)
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
      if (value && kind !== 'thermostats' && item.available !== true)
        throw new EngineError('Канал недоступен');
    }
    const pendingKey = this.key(deviceId, kind);
    if (this.pending.has(pendingKey))
      throw new EngineError('Предыдущая команда ещё ожидает подтверждения');
    const heartbeat = device.heartbeat!;
    let leaseDeadline = Number.MAX_SAFE_INTEGER;
    if (fence !== undefined) {
      if (kind !== 'security' || !isSecurityCommandFence(fence))
        throw new EngineError('Некорректный барьер команды охраны', 400);
      const rows = this.securityLeases.get(deviceId),
        issued = rows?.find(
          (row) =>
            row.packet.leaseSequence === fence.leaseSequence &&
            row.packet.hubEpoch === fence.hubEpoch,
        ),
        latest = rows?.at(-1);
      if (
        !issued ||
        !latest ||
        issued.epoch !== this.epoch ||
        issued.packet.bootId !== view.bootId ||
        fence.modeRevision !== issued.packet.modeRevision ||
        fence.hubEpoch !== latest.packet.hubEpoch ||
        fence.modeRevision !== latest.packet.modeRevision ||
        fence.leaseSequence !== latest.packet.leaseSequence ||
        this.now() - issued.at >= SECURITY_LEASE_MS ||
        issued.packet.expiresAtUptimeMs - this.deviceUptime(device) < 250
      )
        throw new EngineError('Сессия команды охраны устарела', 409);
      leaseDeadline = issued.packet.expiresAtUptimeMs;
    }
    const bootId = heartbeat.data.bootId as string;
    const last = device.sequences.get(kind);
    const heartbeatSequence = heartbeat.data[sequenceFields[kind]] as number;
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
    const deadline =
      (heartbeat.data.uptimeSec as number) * 1000 +
      Math.floor(this.now() - heartbeat.at) +
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
    };
    device.sequences.set(kind, { bootId, value: sequence });
    this.history.unshift(command);
    this.history.splice(100);
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
      this.pending.set(pendingKey, { view: command, bootId, resolve, timer });
    });
    const failed = () => {
      if (this.pending.get(pendingKey)?.view !== command) return;
      this.finish(
        pendingKey,
        'unknown',
        'Отправка не подтверждена; команда не будет повторена автоматически',
      );
    };
    try {
      // Completion is bounded by our ACK timer even if a transport write never calls back.
      void this.transport
        .publish(
          `${this.options.product.id}/${deviceId}/controllers/${kind}/set`,
          JSON.stringify(packet),
          Math.ceil(timeoutMs / 1000),
        )
        .catch(failed);
    } catch {
      failed();
    }
    return result;
  }

  /** @brief Stop all outstanding waits without claiming that physical actions were undone. */
  close(): void {
    this.finishAll('Хаб остановлен; результат команды неизвестен');
    this.setConnection(false);
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
    for (const key of Object.values(sequenceFields)) if (!integer(data[key], MAX_SEQUENCE)) return;
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
      at: this.now(),
      wall: this.wallNow(),
      live: !retained,
      epoch: this.epoch,
    };
    if (!retained) device.availability = 'online';
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
    const device = this.device(id);
    if (!device || device.retiredBoots.has(data.bootId)) return;
    const previous = device.controllers.get(kind);
    if (retained && previous) return;
    if (
      previous?.data.bootId === data.bootId &&
      (data.uptimeMs as number) < (previous.data.uptimeMs as number)
    )
      return;
    device.controllers.set(kind, {
      data: publicData(data),
      at: this.now(),
      wall: this.wallNow(),
      live: !retained,
      epoch: this.epoch,
    });
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
      !pending ||
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
    const live = Boolean(
      this.connected &&
      heartbeat?.live &&
      heartbeat.epoch === this.epoch &&
      this.now() - heartbeat.at <= this.options.staleAfterMs &&
      device.availability !== 'offline',
    );
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
    pending.view.status = status;
    pending.view.error = error;
    pending.view.completedAt = this.wallNow();
    pending.resolve(structuredClone(pending.view));
  }

  private finishDevice(id: string, error: string): void {
    for (const [key, pending] of this.pending)
      if (pending.view.deviceId === id) this.finish(key, 'unknown', error);
  }

  private finishAll(error: string): void {
    for (const key of this.pending.keys()) this.finish(key, 'unknown', error);
  }
}
