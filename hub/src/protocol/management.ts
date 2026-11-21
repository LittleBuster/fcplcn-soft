/** @file Bounded, private configuration RPC; no stored commands or automatic retries. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { EngineSnapshot, ManagementReply, ManagementRequest } from '../../shared/types.js';

const MAX_REQUEST = 40 * 1024;
const MAX_REPLY = 64 * 1024;
const MAX_QUEUE = 8;
const reads = new Set([
  '/config',
  '/status',
  '/board-profiles',
  '/hardware',
  '/controllers',
  '/config/backup',
  '/firmware',
]);
const writes = new Set([
  '/config',
  '/config/restore',
  '/hardware/relay',
  '/hardware/scan',
  '/user',
  '/time',
  '/reboot',
  '/firmware/begin',
  '/firmware/chunk',
  '/firmware/finish',
  '/firmware/abort',
]);

/** Keep the private service surface identical to the explicit PLC service API. */
export function serviceRoute(method: string, path: string): boolean {
  if (method === 'GET')
    return (
      reads.has(path) || /^\/controllers\/(sockets|lights|meteo|thermostats|security)$/.test(path)
    );
  return (
    method === 'POST' &&
    (writes.has(path) ||
      /^\/controllers\/(sockets|lights|meteo|thermostats|security)$/.test(path) ||
      /^\/controllers\/(sockets|lights)\/state$/.test(path) ||
      path === '/controllers/thermostats/enabled' ||
      path === '/controllers/security/armed' ||
      path === '/controllers/meteo/scan' ||
      path === '/controllers/security/scan')
  );
}

export class ManagementError extends Error {
  constructor(
    message: string,
    readonly statusCode = 503,
    readonly unknown = false,
  ) {
    super(message);
  }
}

interface Entry {
  deviceId: string;
  bootId: string;
  requestId: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  expires: number;
  sequence: number;
  sent: boolean;
  resolve(reply: ManagementReply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort(): void;
}

export class ManagementClient {
  private readonly queues = new Map<string, Entry[]>();
  private readonly sequences = new Map<string, { bootId: string; sequence: number }>();
  constructor(
    private readonly snapshot: () => EngineSnapshot,
    private readonly publish: (
      deviceId: string,
      request: ManagementRequest,
      expiry: number,
    ) => Promise<void>,
    private readonly timeoutMs = 8000,
    private readonly now = () => performance.now(),
  ) {}

  busy(deviceId: string): boolean {
    return Boolean(this.queues.get(deviceId)?.length);
  }

