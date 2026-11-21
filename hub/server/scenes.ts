/** @file Persistent, explicit multi-PLC scenes; autonomous control loops stay on the PLCs. */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  sceneIds,
  type DeviceView,
  type HubEngine,
  type SceneAction,
  type SceneActionResult,
  type SceneDefinition,
  type SceneId,
  type SceneRun,
  type SceneSchedule,
  type ScenesSnapshot,
  type WritableControllerKind,
  type CommandView,
  type EngineSnapshot,
} from '../shared/types.js';

const MAX_ACTIONS = 64;
const MAX_SCENES = 32;
const MAX_RUNS = 20;
const MAX_RESULTS = 320;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const writable = ['sockets', 'lights', 'thermostats', 'security'];
const runStates = ['running', 'completed', 'partial', 'failed', 'empty', 'interrupted'];
const resultStates = ['pending', 'applied', 'rejected', 'unknown', 'unavailable', 'skipped'];

interface StoredScenes {
  version: 1;
  definitions: SceneDefinition[];
  runs: SceneRun[];
}

interface PlannedTarget {
  result: SceneActionResult;
  bootId: string | null;
}
/** The house coordinator owns current guard intent; scenes own each explicit run and its extras. */
export interface HouseSceneHooks {
  inventory(snapshot: EngineSnapshot): DeviceView[];
  accept(run: SceneRun): void;
  command(deviceId: string, value: boolean): Promise<CommandView>;
  singleCommand(deviceId: string, value: boolean): Promise<CommandView>;
}

/** @brief A visible validation, concurrency or storage refusal for the local API. */
export class SceneError extends Error {
  readonly statusCode: number;
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'SceneError';
    this.statusCode = status;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function identifier(value: unknown, maximum = 64): value is string {
  return (
    text(value, maximum) &&
    /^[a-zA-Z0-9_-]+$/.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value)
  );
}

function revision(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0xffff_ffff;
}

function only(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

/** @brief Bound external diagnostic/label strings before retaining them in the run journal. */
function readable(value: unknown, fallback: string, maximum = 512): string {
  if (typeof value !== 'string') return fallback;
  let result = '';
  for (const letter of value.replace(/[\x00-\x1f\x7f]/g, ' ')) {
    if (Buffer.byteLength(result + letter) > maximum) break;
    result += letter;
  }
  return result || fallback;
}

function fixedDefinitions(demo: boolean): SceneDefinition[] {
  return [
    {
      id: 'home',
      name: 'Я дома',
      description: 'Параллельно снять охрану на всех PLC и выполнить назначенные действия.',
      revision: 1,
      builtin: true,
      schedule: null,
      actions: [],
    },
    {
      id: 'away',
      name: 'Ушел',
      description: 'Параллельно поставить все PLC на охрану и выполнить назначенные действия.',
      revision: 1,
      builtin: true,
      schedule: null,
      actions: [],
    },
    {
      id: 'prepare',
      name: 'Готовлюсь',
      description: 'Выполнить назначенные действия света, розеток, термостатов и охраны.',
      revision: 1,
      builtin: true,
      schedule: null,
      actions: demo
        ? [
            {
              id: 'demo-garage-light',
              deviceId: 'fcplcn-demo-garage',
              controller: 'lights',
              itemId: 'light-garage',
              value: true,
            },
            {
              id: 'demo-living-heat',
              deviceId: 'fcplcn-demo-living',
              controller: 'thermostats',
              itemId: 'thermo-floor',
              value: true,
            },
            {
              id: 'demo-utility-heat',
              deviceId: 'fcplcn-demo-utility',
              controller: 'thermostats',
              itemId: 'thermo-room',
              value: true,
            },
          ]
        : [],
    },
  ];
}
/** Exact historical text only; unrelated edits to protected builtin definitions remain invalid. */
const legacyBuiltinDescriptions: Record<string, string> = {
  home: 'Снять охрану на всех PLC, затем выполнить назначенные действия.',
  away: 'Поставить все PLC на охрану, затем выполнить назначенные действия.',
};

/** @brief Validate wall-clock scheduling data; execution/once-per-slot claims belong to the scheduler. */
function decodeSchedule(value: unknown): SceneSchedule | null {
  if (value === undefined || value === null) return null;
  if (
    !object(value) ||
    !only(value, ['enabled', 'days', 'time', 'timeZone']) ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.days) ||
    !value.days.length ||
    value.days.length > 7 ||
    value.days.some(
      (day: unknown) => !Number.isInteger(day) || (day as number) < 1 || (day as number) > 7,
    ) ||
    new Set(value.days).size !== value.days.length ||
    typeof value.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
    !text(value.timeZone, 64) ||
    !value.timeZone
  )
    throw new SceneError('Проверьте дни недели, время HH:mm и часовой пояс расписания', 400);
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format();
  } catch {
    throw new SceneError('Неизвестный часовой пояс расписания', 400);
  }
  return {
    enabled: value.enabled,
    days: [...(value.days as number[])].sort((a, b) => a - b),
    time: value.time,
    timeZone: value.timeZone,
  };
}

