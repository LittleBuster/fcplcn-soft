/** @file One local control authority shared by the LAN web, Telegram and authenticated cloud uplink. */
import { performance } from 'node:perf_hooks';
import type { HubEngine, HubSnapshot, Product, WritableControllerKind } from '../shared/types.js';
import { cloudPermitted, type CloudActor, type CloudMethod } from '../shared/cloud.js';
import { serviceRoute } from '../src/protocol/management.js';
import { Scenes } from './scenes.js';
import type { SceneScheduler } from './scheduler.js';
import { validLabel } from './storage.js';
import { isDeviceIllustrationId } from '../shared/device-art.js';
import { HouseSecurity } from './house-security.js';
import type { TelegramView } from '../shared/telegram.js';
import { PultSettings } from './pult-settings.js';
import { cloudActivityEntry, cloudSceneActivity } from './activity-context.js';

export interface TelegramAPI {
  snapshot(): TelegramView;
  update(patch: unknown): TelegramView | Promise<TelegramView>;
  test(): Promise<unknown>;
}
export interface HubControlOptions {
  engine: HubEngine;
  scenes: Scenes;
  scheduler?: SceneScheduler;
  product: Product;
  mode: 'demo' | 'mqtt';
  telegram?: TelegramAPI;
  onBusy?: (busy: boolean) => void;
  dataDir?: string;
  houseSecurity?: HouseSecurity;
}
export interface DispatchOptions {
  signal?: AbortSignal;
  remainingMs?: number;
  actor?: CloudActor;
  maintenance?: boolean;
}
export interface DispatchResult {
  status: number;
  data: unknown;
}
const fail = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
const only = (body: Record<string, unknown>, keys: string[]) =>
  Object.keys(body).every((key) => keys.includes(key));