  request(
    deviceId: string,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    budgetMs?: number,
  ): Promise<ManagementReply> {
    const timeoutMs =
      budgetMs === undefined ? this.timeoutMs : Math.min(this.timeoutMs, Math.floor(budgetMs));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 250)
      return Promise.reject(new ManagementError('Срок запроса истёк до отправки', 408));
    if (!serviceRoute(method, path))
      return Promise.reject(new ManagementError('Метод настройки PLC не поддерживается', 404));
    const snapshot = this.snapshot(),
      device = snapshot.devices.find((entry) => entry.id === deviceId);
    if (
      !snapshot.broker.connected ||
      !device?.online ||
      !device.bootId ||
      device.uptimeSec === null
    )
      return Promise.reject(new ManagementError('Нет свежей связи с PLC. Настройки не отправлены'));
    if (!device.management?.supported)
      return Promise.reject(
        new ManagementError(
          'Обновите прошивку PLC: настройка через хаб ещё не поддерживается',
          426,
        ),
      );
    if (signal?.aborted)
      return Promise.reject(new ManagementError('Запрос отменён до отправки', 499));
    if (method === 'GET' && body !== undefined)
      return Promise.reject(new ManagementError('Чтение настроек не принимает тело запроса', 400));
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body)))
      return Promise.reject(new ManagementError('Нужен объект настроек', 400));
    const queue = this.queues.get(deviceId) || [];
    if (
      queue.length >= MAX_QUEUE ||
      [...this.queues.values()].reduce((count, rows) => count + rows.length, 0) >= 128
    )
      return Promise.reject(
        new ManagementError('PLC занят. Повторите после завершения текущей операции', 429),
      );
    let copied: Record<string, unknown> | undefined;
    try {
      if (body !== undefined) {
        const text = JSON.stringify(body);
        if (Buffer.byteLength(text) > MAX_REQUEST - 512) throw new Error('size');
        copied = JSON.parse(text) as Record<string, unknown>;
      }
    } catch {
      return Promise.reject(
        new ManagementError('Настройки слишком велики или имеют неверный формат', 413),
      );
    }
    return new Promise<ManagementReply>((resolve, reject) => {
      const entry: Entry = {
        deviceId,
        bootId: device.bootId!,
        requestId: randomUUID(),
        method,
        path,
        body: copied,
        expires: this.now() + timeoutMs,
        sequence: 0,
        sent: false,
        resolve,
        reject,
        timer: setTimeout(
          () =>
            this.fail(
              entry,
              new ManagementError(
                entry.sent
                  ? 'PLC не подтвердил операцию. Загрузите актуальные настройки перед повтором'
                  : 'PLC занят: запрос истёк до отправки',
                entry.sent ? 504 : 503,
                entry.sent && entry.method === 'POST',
              ),
            ),
          timeoutMs,
        ),
        signal,
        abort: () =>
          this.fail(
            entry,
            new ManagementError(
              entry.sent
                ? 'Запрос отменён; результат операции неизвестен'
                : 'Запрос отменён до отправки',
              499,
              entry.sent && entry.method === 'POST',
            ),
          ),
      };
      queue.push(entry);
      this.queues.set(deviceId, queue);
      signal?.addEventListener('abort', entry.abort, { once: true });
      if (queue.length === 1) this.dispatch(entry);
    });
  }

  /** Accept only a live, fully correlated private reply. Its data never enters telemetry. */
  receive(deviceId: string, payload: Uint8Array | string, retained = false): void {
    if (retained || Buffer.byteLength(payload) > MAX_REPLY) return;
    const entry = this.queues.get(deviceId)?.[0];
    if (!entry?.sent) return;
    let reply: ManagementReply;
    try {
      reply = JSON.parse(
        typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'),
      ) as ManagementReply;
    } catch {
      return;
    }
    if (
      !reply ||
      reply.schemaVersion !== 1 ||
      reply.requestId !== entry.requestId ||
      reply.bootId !== entry.bootId ||
      reply.sequence !== entry.sequence ||
      !Number.isInteger(reply.status) ||
      reply.status < 200 ||
      reply.status > 599 ||
      !reply.data ||
      typeof reply.data !== 'object'
    )
      return;
    if (this.now() >= entry.expires) {
      this.fail(
        entry,
        new ManagementError(
          'Ответ PLC пришёл после срока запроса; проверьте актуальные настройки',
          504,
          entry.method === 'POST',
        ),
      );
      return;
    }
    this.remove(entry);
    entry.resolve(reply);
  }

  /** Reboots/offline observations cancel queued work instead of moving it onto a new boot. */
  observe(): void {
    const snapshot = this.snapshot();
    for (const [id, entries] of this.queues) {
      const device = snapshot.devices.find((device) => device.id === id);
      for (const entry of [...entries])
        if (!snapshot.broker.connected || !device?.online || device.bootId !== entry.bootId)
          this.fail(
            entry,
            new ManagementError(
              'Связь с PLC потеряна или PLC перезапущен. Запрос не будет повторён',
              503,
              entry.sent && entry.method === 'POST',
            ),
          );
    }
  }

  disconnect(): void {
    for (const entries of [...this.queues.values()])
      for (const entry of [...entries])
        this.fail(
          entry,
          new ManagementError(
            'Связь с брокером потеряна. Запрос не будет повторён',
            503,
            entry.sent && entry.method === 'POST',
          ),
        );
  }

  private dispatch(entry: Entry): void {
    const snapshot = this.snapshot(),
      device = snapshot.devices.find((device) => device.id === entry.deviceId);
    const remaining = Math.floor(entry.expires - this.now());
    if (
      !snapshot.broker.connected ||
      !device?.online ||
      device.bootId !== entry.bootId ||
      device.uptimeSec === null ||
      remaining < 250
    ) {
      this.fail(
        entry,
        new ManagementError('PLC недоступен или срок запроса истёк. Настройки не отправлены'),
      );
      return;
    }
    const reserved = this.sequences.get(entry.deviceId);
    const sequence =
      Math.max(
        reserved?.bootId === entry.bootId ? reserved.sequence : 0,
        device.management?.sequence || 0,
      ) + 1;
    if (sequence > 0xffff_ffff) {
      this.fail(entry, new ManagementError('Исчерпан счётчик настройки; перезапустите PLC', 409));
      return;
    }
    const packet: ManagementRequest = {
      schemaVersion: 1,
      requestId: entry.requestId,
      bootId: entry.bootId,
      sequence,
      expiresAtUptimeMs: device.uptimeSec * 1000 + remaining,
      method: entry.method,
      path: entry.path,
      ...(entry.body !== undefined ? { body: entry.body } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(packet)) > MAX_REQUEST) {
      this.fail(entry, new ManagementError('Настройки превышают размер пакета PLC', 413));
      return;
    }
    this.sequences.set(entry.deviceId, { bootId: entry.bootId, sequence });
    entry.sequence = sequence;
    entry.sent = true;
    void this.publish(entry.deviceId, packet, Math.max(1, Math.ceil(remaining / 1000))).catch(() =>
      this.fail(
        entry,
        new ManagementError(
          'Отправка не подтверждена. Загрузите актуальную конфигурацию; автоматического повтора нет',
          503,
          entry.method === 'POST',
        ),
      ),
    );
  }

  private fail(entry: Entry, error: Error): void {
    if (!this.queues.get(entry.deviceId)?.includes(entry)) return;
    this.remove(entry);
    entry.reject(error);
  }

  private remove(entry: Entry): void {
    const queue = this.queues.get(entry.deviceId);
    if (!queue) return;
    const first = queue[0] === entry;
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    if (!queue.length) this.queues.delete(entry.deviceId);
    else if (first) {
      const next = queue[0];
      queueMicrotask(() => {
        if (this.queues.get(entry.deviceId)?.[0] === next && !next.sent) this.dispatch(next);
      });
    }
  }
}