/** @brief Validate one saved list without requiring discovery to have completed at startup. */
function decodeActions(value: unknown, sceneId: string): SceneAction[] {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS)
    throw new SceneError('В сценарии допускается не более 64 действий', 400);
  const ids = new Set<string>(),
    targets = new Set<string>();
  return value.map((row: unknown) => {
    if (
      !object(row) ||
      !only(row, ['id', 'deviceId', 'controller', 'itemId', 'value']) ||
      !identifier(row.id) ||
      typeof row.deviceId !== 'string' ||
      !/^fcplcn-[a-zA-Z0-9_-]{1,96}$/.test(row.deviceId) ||
      !identifier(row.itemId, 32) ||
      typeof row.value !== 'boolean' ||
      !writable.includes(row.controller as string)
    )
      throw new SceneError('Проверьте устройство, канал и состояние каждого действия', 400);
    const action = row as unknown as SceneAction;
    if (
      action.controller === 'security' &&
      (action.itemId !== 'alarm' || sceneId === 'home' || sceneId === 'away')
    )
      throw new SceneError(
        'В режимах «Я дома» и «Ушел» охрана управляется общим действием; в остальных сценариях выберите канал alarm',
        400,
      );
    const target = `${action.deviceId}/${action.controller}/${action.itemId}`;
    if (ids.has(action.id) || targets.has(target))
      throw new SceneError('Один канал можно назначить в сценарий только один раз', 400);
    ids.add(action.id);
    targets.add(target);
    return {
      id: action.id,
      deviceId: action.deviceId,
      controller: action.controller,
      itemId: action.itemId,
      value: action.value,
    };
  });
}

/** @brief Durable scene definitions and a bounded journal, with no automatic startup execution. */
export class Scenes {
  private definitions: SceneDefinition[];
  private runs: SceneRun[] = [];
  private active: SceneRun | null = null;
  private stopped = false;
  private generation = 0;
  private readonly inFlight = new Set<string>();
  private houseSecurity?: HouseSceneHooks;
  private storageError: string | null = null;
  private readonly path?: string;

  constructor(
    private readonly engine: HubEngine,
    options: { directory?: string; demo?: boolean } = {},
  ) {
    this.definitions = fixedDefinitions(options.demo === true);
    if (options.directory) {
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      this.path = join(options.directory, 'scenes.json');
      if (existsSync(this.path)) this.load();
      else this.persist();
    }
  }

  /** @brief Return detached editable definitions and truthful per-target outcomes. */
  snapshot(): ScenesSnapshot {
    return structuredClone({
      definitions: this.definitions,
      activeRun: this.active,
      runs: this.runs,
      storageError: this.storageError,
    });
  }
  setHouseSecurity(hooks: HouseSceneHooks): void {
    this.houseSecurity = hooks;
  }

  /** @brief Create a user-named scene; this operation stores settings without running commands. */
  create(name: string, description: string, actions: unknown, schedule?: unknown): SceneDefinition {
    this.mutable();
    if (this.definitions.length >= MAX_SCENES)
      throw new SceneError('Можно создать не более 32 сценариев вместе с режимами', 400);
    const metadata = this.metadata(name, description);
    const definition: SceneDefinition = {
      id: `scene-${randomUUID()}`,
      ...metadata,
      revision: 1,
      builtin: false,
      actions: decodeActions(actions, 'custom'),
      schedule: decodeSchedule(schedule),
    };
    this.knownTargets(definition.actions);
    const next = [...this.definitions, definition];
    this.persist(next);
    this.definitions = next;
    return structuredClone(definition);
  }