/** Authority never queues offline actions or bypasses the PLC's own ownership and deadline checks. */
export class HubControl {
  readonly houseSecurity?: HouseSecurity;
  private readonly pult: PultSettings;
  private firmware?: {
    start(deviceId: string, body: Record<string, unknown>): DispatchResult;
    status(jobId: string): DispatchResult;
  };
  private manual = 0;
  private writing = 0;
  private maintenance = false;
  private readonly uploads = new Map<string, { bootId: string; until: number }>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: HubControlOptions) {
    this.pult = new PultSettings(options.dataDir);
    this.timer = setInterval(() => this.refresh(), 1000).unref();
    this.houseSecurity =
      options.houseSecurity ||
      (options.engine.sendSecurityLease && options.engine.onSecurityTouch
        ? new HouseSecurity(options.engine, options.scenes, {
            directory: options.dataDir,
            isBusy: () => Boolean(this.manual || this.writing || this.uploads.size),
            runScene: (id, signal) => this.startScene(id, undefined, signal),
          })
        : undefined);
    this.houseSecurity?.start();
  }
  close(): void {
    clearInterval(this.timer);
    this.houseSecurity?.stop();
  }
  setFirmware(value: {
    start(deviceId: string, body: Record<string, unknown>): DispatchResult;
    status(jobId: string): DispatchResult;
  }): void {
    this.firmware = value;
  }
  holdMaintenance(): () => void {
    this.refresh();
    if (
      this.manual ||
      this.writing ||
      this.uploads.size ||
      this.maintenance ||
      this.options.scenes.snapshot().activeRun
    )
      throw fail('Дождитесь завершения текущей операции PLC');
    this.maintenance = true;
    this.writing++;
    this.notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.maintenance = false;
      this.writing--;
      this.notify();
    };
  }
  private notify(): void {
    this.options.onBusy?.(this.manual + this.writing + this.uploads.size > 0);
  }
  private refresh(): void {
    const devices = this.options.engine.snapshot().devices;
    let changed = false;
    for (const [id, row] of this.uploads) {
      const current = devices.find((entry) => entry.id === id);
      if (performance.now() >= row.until || (current?.bootId && current.bootId !== row.bootId)) {
        this.uploads.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }
  snapshot() {
    return this.options.engine.snapshot();
  }
  scenes() {
    return {
      ...this.options.scenes.snapshot(),
      ...(this.options.scheduler ? { scheduler: this.options.scheduler.snapshot() } : {}),
    };
  }
  overview(): HubSnapshot {
    return {
      ...this.snapshot(),
      product: this.options.product,
      mode: this.options.mode,
      now: new Date().toISOString(),
      scenes: this.scenes(),
      pult: this.pult.snapshot(),
      ...(this.houseSecurity ? { houseSecurity: this.houseSecurity.snapshot() } : {}),
    };
  }
  async command(
    deviceId: string,
    kind: WritableControllerKind,
    itemId: string,
    value: boolean,
    remainingMs?: number,
  ) {
    this.refresh();
    if (this.writing || this.uploads.size)
      throw fail('Дождитесь сохранения настроек или обновления PLC');
    if (this.options.scenes.snapshot().activeRun) throw fail('Дождитесь завершения сценария');
    this.manual++;
    this.notify();
    try {
      return kind === 'security' && this.houseSecurity
        ? await this.houseSecurity.commandSingle(deviceId, value, remainingMs)
        : await this.options.engine.command(deviceId, kind, itemId, value, remainingMs);
    } finally {
      this.manual--;
      this.notify();
    }
  }
  runScene(id: string, actor?: CloudActor) {
    this.requireSceneReady(id, actor);
    return this.options.scenes.run(id);
  }
  startScene(id: string, actor?: CloudActor, signal?: AbortSignal) {
    this.requireSceneReady(id, actor);
    return this.options.scenes.startRun(id, 'manual', signal);
  }
  private requireSceneReady(id: string, actor?: CloudActor): void {
    this.refresh();
    if (this.manual || this.writing || this.uploads.size)
      throw fail('Дождитесь подтверждения текущей команды PLC');
    if ((id === 'home' || id === 'away') && this.houseSecurity?.busy)
      throw fail('Дождитесь завершения текущего действия охраны');
    if (actor && actor.role !== 'owner' && !actor.securityControl) {
      const definition = this.options.scenes
        .snapshot()
        .definitions.find((entry) => entry.id === id);
      if (
        id === 'home' ||
        id === 'away' ||
        definition?.actions.some((entry) => entry.controller === 'security')
      )
        throw fail('Нет разрешения управлять охраной', 403);
    }
  }
  private lease(deviceId: string): void {
    const device = this.snapshot().devices.find((entry) => entry.id === deviceId);
    if (device?.bootId)
      this.uploads.set(deviceId, { bootId: device.bootId, until: performance.now() + 60000 });
    this.notify();
  }
  async service(
    deviceId: string,
    method: 'GET' | 'POST',
    path: string,
    payload?: Record<string, unknown>,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    this.refresh();
    if (!this.options.engine.service)
      throw fail('Эта версия хаба не поддерживает настройку PLC', 426);
    if (path === '/logout' && method === 'POST') return { status: 200, data: { ok: true } };
    const login = path === '/login' && method === 'POST';
    if (!login && !serviceRoute(method, path)) throw fail('Метод настройки PLC не найден', 404);
    const mutating = method === 'POST' && !login;
    if (mutating && this.maintenance && !options.maintenance)
      throw fail('Выполняется обслуживание прошивки PLC');
    if (mutating && this.uploads.has(deviceId) && !path.startsWith('/firmware/'))
      throw fail('Дождитесь завершения обновления прошивки PLC');
    if (mutating && (this.options.scenes.snapshot().activeRun || this.manual))
      throw fail('Дождитесь завершения сценария или текущей команды PLC');
    if (options.signal?.aborted) throw fail('Срок запроса истёк до отправки', 408);
    if (mutating) {
      this.writing++;
      this.notify();
    }
    try {
      const result = await this.options.engine.service(
        deviceId,
        login ? 'GET' : method,
        login ? '/config' : path,
        login ? undefined : payload,
        options.signal,
        options.remainingMs,
      );
      if (!Array.isArray(result.data)) {
        if (
          result.status === 200 &&
          method === 'POST' &&
          ['/firmware/begin', '/firmware/chunk', '/firmware/finish'].includes(path)
        )
          this.lease(deviceId);
        else if (
          result.status === 200 &&
          (path === '/firmware/abort' ||
            (path === '/firmware' && !['receiving', 'ready'].includes(String(result.data.state))))
        ) {
          this.uploads.delete(deviceId);
          this.notify();
        }
      }
      return {
        status: result.status,
        data:
          login && result.status === 200
            ? {
                ok: true,
                username:
                  (
                    (result.data as Record<string, unknown>).user as
                      { username?: string } | undefined
                  )?.username || 'admin',
              }
            : result.data,
      };
    } catch (error) {
      const failure = error as { statusCode?: number; message?: string; unknown?: boolean };
      if (
        failure.unknown &&
        method === 'POST' &&
        path.startsWith('/firmware/') &&
        path !== '/firmware/abort'
      )
        this.lease(deviceId);
      return {
        status: failure.statusCode || 503,
        data: {
          error: failure.message || 'PLC не подтвердил операцию',
          unknown: failure.unknown === true,
        },
      };
    } finally {
      if (mutating) {
        this.writing--;
        this.notify();
      }
    }
  }
  /** Exact same business surface for all trusted transports; no LAN URL or topic proxy exists. */
  async dispatch(
    method: CloudMethod,
    path: string,
    body: Record<string, unknown> = {},
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    if (options.actor && !cloudPermitted(options.actor, method, path, body))
      throw fail('Нет разрешения на эту операцию', 403);
    if (options.signal?.aborted || (options.remainingMs !== undefined && options.remainingMs < 250))
      throw fail('Срок запроса истёк до отправки', 408);
    if (method === 'GET' && path === '/overview') {
      const data = this.overview();
      if (options.actor) {
        data.commands = data.commands.map(cloudActivityEntry);
        data.scenes = cloudSceneActivity(data.scenes);
      }
      return { status: 200, data };
    }
    if (method === 'GET' && path === '/pult/settings')
      return { status: 200, data: this.pult.snapshot() };
    if (method === 'PUT' && path === '/pult/settings')
      return { status: 200, data: this.pult.update(body, this.snapshot().devices) };
    if (method === 'GET' && path === '/scenes') {
      const data = this.scenes();
      return { status: 200, data: options.actor ? cloudSceneActivity(data) : data };
    }
    const key = /^\/devices\/(fcplcn-[a-zA-Z0-9_-]{1,96})\/security\/key$/.exec(path);
    if (key && method === 'POST') {
      if (this.options.mode !== 'demo' || !this.options.engine.demoSecurityTouch)
        throw fail('Имитация ключа доступна только в демонстрационном режиме', 404);
      if (
        !only(body, ['keyId']) ||
        (body.keyId !== undefined &&
          (typeof body.keyId !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(body.keyId)))
      )
        throw fail('Укажите настроенный ключ iButton', 400);
      if (this.houseSecurity?.busy) throw fail('Дождитесь завершения текущего действия охраны');
      return this.options.engine.demoSecurityTouch(key[1], body.keyId as string | undefined);
    }
    const installation = /^\/devices\/(fcplcn-[a-zA-Z0-9_-]{1,96})\/firmware\/install$/.exec(path);
    const job = /^\/firmware\/jobs\/([a-zA-Z0-9_-]{1,96})$/.exec(path);
    if (method === 'POST' && installation) {
      if (!this.firmware) throw fail('Служба установки прошивок не запущена', 503);
      return this.firmware.start(installation[1], body);
    }
    if (method === 'GET' && job) {
      if (!this.firmware) throw fail('Служба установки прошивок не запущена', 503);
      return this.firmware.status(job[1]);
    }
    if (path === '/telegram' || path === '/telegram/test') {
      const telegram = this.options.telegram;
      if (!telegram) throw fail('Служба Telegram не запущена', 503);
      if (method === 'GET' && path === '/telegram')
        return { status: 200, data: telegram.snapshot() };
      if (method === 'POST' && path === '/telegram')
        return { status: 200, data: await telegram.update(body) };
      if (method === 'POST' && path === '/telegram/test' && !Object.keys(body).length)
        return { status: 200, data: await telegram.test() };
      throw fail('Проверка использует сохранённый токен бота', 400);
    }
    const service = /^\/devices\/(fcplcn-[a-zA-Z0-9_-]{1,96})\/service(\/.*)$/.exec(path);
    if (service && (method === 'GET' || method === 'POST'))
      return this.service(
        service[1],
        method,
        service[2],
        method === 'POST' ? body : undefined,
        options,
      );
    if (method === 'POST' && path === '/scenes') {
      if (
        !only(body, ['name', 'description', 'actions', 'schedule']) ||
        typeof body.name !== 'string' ||
        (body.description !== undefined && typeof body.description !== 'string')
      )
        throw fail('Укажите название, описание и действия сценария', 400);
      return {
        status: 201,
        data: this.options.scenes.create(
          body.name,
          (body.description as string) || '',
          body.actions,
          body.schedule,
        ),
      };
    }
    const scene = /^\/scenes\/([a-zA-Z0-9_-]{1,64})(\/run|\/schedule)?$/.exec(path);
    if (scene && method === 'PUT' && scene[2] === '/schedule') {
      if (!only(body, ['baseRevision', 'enabled']) || typeof body.enabled !== 'boolean')
        throw fail('Укажите версию сценария и состояние расписания', 400);
      return {
        status: 200,
        data: this.options.scenes.setScheduleEnabled(
          scene[1],
          body.baseRevision as number,
          body.enabled,
        ),
      };
    }
    if (scene && method === 'POST' && scene[2] === '/run') {
      if (Object.keys(body).length)
        throw fail('Запуск сценария не принимает дополнительные параметры', 400);
      return { status: 202, data: await this.startScene(scene[1], options.actor, options.signal) };
    }
    if (scene && method === 'PUT' && !scene[2]) {
      if (!only(body, ['baseRevision', 'actions', 'name', 'description', 'schedule']))
        throw fail('Неизвестное поле сценария', 400);
      return {
        status: 200,
        data: this.options.scenes.update(scene[1], body.baseRevision as number, body.actions, {
          ...('name' in body ? { name: body.name } : {}),
          ...('description' in body ? { description: body.description } : {}),
          ...('schedule' in body ? { schedule: body.schedule } : {}),
        }),
      };
    }
    if (scene && method === 'DELETE' && !scene[2]) {
      if (!only(body, ['baseRevision'])) throw fail('Укажите только ревизию сценария', 400);
      this.options.scenes.delete(scene[1], body.baseRevision as number);
      return { status: 200, data: { ok: true } };
    }
    const device = /^\/devices\/(fcplcn-[a-zA-Z0-9_-]{1,96})(\/commands)?$/.exec(path);
    if (device && method === 'PATCH' && !device[2]) {
      if (
        !only(body, ['name', 'room', 'illustrationId']) ||
        !validLabel(body.name) ||
        !body.name.trim() ||
        !validLabel(body.room)
      )
        throw fail('Укажите имя и помещение: до 96 байт каждое', 400);
      const illustrationId = isDeviceIllustrationId(body.illustrationId)
        ? body.illustrationId
        : undefined;
      if (Object.hasOwn(body, 'illustrationId') && illustrationId === undefined)
        throw fail('Выберите изображение устройства из каталога', 400);
      this.options.engine.rename(device[1], body.name.trim(), body.room.trim(), illustrationId);
      return { status: 200, data: { ok: true } };
    }
    if (device && method === 'POST' && device[2]) {
      if (
        !only(body, ['controller', 'itemId', 'value']) ||
        !['sockets', 'lights', 'thermostats', 'security', 'tanks', 'irrigation'].includes(
          String(body.controller),
        ) ||
        typeof body.itemId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,32}$/.test(body.itemId) ||
        typeof body.value !== 'boolean'
      )
        throw fail('Укажите контроллер, элемент и явное значение true/false', 400);
      return {
        status: 200,
        data: await this.command(
          device[1],
          body.controller as WritableControllerKind,
          body.itemId,
          body.value,
          options.remainingMs,
        ),
      };
    }
    throw fail('Метод API не найден', 404);
  }
}
