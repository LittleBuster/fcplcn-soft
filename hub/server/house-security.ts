/** @file Durable whole-house intent; recovery applies current guard state without replaying scenes. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  CommandView,
  DeviceView,
  EngineSnapshot,
  HouseSecurityView,
  HubEngine,
  SceneRun,
} from '../shared/types.js';
import type { SecurityTouchEvent } from '../shared/security-sync.js';
import { Scenes } from './scenes.js';
import { withActivity } from './activity-context.js';

interface KnownDevice {
  deviceId: string;
  name: string;
  configured: boolean;
  enabled: boolean;
}
interface StoredHouse {
  version: 1;
  desiredArmed: boolean | null;
  revision: number;
  devices: KnownDevice[];
  consumed: string[];
  lastEvent: HouseSecurityView['lastEvent'];
  lastRunId: string | null;
}
interface Runtime {
  live: boolean;
  bootId: string | null;
  connectionGeneration: number | null;
  needs: boolean;
  reason: 'intent' | 'recovery' | 'observation';
  attempts: number;
  nextTry: number;
  waitSample: string | null;
  status: 'confirmed' | 'pending' | 'unknown' | 'rejected';
  error: string | null;
}
interface Options {
  directory?: string;
  isBusy?: () => boolean;
  runScene?: (id: 'home' | 'away', signal: AbortSignal) => SceneRun | Promise<SceneRun>;
  now?: () => number;
  pulseMs?: number;
  commandTimeoutMs?: number;
}
const MAX_DEVICES = 256,
  MAX_EVENTS = 1024,
  MAX_REVISION = 0xffff_ffff;
// A 4 s lease covers 1 s publish admission, 2.5 s ACK and a 250 ms watchdog margin.
const SECURITY_COMMAND_TIMEOUT_MS = 2500;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const failure = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
const readable = (value: unknown) =>
  (value instanceof Error ? value.message : 'Неизвестная ошибка')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 256);
const configured = (device: DeviceView) =>
  Array.isArray(device.controllers.security?.data.items) &&
  device.controllers.security!.data.items.length > 0;
const sample = (device: DeviceView) =>
  `${device.bootId}:${device.controllers.security?.receivedAt}:${device.controllers.security?.data.uptimeMs ?? ''}`;

/** One authority for physical keys, web/Telegram/cloud modes and scheduled home/away runs. */
export class HouseSecurity {
  readonly hubEpoch = randomUUID();
  private store: StoredHouse = {
    version: 1,
    desiredArmed: null,
    revision: 0,
    devices: [],
    consumed: [],
    lastEvent: null,
    lastRunId: null,
  };
  private readonly runtime = new Map<string, Runtime>();
  private readonly pending = new Map<string, Promise<CommandView>>();
  private readonly leaseReservations = new Set<string>();
  private readonly now: () => number;
  private readonly file?: string;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private storageError: string | null = null;
  private stopped = false;
  private readonly touchContext = new AsyncLocalStorage<{
    event: SecurityTouchEvent;
    expiresAt: number;
  }>();
  private readonly touchesStarting = new Set<string>();