  /** @brief Commit an ordered list using optimistic revision checking, never applying it implicitly. */
  update(
    id: SceneId,
    baseRevision: number,
    actions: unknown,
    metadata: { name?: unknown; description?: unknown; schedule?: unknown } = {},
  ): SceneDefinition {
    this.mutable();
    const current = this.definition(id);
    this.checkRevision(current, baseRevision);
    if (!object(metadata) || !only(metadata, ['name', 'description', 'schedule']))
      throw new SceneError('Неизвестные поля сценария', 400);
    if (
      current.builtin &&
      ((metadata.name !== undefined && metadata.name !== current.name) ||
        (metadata.description !== undefined && metadata.description !== current.description))
    )
      throw new SceneError('Название и описание основных режимов фиксированы', 400);
    const copy: SceneDefinition = {
      ...current,
      ...(current.builtin
        ? {}
        : this.metadata(
            metadata.name === undefined ? current.name : metadata.name,
            metadata.description === undefined ? current.description : metadata.description,
          )),
      revision: current.revision + 1,
      actions: decodeActions(actions, id),
      schedule:
        metadata.schedule === undefined
          ? (current.schedule ?? null)
          : decodeSchedule(metadata.schedule),
    };
    this.knownTargets(copy.actions);
    const next = this.definitions.map((definition) => (definition.id === id ? copy : definition));
    this.persist(next);
    this.definitions = next;
    return structuredClone(copy);
  }

  /** @brief Delete a custom definition while retaining the original names in historical runs. */
  delete(id: SceneId, baseRevision: number): void {
    this.mutable();
    const current = this.definition(id);
    this.checkRevision(current, baseRevision);
    if (current.builtin) throw new SceneError('Основные режимы удалить нельзя', 400);
    const next = this.definitions.filter((definition) => definition.id !== id);
    this.persist(next);
    this.definitions = next;
  }

  /** @brief Save a complete plan first, then start one bounded background run without retries. */
  run(id: SceneId, trigger: 'manual' | 'schedule' = 'manual'): SceneRun {
    this.mutable();
    if (trigger !== 'manual' && trigger !== 'schedule')
      throw new SceneError('Неизвестный источник запуска', 400);
    const definition = this.definition(id);
    const snapshot = this.engine.snapshot();
    const planned: PlannedTarget[] = [];
    if (id === 'home' || id === 'away') {
      for (const device of this.houseSecurity?.inventory(snapshot) || snapshot.devices) {
        if (!device.controllers.security) continue;
        planned.push(
          this.target(
            device,
            {
              id: `security:${device.id}`,
              deviceId: device.id,
              controller: 'security',
              itemId: 'alarm',
              value: id === 'away',
            },
            'security',
            snapshot.broker.connected,
          ),
        );
      }
    }
    for (const action of definition.actions)
      planned.push(
        this.target(
          snapshot.devices.find((device) => device.id === action.deviceId),
          { ...action, id: `configured:${action.id}` },
          'configured',
          snapshot.broker.connected,
        ),
      );
    const run: SceneRun = {
      id: randomUUID(),
      sceneId: id,
      name: definition.name,
      trigger,
      status: planned.some((target) => target.result.status === 'pending') ? 'running' : 'empty',
      startedAt: new Date().toISOString(),
      completedAt: null,
      results: planned.map((target) => target.result),
      error: null,
    };
    if (run.status !== 'running') {
      run.status = this.resultStatus(run);
      run.completedAt = new Date().toISOString();
    }
    const next = [run, ...this.runs].slice(0, MAX_RUNS);
    // No physical command is dispatched unless the plan is durably committed first.
    this.persist(this.definitions, next);
    if ((id === 'home' || id === 'away') && this.houseSecurity) {
      try {
        this.houseSecurity.accept(run);
      } catch (error) {
        run.status = 'interrupted';
        run.completedAt = new Date().toISOString();
        run.error = readable((error as Error).message, 'Общее намерение охраны не сохранено');
        for (const result of run.results)
          if (result.status === 'pending') {
            result.status = 'unavailable';
            result.error = run.error;
          }
        this.runs = next;
        this.persist();
        throw error;
      }
    }
    this.runs = next;
    if (run.status === 'running') {
      this.active = run;
      const generation = ++this.generation;
      void Promise.resolve().then(() => this.execute(run, planned, generation));
    }
    return structuredClone(run);
  }

