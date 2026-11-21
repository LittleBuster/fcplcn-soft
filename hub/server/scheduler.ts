/** @file Bounded, persistent wall-clock scheduling with no catch-up or command replay. */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Scenes } from './scenes.js';
import type {
  SceneDefinition,
  SceneSchedule,
  ScenesSnapshot,
  ScheduleEvent,
} from '../shared/types.js';

type SchedulerSnapshot = NonNullable<ScenesSnapshot['scheduler']>;
interface StoredScheduler {
  version: 1;
  claims: string[];
  events: ScheduleEvent[];
}
interface Options {
  directory?: string;
  now?: () => Date;
  canRun?: () => boolean;
}
interface LocalMinute {
  date: string;
  time: string;
  day: number;
}

const MAX_CLAIMS = 4096;
const MAX_EVENTS = 30;
const MAX_DUE = 32;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const minuteOf = (value: number) => Math.floor(value / 60_000);
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : 'Неизвестная ошибка').slice(0, 1000);
const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** @brief Format a scheduled local minute explicitly, independent of the host's timezone. */
function localMinute(now: Date, schedule: SceneSchedule): LocalMinute {
  if (
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time) ||
    !Array.isArray(schedule.days) ||
    !schedule.days.length ||
    schedule.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  )
    throw new Error('Некорректное время или дни расписания');
  const formatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone: schedule.timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute,
    day: weekdays[parts.weekday],
  };
}

/** @brief Validate bounded on-disk claims before trusting them as duplicate-execution barriers. */
function validStore(value: unknown): value is StoredScheduler {
  if (!value || typeof value !== 'object') return false;
  const record = value as StoredScheduler;
  return (
    record.version === 1 &&
    Array.isArray(record.claims) &&
    record.claims.length <= MAX_CLAIMS &&
    record.claims.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 512) &&
    new Set(record.claims).size === record.claims.length &&
    Array.isArray(record.events) &&
    record.events.length <= MAX_EVENTS &&
    record.events.every(
      (event) =>
        event &&
        typeof event.sceneId === 'string' &&
        event.sceneId.length <= 96 &&
        typeof event.name === 'string' &&
        event.name.length <= 256 &&
        typeof event.dueAt === 'string' &&
        Number.isFinite(Date.parse(event.dueAt)) &&
        ['started', 'skipped', 'error'].includes(event.status) &&
        (event.reason === null ||
          (typeof event.reason === 'string' && event.reason.length <= 2048)),
    )
  );
}