  constructor(
    private readonly engine: HubEngine,
    private readonly scenes: Scenes,
    private readonly options: Options = {},
  ) {
    this.now = options.now || (() => performance.now());
    if (options.directory) {
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      this.file = join(options.directory, 'house-security.json');
      this.load();
    }
    scenes.setHouseSecurity({
      inventory: (snapshot) => this.inventory(snapshot),
      accept: (run) => this.accept(run),
      command: (deviceId, value) => this.synchronize(deviceId, value),
      singleCommand: (deviceId, value) => this.commandSingle(deviceId, value),
    });
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.unsubscribe = this.engine.onSecurityTouch?.((event) => this.touch(event));
    this.tick();
    this.timer = setInterval(() => this.tick(), this.options.pulseMs || 1000).unref();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  get busy(): boolean {
    return Boolean(
      this.storageError ||
      this.stopped ||
      this.pending.size ||
      this.leaseReservations.size ||
      this.scenes.snapshot().activeRun ||
      this.options.isBusy?.(),
    );
  }

  /** Every known PLC is retained, including one missing from the registry after hub restart. */
  inventory(snapshot = this.engine.snapshot()): DeviceView[] {
    this.observe(snapshot);
    return this.store.devices.map(
      (known) =>
        snapshot.devices.find((device) => device.id === known.deviceId) || {
          id: known.deviceId,
          name: known.name,
          room: '',
          boardId: '',
          firmwareVersion: '',
          bootId: null,
          status: 'offline',
          online: false,
          lastSeenAt: null,
          uptimeSec: null,
          controllers: known.configured
            ? {
                security: {
                  kind: 'security',
                  fresh: false,
                  receivedAt: '',
                  data: { enabled: known.enabled, items: [{}] },
                },
              }
            : {},
        },
    );
  }
  snapshot(): HouseSecurityView {
    const snapshot = this.engine.snapshot();
    this.observe(snapshot);
    return {
      desiredArmed: this.store.desiredArmed,
      revision: this.store.revision,
      busy: this.busy,
      error: this.storageError,
      lastEvent: this.store.lastEvent ? { ...this.store.lastEvent } : null,
      devices: this.store.devices.map((known) => {
        const device = snapshot.devices.find((row) => row.id === known.deviceId),
          state = this.runtime.get(known.deviceId);
        const module = device?.controllers.security;
        const online = Boolean(
          snapshot.broker.connected && device?.online && module?.fresh && device.bootId,
        );
        const actualArmed =
          online && typeof module!.data.armed === 'boolean' ? module!.data.armed : null;
        const status = !known.configured
          ? 'not-configured'
          : !known.enabled
            ? 'skipped'
            : !online
              ? 'offline'
              : this.pending.has(known.deviceId)
                ? 'pending'
                : this.store.desiredArmed === null
                  ? 'unknown'
                  : actualArmed === this.store.desiredArmed && !state?.needs
                    ? 'confirmed'
                    : state?.status === 'confirmed'
                      ? 'unknown'
                      : state?.status || 'unknown';
        return {
          ...known,
          online,
          actualArmed,
          phase: online && typeof module!.data.phase === 'string' ? module!.data.phase : null,
          remainingSeconds:
            online && typeof module!.data.remainingSeconds === 'number'
              ? module!.data.remainingSeconds
              : null,
          status,
          error: !known.configured
            ? 'Охрана не настроена'
            : !known.enabled
              ? 'Модуль охраны выключен'
              : !online
                ? 'Нет свежей связи с PLC'
                : state?.error || null,
        };
      }),
    };
  }
  /** Regular per-PLC commands remain local overrides and do not create a new whole-house mode. */
  async commandSingle(deviceId: string, value: boolean, timeoutMs?: number): Promise<CommandView> {
    if (!this.engine.sendSecurityLease)
      return this.engine.command(deviceId, 'security', 'alarm', value, timeoutMs);
    if (this.pending.has(deviceId) || this.leaseReservations.has(deviceId))
      throw failure('PLC уже ожидает подтверждения охраны');
    this.leaseReservations.add(deviceId);
    try {
      const fence = await this.engine.sendSecurityLease(deviceId, this.leaseInput());
      const result = await this.engine.command(
        deviceId,
        'security',
        'alarm',
        value,
        Math.min(timeoutMs ?? SECURITY_COMMAND_TIMEOUT_MS, SECURITY_COMMAND_TIMEOUT_MS),
        fence,
      );
      const runtime = this.runtime.get(deviceId);
      if (runtime && result.status === 'applied') {
        runtime.needs = false;
        runtime.error = null;
        runtime.status = 'unknown';
      }
      return result;
    } finally {
      this.leaseReservations.delete(deviceId);
    }
  }

  /** No queue: stale, duplicate and busy physical requests can never toggle the mode later. */
  private touch(event: SecurityTouchEvent): void {
    if (this.stopped || this.storageError || event.hubEpoch !== this.hubEpoch) return;
    const eventId = `${event.deviceId}:${event.bootId}:${event.eventSequence}`;
    if (this.store.consumed.includes(eventId) || this.touchesStarting.has(eventId)) return;
    const refuse = () => {
      // A refused operation is consumed, never put back on a queue after a lock/reconnect clears.
      if (!this.storageError && !this.store.consumed.includes(eventId))
        this.commit({
          ...this.store,
          consumed: [...this.store.consumed, eventId].slice(-MAX_EVENTS),
        });
      const state = this.runtime.get(event.deviceId);
      if (state && event.localApplied && this.store.desiredArmed !== null) {
        state.needs = true;
        state.reason = 'intent';
        state.attempts = 0;
        state.waitSample = null;
        state.nextTry = 0;
      }
    };
    if (event.modeRevision !== this.store.revision || this.busy) {
      refuse();
      return;
    }
    this.touchesStarting.add(eventId);
    const done = () => this.touchesStarting.delete(eventId);
    try {
      const runScene =
        this.options.runScene || ((id, signal) => this.scenes.startRun(id, 'manual', signal));
      const run = this.touchContext.run(
        { event, expiresAt: this.now() + SECURITY_COMMAND_TIMEOUT_MS },
        () =>
          withActivity(
            { actor: { source: 'key', name: event.keyName || event.deviceId, id: event.deviceId } },
            () =>
              runScene(
                event.value ? 'away' : 'home',
                AbortSignal.timeout(SECURITY_COMMAND_TIMEOUT_MS),
              ),
          ),
      );
      if (run instanceof Promise) void run.catch(refuse).finally(done);
      else done();
    } catch {
      refuse();
      done();
    }
  }
  private accept(run: SceneRun): void {
    if (this.storageError) throw failure(this.storageError, 503);
    if (this.stopped || this.pending.size || this.options.isBusy?.())
      throw failure('Охрана занята; повторите действие после завершения текущей операции');
    if (this.store.revision >= MAX_REVISION) throw failure('Исчерпан счётчик режимов охраны', 503);
    const touch = this.touchContext.getStore();
    const event = touch?.event,
      eventId = event ? `${event.deviceId}:${event.bootId}:${event.eventSequence}` : null;
    if (touch && this.now() >= touch.expiresAt) throw failure('Срок действия касания истёк', 408);
    if (
      event &&
      (event.modeRevision !== this.store.revision || this.store.consumed.includes(eventId!))
    )
      throw failure('Касание уже обработано или относится к прежнему режиму');
    const next: StoredHouse = {
      ...this.store,
      revision: this.store.revision + 1,
      desiredArmed: run.sceneId === 'away',
      lastRunId: run.id,
      consumed: eventId
        ? [...this.store.consumed, eventId].slice(-MAX_EVENTS)
        : this.store.consumed,
      lastEvent: event
        ? {
            eventId: eventId!,
            deviceId: event.deviceId,
            keyName: event.keyName,
            at: new Date().toISOString(),
            value: event.value,
          }
        : this.store.lastEvent,
    };
    if (!this.commit(next)) throw failure(this.storageError!, 503);
    for (const state of this.runtime.values()) {
      state.needs = true;
      state.reason = 'intent';
      state.attempts = 0;
      state.nextTry = 0;
      state.waitSample = null;
      state.error = null;
      state.status = 'pending';
    }
    queueMicrotask(() => this.tick());
  }
  private leaseInput() {
    const devices = this.engine
      .snapshot()
      .devices.filter((device) => device.controllers.security?.data.enabled === true);
    const eligible = this.store.devices.filter((known) => known.configured && known.enabled);
    const safeToArm =
      devices.length > 0 &&
      eligible.length > 0 &&
      eligible.every((known) => {
        const device = devices.find((row) => row.id === known.deviceId);
        return (
          device?.online &&
          device.controllers.security?.fresh &&
          device.controllers.security.data.armed === false
        );
      });
    return {
      hubEpoch: this.hubEpoch,
      modeRevision: this.store.revision,
      touchArmed: this.store.desiredArmed === null ? safeToArm : !this.store.desiredArmed,
      busy: this.busy,
    };
  }
  tick(): void {
    if (this.stopped) return;
    const snapshot = this.engine.snapshot();
    this.observe(snapshot);
    if (this.storageError) return;
    for (const device of snapshot.devices) {
      if (
        !snapshot.broker.connected ||
        !device.online ||
        !device.bootId ||
        !device.controllers.security?.fresh
      )
        continue;
      if (this.pending.has(device.id) || this.leaseReservations.has(device.id)) continue;
      void this.engine.sendSecurityLease?.(device.id, this.leaseInput()).catch(() => {});
    }
    if (
      this.storageError ||
      this.store.desiredArmed === null ||
      this.scenes.snapshot().activeRun ||
      this.options.isBusy?.()
    )
      return;
    for (const device of snapshot.devices) {
      const known = this.store.devices.find((row) => row.deviceId === device.id),
        state = this.runtime.get(device.id);
      if (
        !known?.configured ||
        !known.enabled ||
        !state?.live ||
        !state.needs ||
        this.pending.has(device.id)
      )
        continue;
      const currentSample = sample(device),
        actual = device.controllers.security!.data.armed;
      if (
        state.reason === 'observation' &&
        state.waitSample !== currentSample &&
        actual === this.store.desiredArmed
      ) {
        state.needs = false;
        state.status = 'confirmed';
        state.error = null;
        continue;
      }
      if (state.attempts >= 3 || state.nextTry > this.now() || state.waitSample === currentSample)
        continue;
      const armed = this.store.desiredArmed;
      void withActivity({ actor: { source: 'system', name: 'Синхронизация режима охраны' } }, () =>
        this.synchronize(device.id, armed),
      ).catch(() => {});
    }
  }
  private synchronize(deviceId: string, value: boolean): Promise<CommandView> {
    const pending = this.pending.get(deviceId);
    if (pending) return pending;
    const revision = this.store.revision,
      device = this.engine.snapshot().devices.find((row) => row.id === deviceId);
    if (
      this.stopped ||
      this.storageError ||
      value !== this.store.desiredArmed ||
      !device?.online ||
      !device.bootId ||
      !device.controllers.security?.fresh
    )
      return Promise.reject(failure('Нет свежей связи для текущего режима охраны', 503));
    const bootId = device.bootId,
      connectionGeneration = device.connectionGeneration ?? 0,
      state = this.runtime.get(deviceId)!;
    const changedConnection = () => {
      const current = this.engine.snapshot().devices.find((row) => row.id === deviceId);
      return (
        !current?.online ||
        current.bootId !== bootId ||
        (current.connectionGeneration ?? 0) !== connectionGeneration
      );
    };
    const recoverCurrent = () => {
      state.needs = true;
      state.reason = 'recovery';
      state.attempts = 0;
      state.nextTry = 0;
      state.waitSample = null;
      state.status = 'unknown';
    };
    state.attempts++;
    state.status = 'pending';
    const task = (async () => {
      let sent = false,
        timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const fence = await this.engine.sendSecurityLease!(deviceId, {
          ...this.leaseInput(),
          busy: true,
        });
        if (this.stopped || this.store.revision !== revision || changedConnection())
          throw failure('Режим или загрузка PLC изменились до отправки');
        sent = true;
        const timeout = Math.min(
          this.options.commandTimeoutMs || SECURITY_COMMAND_TIMEOUT_MS,
          SECURITY_COMMAND_TIMEOUT_MS,
        );
        const result = await Promise.race([
          this.engine.command(deviceId, 'security', 'alarm', value, timeout, fence),
          new Promise<CommandView>((resolve) => {
            timer = setTimeout(() => resolve(this.unknown(deviceId, value)), timeout + 250).unref();
          }),
        ]);
        if (!this.stopped && this.store.revision === revision) {
          if (changedConnection()) {
            recoverCurrent();
            return result;
          }
          state.needs = result.status !== 'applied';
          state.status =
            result.status === 'applied'
              ? 'confirmed'
              : result.status === 'rejected'
                ? 'rejected'
                : 'unknown';
          state.error = result.error;
          state.reason = 'observation';
          state.waitSample = sample(
            this.engine.snapshot().devices.find((row) => row.id === deviceId) || device,
          );
          state.nextTry = this.now() + Math.min(30000, 1000 * 2 ** state.attempts);
        }
        return result;
      } catch (error) {
        if (changedConnection()) {
          recoverCurrent();
          throw error;
        }
        state.needs = true;
        state.status = sent ? 'unknown' : 'rejected';
        state.error = readable(error);
        state.reason = sent ? 'observation' : state.reason;
        state.waitSample = sent
          ? sample(this.engine.snapshot().devices.find((row) => row.id === deviceId) || device)
          : null;
        state.nextTry = this.now() + Math.min(30000, 1000 * 2 ** state.attempts);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    this.pending.set(deviceId, task);
    void task
      .finally(() => {
        if (this.pending.get(deviceId) === task) this.pending.delete(deviceId);
      })
      .catch(() => {});
    return task;
  }
  private unknown(deviceId: string, value: boolean): CommandView {
    return {
      id: randomUUID(),
      deviceId,
      controller: 'security',
      itemId: 'alarm',
      value,
      sequence: 0,
      status: 'unknown',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: 'PLC не подтвердил текущий режим за отведённое время',
    };
  }
  private observe(snapshot: EngineSnapshot): void {
    let next = this.store.devices.map((row) => ({ ...row }));
    for (const device of snapshot.devices) {
      const record = {
        deviceId: device.id,
        name: device.name,
        configured: configured(device),
        enabled: device.controllers.security?.data.enabled === true,
      };
      const index = next.findIndex((row) => row.deviceId === device.id);
      if (index < 0) {
        if (next.length < MAX_DEVICES) next.push(record);
      } else
        next[index] = device.controllers.security?.fresh
          ? record
          : { ...next[index], name: device.name };
      let state = this.runtime.get(device.id);
      if (!state) {
        state = {
          live: false,
          bootId: null,
          connectionGeneration: null,
          needs: this.store.desiredArmed !== null,
          reason: 'recovery',
          attempts: 0,
          nextTry: 0,
          waitSample: null,
          status: 'unknown',
          error: null,
        };
        this.runtime.set(device.id, state);
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(this.store.devices) && !this.storageError)
      this.commit({ ...this.store, devices: next });
    for (const known of this.store.devices) {
      const device = snapshot.devices.find((row) => row.id === known.deviceId),
        state = this.runtime.get(known.deviceId);
      if (!state) continue;
      const live = Boolean(
        snapshot.broker.connected &&
        device?.online &&
        device.bootId &&
        device.controllers.security?.fresh,
      );
      if (
        live &&
        (!state.live ||
          state.bootId !== device!.bootId ||
          state.connectionGeneration !== (device!.connectionGeneration ?? 0))
      ) {
        state.needs = this.store.desiredArmed !== null;
        state.reason = 'recovery';
        state.attempts = 0;
        state.nextTry = 0;
        state.waitSample = null;
        state.error = null;
        state.status = 'unknown';
      }
      state.live = live;
      state.bootId = device?.bootId || null;
      if (live) state.connectionGeneration = device!.connectionGeneration ?? 0;
      // Enabling a continuously online module is configuration, never an implicit arming action.
      if (!known.configured || !known.enabled) {
        state.needs = false;
        state.waitSample = null;
        state.status = 'unknown';
        state.error = null;
      }
    }
  }
  private commit(next: StoredHouse): boolean {
    if (this.storageError) return false;
    let descriptor: number | undefined,
      temporary = '';
    try {
      if (this.file) {
        temporary = this.file + '.' + randomUUID() + '.tmp';
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, JSON.stringify(next, null, 2) + '\n');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, this.file);
        const parent = openSync(dirname(this.file), 'r');
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      }
      this.store = next;
      return true;
    } catch (error) {
      this.storageError = 'Не удалось сохранить общее намерение охраны: ' + readable(error);
      return false;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temporary)
        try {
          unlinkSync(temporary);
        } catch {
          /* Successful rename consumed it. */
        }
    }
  }
  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw new Error('Некорректный файл');
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (
        !object(value) ||
        value.version !== 1 ||
        !(value.desiredArmed === null || typeof value.desiredArmed === 'boolean') ||
        !Number.isInteger(value.revision) ||
        Number(value.revision) < 0 ||
        Number(value.revision) > MAX_REVISION ||
        !Array.isArray(value.devices) ||
        value.devices.length > MAX_DEVICES ||
        !Array.isArray(value.consumed) ||
        value.consumed.length > MAX_EVENTS ||
        !value.consumed.every((id) => typeof id === 'string' && id.length <= 300)
      )
        throw new Error('Некорректный формат');
      if (
        !value.devices.every(
          (row) =>
            object(row) &&
            typeof row.deviceId === 'string' &&
            /^fcplcn-[a-zA-Z0-9_-]{1,96}$/.test(row.deviceId) &&
            typeof row.name === 'string' &&
            Buffer.byteLength(row.name) <= 128 &&
            typeof row.configured === 'boolean' &&
            typeof row.enabled === 'boolean',
        ) ||
        new Set(value.devices.map((row) => row.deviceId)).size !== value.devices.length
      )
        throw new Error('Некорректный список PLC');
      if (
        value.lastEvent !== null &&
        (!object(value.lastEvent) ||
          typeof value.lastEvent.eventId !== 'string' ||
          typeof value.lastEvent.deviceId !== 'string' ||
          typeof value.lastEvent.keyName !== 'string' ||
          value.lastEvent.keyName.length > 128 ||
          typeof value.lastEvent.at !== 'string' ||
          !Number.isFinite(Date.parse(value.lastEvent.at)) ||
          typeof value.lastEvent.value !== 'boolean')
      )
        throw new Error('Некорректное событие');
      this.store = value as unknown as StoredHouse;
    } catch {
      this.storageError =
        'Не удалось прочитать house-security.json; общее управление остановлено, файл сохранён';
    }
  }
}