  /** @brief Stop future dispatches; an in-flight physical result remains explicitly unknown. */
  async stop(): Promise<void> {
    this.stopped = true;
    ++this.generation;
    const run = this.active;
    if (!run) return;
    for (const result of run.results) {
      if (result.status !== 'pending') continue;
      result.status = this.inFlight.has(result.id) ? 'unknown' : 'unavailable';
      result.error = this.inFlight.has(result.id)
        ? 'Хаб остановлен до подтверждения команды'
        : 'Хаб остановлен; действие не отправлено';
    }
    run.status = 'interrupted';
    run.completedAt = new Date().toISOString();
    run.error = 'Сценарий прерван при остановке хаба; автоматического продолжения нет';
    this.active = null;
    this.inFlight.clear();
    try {
      this.persist();
    } catch (error) {
      this.storageError = readable((error as Error).message, 'Не удалось сохранить прерывание');
      run.error = this.storageError;
    }
  }

  private mutable(): void {
    if (this.stopped) throw new SceneError('Сервис сценариев остановлен', 503);
    if (this.active) throw new SceneError('Другой сценарий ещё выполняется', 409);
  }

  private definition(id: string): SceneDefinition {
    if (!identifier(id)) throw new SceneError('Некорректный идентификатор сценария', 400);
    const definition = this.definitions.find((definition) => definition.id === id);
    if (!definition) throw new SceneError('Сценарий не найден', 404);
    return definition;
  }

  private checkRevision(current: SceneDefinition, base: number): void {
    if (!revision(base)) throw new SceneError('Нужна корректная версия сценария', 400);
    if (current.revision !== base)
      throw new SceneError('Сценарий изменился; загрузите сохранённую версию', 409);
    if (current.revision === 0xffff_ffff)
      throw new SceneError('Исчерпан счётчик версий сценария', 409);
  }

  private metadata(name: unknown, description: unknown): { name: string; description: string } {
    if (!text(name, 96) || !name.trim() || !text(description, 512))
      throw new SceneError('Укажите название до 96 байт и описание до 512 байт', 400);
    return { name: name.trim(), description: description.trim() };
  }

  private knownTargets(actions: SceneAction[]): void {
    const devices = this.engine.snapshot().devices;
    for (const action of actions) {
      const module = devices.find((device) => device.id === action.deviceId)?.controllers[
        action.controller
      ];
      const items = module?.data.items;
      if (
        !module ||
        (action.controller !== 'security' &&
          (!Array.isArray(items) ||
            !items.some((item: unknown) => object(item) && item.id === action.itemId)))
      )
        throw new SceneError('Выберите существующий канал обнаруженного PLC', 400);
    }
  }

  private target(
    device: DeviceView | undefined,
    action: Omit<SceneAction, 'controller'> & { controller: WritableControllerKind },
    source: 'security' | 'configured',
    brokerConnected: boolean,
  ): PlannedTarget {
    const module = device?.controllers[action.controller];
    const items = module?.data.items;
    const item = Array.isArray(items)
      ? (items.find((item: unknown) => object(item) && item.id === action.itemId) as
          Record<string, unknown> | undefined)
      : undefined;
    const result: SceneActionResult = {
      ...action,
      deviceName: readable(device?.name, action.deviceId, 128),
      itemName:
        action.controller === 'security' ? 'Охрана' : readable(item?.name, action.itemId, 128),
      source,
      status: 'pending',
      error: null,
    };
    if (!device || !module || (action.controller !== 'security' && !item)) {
      result.status = 'unavailable';
      result.error = 'Устройство или канал больше не найден';
    } else if (action.controller === 'security' && module.data.enabled !== true) {
      result.status = 'skipped';
      result.error = 'Модуль охраны выключен; сценарий не включает его автоматически';
    } else if (
      this.houseSecurity &&
      action.controller === 'security' &&
      (!Array.isArray(items) || !items.length)
    ) {
      result.status = 'skipped';
      result.error = 'Охрана не настроена; добавьте датчики на PLC';
    } else if (!brokerConnected || !device.online || !module.fresh || !device.bootId) {
      result.status = 'unavailable';
      result.error = 'Нет свежей связи с PLC; действие не отправлено';
    }
    return { result, bootId: device?.bootId ?? null };
  }

