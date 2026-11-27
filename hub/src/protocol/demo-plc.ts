/** @file Adapt the tested PLC web-service model to a private, demo-only management transport. */
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { ControllerKind, ManagementReply, ManagementRequest } from '../../shared/types.js';
import { controllerKinds } from '../../shared/types.js';
import type { CommandPacket } from './registry.js';
import type { DemoPreset } from './demo-presets.js';
import {
  isSecurityLeasePacket,
  type SecurityLeasePacket,
  type SecurityTouchPacket,
} from '../../shared/security-sync.js';

type Data = Record<string, unknown>;
type Result = Pick<ManagementReply, 'status' | 'data'>;
interface ModuleData extends Data {
  enabled: boolean;
  revision: number;
  items: Data[];
}
interface Fixture {
  server: Server;
  config: Data & { revision: number; device: { name: string }; hardware: { boardId: string } };
  activeBoardId: string;
  controllers: {
    snapshot(): Record<ControllerKind, ModuleData>;
    exportSettings(): Record<ControllerKind, Data>;
    irrigationWaterSource(): { id: string; name: string; water: boolean | null }[];
    setRemoteIrrigationTanks(
      rows: { id: string; name: string; deviceName: string; waterAvailable: boolean | null }[],
      ttlMs: number,
    ): void;
    modules: Record<
      ControllerKind,
      {
        state?(body: Data): Promise<Result>;
        enabled?(body: Data): Promise<Result>;
        armed?(body: Data): Promise<Result>;
      }
    >;
    advanceSecurityTime(milliseconds: number): void;
    simulateIbutton(body: Data): Promise<unknown>;
    simulateTankLevel(body: Data): Promise<unknown>;
    setSecurityTouchHandlers(handlers: {
      decide(key: Data): { value: boolean; busy: boolean } | undefined;
      observed(event: {
        keyId: string;
        keyName: string;
        value: boolean;
        busy: boolean;
        localApplied: boolean;
      }): void;
    }): void;
    close(): void;
  };
  hardware: { setInputLevel(id: string, level: boolean): void };
  firmware: { snapshot(): { version: string; imageId: string; runningPartition: string } };
  setMeteoTemperature(id: string, value: number): void;
}
const require = createRequire(import.meta.url);
const fixturePath = new URL('../../firmware/base/tests/browser/ui_test.cjs', import.meta.url);
const { createMock } = require(fileURLToPath(fixturePath)) as {
  createMock(options: Data): Fixture;
};
export const { demoRoms } = require(
  fileURLToPath(new URL('../../firmware/base/tests/browser/meteo_mock.cjs', import.meta.url)),
) as { demoRoms(port: string): string[] };
export const { demoKeys } = require(
  fileURLToPath(new URL('../../firmware/base/tests/browser/security_mock.cjs', import.meta.url)),
) as { demoKeys: string[] };
const clone = <T>(value: T): T => structuredClone(value);
const methods = new Set(['GET', 'POST']);
const route =
  /^\/(?:status|config(?:\/(?:backup|restore))?|controllers(?:\/(?:sockets|lights|meteo|thermostats|security|tanks|irrigation)(?:\/(?:state|enabled|armed|scan))?)?|hardware(?:\/(?:scan|relay))?|firmware(?:\/(?:begin|chunk|finish|abort))?|board-profiles|user|time|reboot)$/;

/** @brief Own a single virtual PLC; management, automation and telemetry share these exact models. */
export class DemoPLC {
  readonly fixture: Fixture;
  readonly sequences = {
    sockets: 0,
    lights: 0,
    thermostats: 0,
    security: 0,
    tanks: 0,
    irrigation: 0,
  };
  managementSequence = 0;
  heartbeatSequence = 0;
  bootId: string;
  private began = performance.now();
  private baseUptime = 120_000;
  private readonly token = randomBytes(32).toString('hex');
  private readonly file: string;
  private listening: Promise<string> | null = null;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest: { signature: string; response: Result } | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly exposed = new Set<ControllerKind>();
  private securityLease: SecurityLeasePacket | null = null;
  private readonly retiredSecurityEpochs = new Set<string>();
  private securityEventSequence = 0;
  private lastSecurityTouch: Data | null = null;