/** @brief Execute at most once per local scheduled minute, claiming durable intent before action. */
export class SceneScheduler {
  private readonly now: () => Date;
  private readonly canRun: () => boolean;
  private readonly file: string | null;
  private claims: string[] = [];
  private claimed = new Set<string>();
  private events: ScheduleEvent[] = [];
  private error: string | null = null;
  private loadFault = false;
  private running = false;
  private lastMinute: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly scenes: Scenes,
    private readonly options: Options = {},
  ) {
    this.now = options.now || (() => new Date());
    this.canRun = options.canRun || (() => true);
    this.file = options.directory ? join(options.directory, 'scheduler.json') : null;
    this.load();
  }

  /** Start a separate lightweight timer; the current startup minute is always skipped. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMinute = null;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  /** Stop future dispatch; an already accepted scene remains owned by the scene executor. */
  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Return owned diagnostics; callers cannot mutate scheduler history or barriers. */
  snapshot(): SchedulerSnapshot {
    return {
      running: this.running,
      error: this.error,
      events: this.events.map((event) => ({ ...event })),
    };
  }

  /** Observe a UTC-minute transition; late, interrupted and unavailable work is consumed, never queued. */
  tick(): void {
    if (!this.running) return;
    const now = this.now();
    const milliseconds = now.getTime();
    if (!Number.isFinite(milliseconds)) {
      this.error = 'Недостоверные системные часы хаба';
      return;
    }
    const minute = minuteOf(milliseconds);
    if (minute === this.lastMinute) return;
    const previous = this.lastMinute;
    this.lastMinute = minute;
    const skip: string | null =
      previous === null
        ? 'Минута запуска хаба пропущена'
        : minute !== previous + 1
          ? 'Пропуск после остановки или перевода часов; догоняющий запуск отключён'
          : milliseconds - minute * 60_000 >= 10_000
            ? 'Поздний отсчёт; догоняющий запуск отключён'
            : null;
    if (this.loadFault) {
      this.load();
      if (this.loadFault) return;
    }
    let definitions: SceneDefinition[];
    try {
      definitions = this.scenes.snapshot().definitions;
    } catch (error) {
      this.error = 'Не удалось прочитать сценарии: ' + reason(error);
      return;
    }
    let launched = false;
    let due = 0;
    for (const scene of definitions.slice(0, 256)) {
      const schedule = scene.schedule;
      if (!schedule?.enabled) continue;
      let local: LocalMinute;
      try {
        local = localMinute(now, schedule);
      } catch (error) {
        this.error = 'Расписание «' + scene.name + '»: ' + reason(error);
        continue;
      }
      if (local.time !== schedule.time || !schedule.days.includes(local.day)) continue;
      const key = JSON.stringify([scene.id, local.date, local.time, schedule.timeZone]);
      if (this.claimed.has(key)) continue;
      ++due;
      let blocked = skip;
      if (due > MAX_DUE) blocked = 'Лимит одновременных расписаний: 32';
      if (!blocked && (launched || this.scenes.snapshot().activeRun))
        blocked = 'Другой сценарий выполняется; запуск пропущен без очереди';
      if (!blocked) {
        try {
          if (!this.canRun())
            blocked = 'Управление занято или недоступно; запуск пропущен без очереди';
        } catch (error) {
          blocked = 'Не удалось проверить готовность: ' + reason(error);
        }
      }
      const event: ScheduleEvent = {
        sceneId: scene.id,
        name: scene.name,
        dueAt: new Date(minute * 60_000).toISOString(),
        status: blocked ? 'skipped' : 'started',
        reason: blocked,
      };
      // Even skipped work is consumed so reconnects and clock rollback cannot replay it.
      this.claims.push(key);
      this.claims = this.claims.slice(-MAX_CLAIMS);
      this.claimed = new Set(this.claims);
      this.events.unshift(event);
      this.events = this.events.slice(0, MAX_EVENTS);
      if (!this.persist()) {
        event.status = 'error';
        event.reason = this.error;
        break;
      }
      if (blocked) continue;
      launched = true;
      try {
        void Promise.resolve(this.scenes.run(scene.id, 'schedule')).catch((error: unknown) => {
          event.status = 'error';
          event.reason = 'Сценарий не запущен: ' + reason(error);
          this.persist();
        });
      } catch (error) {
        event.status = 'error';
        event.reason = 'Сценарий не запущен: ' + reason(error);
        this.persist();
      }
    }
  }

  /** Load durable duplicate barriers; unreadable state disables dispatch until it can be read safely. */
  private load(): void {
    if (!this.file) return;
    try {
      const bytes = readFileSync(this.file);
      if (bytes.length > MAX_STORE_BYTES) throw new Error('Слишком большой файл scheduler.json');
      const stored: unknown = JSON.parse(bytes.toString('utf8'));
      if (!validStore(stored)) throw new Error('Некорректный файл scheduler.json');
      this.claims = stored.claims;
      this.claimed = new Set(stored.claims);
      this.events = stored.events;
      this.error = null;
      this.loadFault = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loadFault = false;
        this.error = null;
        return;
      }
      this.loadFault = true;
      this.error = 'Расписание остановлено: не удалось прочитать scheduler.json: ' + reason(error);
    }
  }

  /** Commit the claim atomically before dispatch; a storage error never permits an action. */
  private persist(): boolean {
    if (!this.file) {
      this.error = null;
      return true;
    }
    const temporary = this.file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    let descriptor: number | null = null;
    try {
      mkdirSync(this.options.directory!, { recursive: true, mode: 0o700 });
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(
        descriptor,
        JSON.stringify({ version: 1, claims: this.claims, events: this.events }),
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, this.file);
      descriptor = openSync(this.options.directory!, 'r');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      this.error = null;
      return true;
    } catch (error) {
      this.error =
        'Запуск по расписанию остановлен: не удалось сохранить scheduler.json: ' + reason(error);
      return false;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        /* A successful rename already removed the temporary path. */
      }
    }
  }
}