  /** @brief Keep the security phase before extras, then preserve the user's exact list order. */
  private async execute(
    run: SceneRun,
    planned: PlannedTarget[],
    generation: number,
  ): Promise<void> {
    if (this.houseSecurity && (run.sceneId === 'home' || run.sceneId === 'away')) {
      await this.executeHouse(run, planned, generation);
      return;
    }
    let uncertain = false;
    try {
      for (const target of planned) {
        if (this.stopped || this.generation !== generation) return;
        const result = target.result;
        if (result.status !== 'pending') continue;
        const snapshot = this.engine.snapshot();
        const current = snapshot.devices.find((device) => device.id === result.deviceId);
        const module = current?.controllers[result.controller];
        if (uncertain || !snapshot.broker.connected) {
          uncertain = true;
          result.status = 'unavailable';
          result.error =
            'Связь или результат предыдущей команды неизвестны; запустите сценарий заново после проверки';
        } else if (
          !current?.online ||
          !module?.fresh ||
          !target.bootId ||
          current.bootId !== target.bootId
        ) {
          result.status = 'unavailable';
          result.error =
            current?.bootId !== target.bootId
              ? 'PLC перезапущен после начала сценария; действие не отправлено'
              : 'Данные PLC устарели; действие не отправлено';
        } else if (result.controller === 'security' && module.data.enabled !== true) {
          result.status = 'skipped';
          result.error = 'Модуль охраны выключен; сценарий не включает его автоматически';
        } else {
          this.inFlight.add(result.id);
          try {
            const command =
              result.controller === 'security' && this.houseSecurity
                ? await this.houseSecurity.singleCommand(result.deviceId, result.value)
                : await this.engine.command(
                    result.deviceId,
                    result.controller,
                    result.itemId,
                    result.value,
                  );
            if (this.stopped || this.generation !== generation) return;
            result.commandId = command.id;
            result.status = command.status === 'pending' ? 'unknown' : command.status;
            result.error = command.error ? readable(command.error, 'PLC отклонил команду') : null;
            if (result.status === 'unknown') uncertain = true;
          } catch (error) {
            if (this.stopped || this.generation !== generation) return;
            result.status = 'rejected';
            result.error = readable((error as Error).message, 'PLC отклонил команду');
            if (!this.engine.snapshot().broker.connected) uncertain = true;
          } finally {
            if (this.generation === generation) this.inFlight.delete(result.id);
          }
        }
        this.persist();
      }
      if (this.stopped || this.generation !== generation) return;
      run.status = this.resultStatus(run);
      run.completedAt = new Date().toISOString();
      this.persist();
      this.active = null;
    } catch (error) {
      if (this.stopped || this.generation !== generation) return;
      this.storageError = readable(
        (error as Error).message,
        'Не удалось записать результат сценария',
      );
      run.status = 'interrupted';
      run.completedAt = new Date().toISOString();
      run.error = `Результат не сохранён: ${this.storageError}`;
      for (const result of run.results)
        if (result.status === 'pending') {
          result.status = 'unavailable';
          result.error = 'Сценарий остановлен из-за ошибки хранения';
        }
      this.active = null;
      this.inFlight.clear();
    }
  }