  constructor(
    readonly preset: DemoPreset,
    directory: string,
    private readonly changed: () => void,
    private readonly securityEvent: (event: SecurityTouchPacket) => void = () => {},
  ) {
    // A recreated demo PLC is a new boot even within the same engine instance.
    // Reusing a retired boot ID would correctly be rejected as stale telemetry.
    this.bootId = preset.bootId + '-' + randomBytes(6).toString('hex');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'config.json');
    let stored: { backup: Data; revision: number; firmware?: Data } | undefined;
    if (existsSync(this.file)) {
      const bytes = readFileSync(this.file);
      if (bytes.length > 131_072) throw new Error('Слишком большой конфиг виртуального PLC');
      stored = JSON.parse(bytes.toString('utf8')) as typeof stored;
      if (!stored || !stored.backup || !Number.isSafeInteger(stored.revision))
        throw new Error('Некорректный конфиг виртуального PLC');
    }
    const controllerFile = join(directory, 'controllers.json');
    const seeded = !existsSync(controllerFile);
    if (seeded) {
      const settings = stored?.backup.controllers as Record<ControllerKind, Data> | undefined;
      const controllers = settings
        ? {
            irrigation: { revision: 1, enabled: false, items: [] },
            tanks: { revision: 1, enabled: false, items: [] },
            ...Object.fromEntries(
              Object.entries(settings).map(([kind, data]) => [kind, { revision: 1, ...data }]),
            ),
          }
        : preset.controllers;
      writeFileSync(
        controllerFile,
        JSON.stringify({ version: 10, boardId: 'fcplcn-161608-1v0', controllers }),
        { mode: 0o600, flag: 'wx' },
      );
    }
    this.fixture = createMock({
      interactive: true,
      statePath: controllerFile,
      deviceId: preset.id,
      mac:
        'AA:BB:CC:11:22:' +
        (preset.id.endsWith('living') ? '31' : preset.id.endsWith('utility') ? '32' : '33'),
      managementToken: this.token,
      initialBackup: stored?.backup,
      initialFirmware: stored?.firmware,
    });
    this.fixture.controllers.setSecurityTouchHandlers({
      decide: () => {
        const lease = this.freshSecurityLease();
        return lease ? { value: lease.touchArmed, busy: lease.busy } : undefined;
      },
      observed: (event) => {
        const lease = this.freshSecurityLease();
        const sequence = ++this.securityEventSequence;
        this.lastSecurityTouch = {
          accepted: Boolean(lease && !event.busy),
          ignored: event.busy,
          localApplied: event.localApplied,
          value: event.value,
          keyName: event.keyName,
          eventId: `${this.preset.id}:${this.bootId}:${sequence}`,
        };
        if (lease)
          this.securityEvent({
            schemaVersion: 1,
            bootId: this.bootId,
            hubEpoch: lease.hubEpoch,
            modeRevision: lease.modeRevision,
            leaseSequence: lease.leaseSequence,
            eventSequence: sequence,
            eventAtUptimeMs: this.uptimeMs(),
            value: event.value,
            keyId: event.keyId,
            keyName: event.keyName,
            localApplied: event.localApplied,
          });
      },
    });
    if (stored) this.fixture.config.revision = stored.revision;
    else this.fixture.config.device.name = preset.name;
    for (const [id, temperature] of Object.entries(preset.temperatures))
      this.fixture.setMeteoTemperature(id, temperature);
    if (seeded && preset.controllers.tanks?.enabled) {
      void this.fixture.controllers.simulateTankLevel({ id: 'tank-water', wet: [true, false] });
    }
    if (seeded && preset.alarm) {
      this.fixture.hardware.setInputLevel('in-0/1', true);
      for (let i = 0; i < 3; i++) this.fixture.controllers.advanceSecurityTime(25);
    }
  }

  uptimeMs(): number {
    return this.baseUptime + Math.floor(performance.now() - this.began);
  }
  boardId(): string {
    return this.fixture.activeBoardId;
  }

  /** Accept exactly the short authority that a real PLC would hold in RAM. */
  receiveSecurityLease(value: unknown): void {
    if (
      !isSecurityLeasePacket(value) ||
      value.bootId !== this.bootId ||
      value.expiresAtUptimeMs <= this.uptimeMs() ||
      value.expiresAtUptimeMs > this.uptimeMs() + 5000
    )
      return;
    if (
      this.retiredSecurityEpochs.has(value.hubEpoch) ||
      (this.securityLease && value.modeRevision < this.securityLease.modeRevision)
    )
      return;
    if (
      this.securityLease?.hubEpoch === value.hubEpoch &&
      value.leaseSequence <= this.securityLease.leaseSequence
    )
      return;
    if (this.securityLease && this.securityLease.hubEpoch !== value.hubEpoch) {
      this.retiredSecurityEpochs.add(this.securityLease.hubEpoch);
      if (this.retiredSecurityEpochs.size > 32)
        this.retiredSecurityEpochs.delete(this.retiredSecurityEpochs.values().next().value!);
    }
    this.securityLease = clone(value);
  }

  private freshSecurityLease(): SecurityLeasePacket | null {
    return this.securityLease?.bootId === this.bootId &&
      this.securityLease.expiresAtUptimeMs > this.uptimeMs()
      ? this.securityLease
      : null;
  }

  /** A single physical press contains several samples and a release; the source latch emits only once. */
  securityTouch(keyId?: string): Promise<Result> {
    const operation = this.queue.then(async () => {
      if (this.stopped) return { status: 503, data: { error: 'Виртуальный PLC недоступен' } };
      const config = this.fixture.controllers.exportSettings().security;
      const keys = Array.isArray(config.keys) ? (config.keys as Data[]) : [];
      const key = keyId === undefined ? keys[0] : keys.find((row) => row.id === keyId);
      if (!config.enabled || !config.readerPortId || !key)
        return { status: 409, data: { error: 'Настройте считыватель и разрешённый ключ iButton' } };
      this.lastSecurityTouch = null;
      await this.fixture.controllers.simulateIbutton({ address: key.address, present: true });
      for (let sample = 0; sample < 5; sample++) this.fixture.controllers.advanceSecurityTime(100);
      await this.fixture.controllers.simulateIbutton({ present: false });
      for (let sample = 0; sample < 3; sample++) this.fixture.controllers.advanceSecurityTime(100);
      const result = this.lastSecurityTouch as Data | null;
      if (!result) return { status: 409, data: { error: 'Касание не принято считывателем' } };
      if (result.localApplied) {
        this.normalContacts();
        await this.persist();
      }
      this.changed();
      return { status: 200, data: result };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  /** Advertise irrigation support before the first rule so the dashboard can open its editor. */
  snapshots(): Partial<Record<ControllerKind, ModuleData>> {
    const snapshot = this.fixture.controllers.snapshot();
    const result: Partial<Record<ControllerKind, ModuleData>> = {};
    for (const kind of controllerKinds) {
      const data = snapshot[kind];
      if (!data) continue;
      if (kind === 'irrigation' || data.enabled || data.items.length || this.exposed.has(kind)) {
        this.exposed.add(kind);
        const clean = clone(data);
        if (kind === 'security') {
          clean.keyCount = Array.isArray(clean.keys) ? clean.keys.length : 0;
          delete clean.keys;
          const lease = this.freshSecurityLease();
          clean.hubSync = {
            version: 1,
            connected: Boolean(lease),
            busy: lease?.busy ?? false,
            modeRevision: this.securityLease?.modeRevision ?? 0,
            queuedEvents: 0,
          };
        }
        result[kind] = clean;
      }
    }
    return result;
  }

  /** Run explicit SET through the fixture's shared resource and durability validators. */
  async command(kind: ControllerKind, packet: CommandPacket): Promise<Result> {
    if (this.stopped) throw new Error('Demo stopped');
    if (packet.bootId !== this.bootId || packet.expiresAtUptimeMs <= this.uptimeMs())
      return { status: 409, data: { error: 'Команда устарела' } };
    if (
      kind === 'security' &&
      ('hubEpoch' in packet || 'modeRevision' in packet || 'leaseSequence' in packet)
    ) {
      const lease = this.freshSecurityLease();
      if (
        !lease ||
        packet.hubEpoch !== lease.hubEpoch ||
        packet.modeRevision !== lease.modeRevision ||
        packet.leaseSequence !== lease.leaseSequence
      )
        return { status: 409, data: { error: 'Сессия охраны устарела' } };
    }
    const module = this.fixture.controllers.modules[kind];
    const result =
      kind === 'security'
        ? await module.armed!({ value: packet.value })
        : kind === 'thermostats' || kind === 'tanks' || kind === 'irrigation'
          ? await module.enabled!({ id: packet.id, value: packet.value })
          : await module.state!({ id: packet.id, value: packet.value });
    if (result.status === 200) {
      if (kind === 'security') this.normalContacts();
      await this.persist();
    }
    return result;
  }

  /** Validate the private correlation envelope before forwarding a bounded service operation. */
  service(request: ManagementRequest): Promise<Result> {
    const operation = this.queue.then(async () => {
      const failed = (status: number, error: string): Result => ({ status, data: { error } });
      if (this.stopped) return failed(503, 'Виртуальный PLC остановлен');
      if (request.schemaVersion !== 1 || !methods.has(request.method) || !route.test(request.path))
        return failed(400, 'Неизвестный сервисный запрос');
      if (request.bootId !== this.bootId) return failed(409, 'PLC перезапущен');
      if (!Number.isSafeInteger(request.sequence) || request.sequence < 1)
        return failed(400, 'Некорректная последовательность запроса');
      const signature = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      if (request.sequence === this.managementSequence && this.lastRequest?.signature === signature)
        return clone(this.lastRequest.response);
      if (request.sequence <= this.managementSequence)
        return failed(409, 'Устаревший сервисный запрос');
      if (
        !Number.isSafeInteger(request.expiresAtUptimeMs) ||
        request.expiresAtUptimeMs <= this.uptimeMs() ||
        request.expiresAtUptimeMs > this.uptimeMs() + 60_000
      )
        return failed(408, 'Срок сервисного запроса истёк');
      this.managementSequence = request.sequence;
      let result: Result;
      try {
        result = await this.fetch(
          request.path,
          request.method,
          request.body,
          request.expiresAtUptimeMs,
        );
        if (
          result.status === 200 &&
          request.method === 'POST' &&
          request.path === '/controllers/security/scan'
        ) {
          await this.fixture.controllers.simulateIbutton({ address: demoKeys[0], present: true });
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (!this.stopped) void this.fixture.controllers.simulateIbutton({ present: false });
          }, 1500).unref();
          this.timers.add(timer);
        }
        if (result.status === 200 && request.method === 'POST') {
          if (request.path === '/controllers/security/armed') this.normalContacts();
          if (
            request.path === '/reboot' ||
            request.path === '/config/restore' ||
            request.path === '/firmware/finish'
          )
            this.scheduleReboot();
          else if (!request.path.startsWith('/firmware/')) await this.persist();
        }
        if (result.status === 200 && request.path === '/status' && !Array.isArray(result.data))
          result.data.uptimeSec = Math.floor(this.uptimeMs() / 1000);
      } catch (error) {
        result = failed(
          503,
          error instanceof Error ? error.message : 'Сервис виртуального PLC недоступен',
        );
      }
      this.lastRequest = { signature, response: clone(result) };
      if (!this.stopped) this.changed();
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  /** Release the virtual contacts after a key/web action, matching the original demo interaction. */
  private normalContacts(): void {
    const security = this.fixture.controllers.snapshot().security;
    for (const item of security.items)
      this.fixture.hardware.setInputLevel(String(item.inputId), item.sensorType === 'motion');
    for (let i = 0; i < 3; i++) this.fixture.controllers.advanceSecurityTime(25);
  }

  private scheduleReboot(): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      this.bootId = this.preset.bootId + '-' + randomBytes(6).toString('hex');
      this.began = performance.now();
      this.baseUptime = 0;
      this.heartbeatSequence = 0;
      this.managementSequence = 0;
      this.lastRequest = null;
      this.securityLease = null;
      this.retiredSecurityEpochs.clear();
      this.securityEventSequence = 0;
      for (const kind of [
        'sockets',
        'lights',
        'thermostats',
        'security',
        'tanks',
        'irrigation',
      ] as const)
        this.sequences[kind] = 0;
      void this.persist()
        .then(() => {
          if (!this.stopped) this.changed();
        })
        .catch(() => {});
    }, 1200).unref();
    this.timers.add(timer);
  }

  /** Bind only loopback; this random-token HTTP transport is never reachable through the hub UI. */
  private listen(): Promise<string> {
    if (!this.listening)
      this.listening = new Promise((resolve, reject) => {
        this.fixture.server.once('error', reject);
        this.fixture.server.listen(0, '127.0.0.1', () => {
          this.fixture.server.off('error', reject);
          this.fixture.server.unref();
          const address = this.fixture.server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Виртуальный PLC не запущен'));
            return;
          }
          resolve('http://127.0.0.1:' + address.port);
        });
      });
    return this.listening;
  }

  private async fetch(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Data,
    deadline?: number,
  ): Promise<Result> {
    const base = await this.listen();
    if (this.stopped) throw new Error('Виртуальный PLC остановлен');
    const remaining = deadline === undefined ? 5000 : Math.min(5000, deadline - this.uptimeMs());
    if (remaining <= 0) throw new Error('Срок сервисного запроса истёк');
    const response = await fetch(base + '/api/v1' + path, {
      method,
      headers: { 'x-fcplcn-management-token': this.token, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
      signal: AbortSignal.timeout(remaining),
    });
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') throw new Error('Некорректный ответ виртуального PLC');
    return { status: response.status, data: data as ManagementReply['data'] };
  }

  /** Save the complete validated device settings/account, while frequent states keep their own file. */
  private async persist(): Promise<void> {
    const backup = await this.fetch('/config/backup');
    if (backup.status !== 200)
      throw new Error('Не удалось сохранить конфигурацию виртуального PLC');
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          version: 1,
          revision: this.fixture.config.revision,
          backup: backup.data,
          firmware: this.fixture.firmware.snapshot(),
        }),
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(temporary, this.file);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* Successful rename already removed it. */
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.fixture.server.closeAllConnections();
    if (this.fixture.server.listening)
      await new Promise<void>((resolve) => this.fixture.server.close(() => resolve()));
    else this.fixture.controllers.close();
  }
}