  /** Guard acknowledgements never delay configured contactors/lights or replay them on recovery. */
  private async executeHouse(
    run: SceneRun,
    planned: PlannedTarget[],
    generation: number,
  ): Promise<void> {
    const live = () => !this.stopped && this.generation === generation;
    const execute = async (target: PlannedTarget, security: boolean): Promise<boolean> => {
      const result = target.result;
      if (!live() || result.status !== 'pending') return true;
      const snapshot = this.engine.snapshot(),
        current = snapshot.devices.find((device) => device.id === result.deviceId);
      const module = current?.controllers[result.controller];
      if (
        !snapshot.broker.connected ||
        !current?.online ||
        !module?.fresh ||
        current.bootId !== target.bootId
      ) {
        result.status = 'unavailable';
        result.error = 'Нет свежей связи с PLC; действие не отправлено';
      } else {
        this.inFlight.add(result.id);
        try {
          const command = security
            ? await this.houseSecurity!.command(result.deviceId, result.value)
            : await this.engine.command(
                result.deviceId,
                result.controller,
                result.itemId,
                result.value,
              );
          if (!live()) return false;
          result.commandId = command.id;
          result.status = command.status === 'pending' ? 'unknown' : command.status;
          result.error = command.error ? readable(command.error, 'PLC отклонил действие') : null;
        } catch (error) {
          if (!live()) return false;
          result.status = 'rejected';
          result.error = readable((error as Error).message, 'PLC отклонил действие');
        } finally {
          if (live()) this.inFlight.delete(result.id);
        }
      }
      if (!live()) return false;
      this.persist();
      return result.status !== 'unknown' && this.engine.snapshot().broker.connected;
    };
    try {
      await Promise.all([
        Promise.all(
          planned
            .filter((target) => target.result.source === 'security')
            .map((target) => execute(target, true)),
        ),
        (async () => {
          let safe = true;
          for (const target of planned.filter((item) => item.result.source === 'configured')) {
            if (!live()) return;
            if (!safe && target.result.status === 'pending') {
              target.result.status = 'unavailable';
              target.result.error = 'Результат предыдущего дополнительного действия неизвестен';
              this.persist();
              continue;
            }
            safe = await execute(target, false);
          }
        })(),
      ]);
      if (!live()) return;
      run.status = this.resultStatus(run);
      run.completedAt = new Date().toISOString();
      this.persist();
      this.active = null;
    } catch (error) {
      if (!live()) return;
      this.storageError = readable((error as Error).message, 'Не удалось сохранить результат');
      run.status = 'interrupted';
      run.completedAt = new Date().toISOString();
      run.error = this.storageError;
      for (const result of run.results)
        if (result.status === 'pending') {
          result.status = this.inFlight.has(result.id) ? 'unknown' : 'unavailable';
          result.error = this.storageError;
        }
      this.active = null;
      this.inFlight.clear();
      ++this.generation; // Stop the parallel branch before it can dispatch another extra action.
    }
  }

  private resultStatus(run: SceneRun): SceneRun['status'] {
    const applied = run.results.filter((result) => result.status === 'applied').length;
    const failed = run.results.some((result) =>
      ['rejected', 'unknown', 'unavailable'].includes(result.status),
    );
    return failed ? (applied ? 'partial' : 'failed') : applied ? 'completed' : 'empty';
  }

  /** @brief Atomically replace the journal; a failed save never starts physical commands. */
  private persist(definitions = this.definitions, runs = this.runs): void {
    if (!this.path) {
      this.storageError = null;
      return;
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      const encoded =
        JSON.stringify({ version: 1, definitions, runs } satisfies StoredScenes, null, 2) + '\n';
      if (Buffer.byteLength(encoded) > MAX_FILE_BYTES)
        throw new Error('Журнал сценариев превысил допустимый размер');
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, encoded);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
      this.storageError = null;
    } catch (error) {
      this.storageError = readable((error as Error).message, 'Не удалось сохранить сценарии');
      throw new SceneError(`Не удалось сохранить сценарии: ${this.storageError}`, 503);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        /* The successful rename already removed the temporary path. */
      }
    }
  }

  /** @brief Recover interrupted journals as diagnostics only; never resume a stored plan. */
  private load(): void {
    try {
      if (statSync(this.path!).size > MAX_FILE_BYTES) throw new Error('Файл слишком большой');
      const stored: unknown = JSON.parse(readFileSync(this.path!, 'utf8'));
      if (
        !object(stored) ||
        !only(stored, ['version', 'definitions', 'runs']) ||
        stored.version !== 1 ||
        !Array.isArray(stored.definitions) ||
        stored.definitions.length < 3 ||
        stored.definitions.length > MAX_SCENES ||
        !Array.isArray(stored.runs) ||
        stored.runs.length > MAX_RUNS
      )
        throw new Error('Неизвестный формат');
      let normalized = false;
      const definitions: SceneDefinition[] = stored.definitions.map((value: unknown) => {
        if (
          !object(value) ||
          !only(value, [
            'id',
            'name',
            'description',
            'revision',
            'actions',
            'builtin',
            'schedule',
          ]) ||
          !identifier(value.id) ||
          !revision(value.revision) ||
          (value.builtin !== undefined && typeof value.builtin !== 'boolean')
        )
          throw new Error('Некорректное описание сценария');
        const expected = fixedDefinitions(false).find((definition) => definition.id === value.id);
        const legacy = Boolean(
          expected &&
          Object.hasOwn(legacyBuiltinDescriptions, expected.id) &&
          value.description === legacyBuiltinDescriptions[expected.id],
        );
        if (
          expected &&
          (value.name !== expected.name ||
            (value.description !== expected.description && !legacy) ||
            value.builtin === false)
        )
          throw new Error('Основной режим повреждён');
        if (!expected && (value.builtin === true || !String(value.id).startsWith('scene-')))
          throw new Error('Некорректный пользовательский сценарий');
        if (legacy) normalized = true;
        return {
          id: value.id,
          ...this.metadata(value.name, expected ? expected.description : value.description),
          revision: value.revision,
          builtin: Boolean(expected),
          actions: decodeActions(value.actions, value.id),
          schedule: decodeSchedule(value.schedule),
        };
      });
      if (
        new Set(definitions.map((definition) => definition.id)).size !== definitions.length ||
        sceneIds.some((id) => !definitions.some((definition) => definition.id === id))
      )
        throw new Error('Основные режимы отсутствуют или повторяются');
      const runs = stored.runs.map((value: unknown) => this.decodeRun(value));
      if (new Set(runs.map((run) => run.id)).size !== runs.length)
        throw new Error('Повторяется идентификатор запуска');
      let recovered = false;
      for (const run of runs)
        if (run.status === 'running') {
          recovered = true;
          run.status = 'interrupted';
          run.completedAt = new Date().toISOString();
          run.error =
            'Хаб перезапущен; старый сценарий не продолжается, проверьте фактические состояния';
          for (const result of run.results)
            if (result.status === 'pending') {
              result.status = 'unknown';
              result.error = 'До перезапуска результат не был сохранён';
            }
        }
      this.definitions = definitions;
      this.runs = runs;
      if (recovered || normalized) this.persist();
    } catch (error) {
      throw new SceneError(
        `Не удалось прочитать scenes.json; файл сохранён без замены: ${readable((error as Error).message, 'Файл повреждён')}`,
        503,
      );
    }
  }

  private decodeRun(value: unknown): SceneRun {
    if (
      !object(value) ||
      !only(value, [
        'id',
        'sceneId',
        'name',
        'trigger',
        'status',
        'startedAt',
        'completedAt',
        'results',
        'error',
      ]) ||
      !identifier(value.id) ||
      !identifier(value.sceneId) ||
      !text(value.name, 96) ||
      !(
        value.trigger === undefined ||
        value.trigger === 'manual' ||
        value.trigger === 'schedule'
      ) ||
      !runStates.includes(value.status as string) ||
      !text(value.startedAt, 40) ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      !(
        value.completedAt === null ||
        (text(value.completedAt, 40) && Number.isFinite(Date.parse(value.completedAt)))
      ) ||
      !(value.error === undefined || value.error === null || text(value.error, 1024)) ||
      !Array.isArray(value.results) ||
      value.results.length > MAX_RESULTS
    )
      throw new Error('Повреждён журнал запусков');
    const results = value.results.map((result: unknown) => {
      if (
        !object(result) ||
        !only(result, [
          'id',
          'deviceId',
          'deviceName',
          'controller',
          'itemId',
          'itemName',
          'value',
          'source',
          'status',
          'error',
          'commandId',
        ]) ||
        !text(result.id, 128) ||
        !text(result.deviceId, 104) ||
        !text(result.deviceName, 128) ||
        !writable.includes(result.controller as string) ||
        !identifier(result.itemId, 32) ||
        !text(result.itemName, 128) ||
        typeof result.value !== 'boolean' ||
        !['security', 'configured'].includes(result.source as string) ||
        !resultStates.includes(result.status as string) ||
        !(result.error === null || text(result.error, 512)) ||
        !(result.commandId === undefined || text(result.commandId, 64))
      )
        throw new Error('Повреждён результат действия');
      if (value.status !== 'running' && result.status === 'pending')
        throw new Error('Незавершённое действие в закрытом запуске');
      return structuredClone(result) as unknown as SceneActionResult;
    });
    return {
      id: value.id,
      sceneId: value.sceneId,
      name: value.name,
      trigger: (value.trigger as SceneRun['trigger']) ?? 'manual',
      status: value.status as SceneRun['status'],
      startedAt: value.startedAt,
      completedAt: value.completedAt as string | null,
      results,
      error: value.error as string | null | undefined,
    };
  }
}
