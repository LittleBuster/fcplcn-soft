/** @file Private WAN MQTT request/reply bridge. No offline command outbox or transparent LAN bridge. */
import mqtt, { type MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  CLOUD_MAX_PACKET,
  CLOUD_TOPIC_PREFIX,
  cloudHubId,
  cloudObject,
  cloudPermitted,
  type CloudActor,
  type CloudHubView,
  type CloudMethod,
  type CloudReply,
  type CloudRequest,
  type CloudState,
} from '../../hub/shared/cloud.js';
import { checkedBrokerUrl } from './broker.js';

export interface CloudBridgeOptions {
  brokerUrl: string;
  username: string;
  password: string;
  ca?: string;
  allowInsecureLoopback?: boolean;
  authorizeHub?: (hubId: string) => Promise<boolean>;
  onSnapshot?: (hubId: string, view: CloudHubView) => void | Promise<void>;
  staleAfterMs?: number;
  requestTimeoutMs?: number;
}
export class CloudBridgeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 503,
    readonly unknown = false,
  ) {
    super(message);
  }
}
interface Observation {
  state: CloudState;
  at: number;
  wall: string;
  counter: number;
  retired: Set<string>;
}
interface Entry {
  hubId: string;
  sessionId: string;
  id: string;
  method: CloudMethod;
  path: string;
  body?: Record<string, unknown>;
  actor: CloudActor;
  sequence: number;
  expires: number;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: { status: number; data: unknown }): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  cancel(): void;
}
/** Public snapshot DTO omits credentials even if a future producer accidentally attaches them. */
function publicSnapshot(value: unknown): CloudState['snapshot'] {
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean);
    if (!cloudObject(item)) return item;
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !/password|token|secret|credential|privatekey|^keys$/i.test(key))
        .map(([key, child]) => [key, clean(child)]),
    );
  };
  return clean(value) as CloudState['snapshot'];
}
export class CloudBridge {
  private client: MqttClient | null = null;
  private ready = false;
  private readonly observations = new Map<string, Observation>();
  private readonly queues = new Map<string, Entry[]>();
  private readonly receiving = new Map<string, Promise<void>>();
  private readonly revoked = new Set<string>();
  constructor(private readonly options: CloudBridgeOptions) {
    checkedBrokerUrl(options.brokerUrl, options.allowInsecureLoopback);
  }
  async start(): Promise<void> {
    if (this.client) return;
    const client = mqtt.connect(this.options.brokerUrl, {
      protocolVersion: 5,
      clientId: 'fcplcn-cloud-bridge-' + randomUUID(),
      username: this.options.username,
      password: this.options.password,
      clean: true,
      queueQoSZero: false,
      reconnectPeriod: 1000,
      connectTimeout: 10000,
      rejectUnauthorized: true,
      ...(this.options.ca ? { ca: this.options.ca } : {}),
      properties: { sessionExpiryInterval: 0, maximumPacketSize: CLOUD_MAX_PACKET },
    });
    this.client = client;
    const disconnect = () => {
      this.ready = false;
      for (const id of this.queues.keys())
        this.cancelHub(id, 'Связь с облачным брокером потеряна; команда не повторяется');
      for (const row of this.observations.values()) row.at = -Infinity;
    };
    client.on('offline', disconnect);
    client.on('close', disconnect);
    client.on('error', () => {});
    client.on('connect', () => {
      client.subscribe(
        [
          `${CLOUD_TOPIC_PREFIX}/+/hello`,
          `${CLOUD_TOPIC_PREFIX}/+/state`,
          `${CLOUD_TOPIC_PREFIX}/+/reply`,
        ],
        { qos: 0, rap: true, rh: 2 },
        (error, grants) => {
          this.ready = !error && grants?.length === 3 && grants.every((row) => row.qos <= 2);
        },
      );
    });
    client.on('message', (topic, payload, packet) => {
      if (packet.retain || payload.length > CLOUD_MAX_PACKET || !this.ready) return;
      const match = /^fcplcn-cloud\/v1\/hubs\/([a-zA-Z0-9_-]{1,80})\/(hello|state|reply)$/.exec(
        topic,
      );
      if (!match) return;
      let value: unknown;
      try {
        value = JSON.parse(payload.toString());
      } catch {
        return;
      }
      if (match[2] === 'reply') {
        this.reply(match[1], value);
        return;
      }
      // Serialize authorization and state acceptance so an older async DB result cannot replace a newer boot.
      const previous = this.receiving.get(match[1]) || Promise.resolve();
      const next = previous
        .then(() => this.observe(match[1], value))
        .catch(() => {})
        .finally(() => {
          if (this.receiving.get(match[1]) === next) this.receiving.delete(match[1]);
        });
      this.receiving.set(match[1], next);
    });
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 11000;
      const timer = setInterval(() => {
        if (this.ready) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() >= until) {
          clearInterval(timer);
          reject(new CloudBridgeError('Облачный MQTT-канал не запущен'));
        }
      }, 20);
    });
  }
  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.ready = false;
    for (const id of this.queues.keys()) this.cancelHub(id, 'Облачный канал остановлен');
    if (client) await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
  }
  snapshot(hubId: string): CloudHubView {
    const row = this.observations.get(hubId);
    return {
      online: Boolean(
        this.ready &&
        !this.revoked.has(hubId) &&
        row &&
        performance.now() - row.at <= (this.options.staleAfterMs ?? 15000),
      ),
      sessionId: row?.state.sessionId || null,
      lastSeenAt: row?.wall || null,
      snapshot: row ? structuredClone(row.state.snapshot) : null,
    };
  }
  revoke(hubId: string): void {
    this.revoked.add(hubId);
    this.observations.delete(hubId);
    this.cancelHub(hubId, 'Доступ хаба отозван');
  }
  private async observe(hubId: string, value: unknown): Promise<void> {
    if (
      this.revoked.has(hubId) ||
      !cloudObject(value) ||
      value.version !== 1 ||
      value.hubId !== hubId ||
      typeof value.sessionId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,96}$/.test(value.sessionId) ||
      !Number.isSafeInteger(value.sequence) ||
      Number(value.sequence) < 1 ||
      !Number.isSafeInteger(value.uptimeMs) ||
      Number(value.uptimeMs) < 0 ||
      !Number.isInteger(value.requestSequence) ||
      Number(value.requestSequence) < 0 ||
      Number(value.requestSequence) > 0xffffffff ||
      !cloudObject(value.snapshot) ||
      !Array.isArray(value.snapshot.devices) ||
      !cloudObject(value.snapshot.product) ||
      value.snapshot.product.name !== 'FCPLCn'
    )
      return;
    if (this.options.authorizeHub && !(await this.options.authorizeHub(hubId))) return;
    if (!this.ready || this.revoked.has(hubId)) return;
    const previous = this.observations.get(hubId);
    if (previous?.retired.has(value.sessionId)) return;
    if (
      previous?.state.sessionId === value.sessionId &&
      Number(value.sequence) <= previous.state.sequence
    )
      return;
    const retired = previous?.retired || new Set<string>();
    if (previous && previous.state.sessionId !== value.sessionId) {
      retired.add(previous.state.sessionId);
      if (retired.size > 64) retired.delete(retired.values().next().value!);
      this.cancelHub(hubId, 'Хаб переподключился; прежняя команда не повторяется');
    }
    const state = { ...value, snapshot: publicSnapshot(value.snapshot) } as unknown as CloudState;
    this.observations.set(hubId, {
      state,
      at: performance.now(),
      wall: new Date().toISOString(),
      counter: Math.max(
        previous?.state.sessionId === value.sessionId ? previous.counter : 0,
        state.requestSequence,
      ),
      retired,
    });
    try {
      await this.options.onSnapshot?.(hubId, this.snapshot(hubId));
    } catch {
      /* Telemetry storage never becomes a command replay or blocks the uplink. */
    }
  }
  async request(
    hubId: string,
    method: CloudMethod,
    path: string,
    body: Record<string, unknown> | undefined,
    actor: CloudActor,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: unknown }> {
    if (!cloudHubId(hubId) || !cloudPermitted(actor, method, path, body))
      throw new CloudBridgeError('Нет разрешения на эту операцию', 403);
    if (this.options.authorizeHub && !(await this.options.authorizeHub(hubId)))
      throw new CloudBridgeError('Подключение хаба отозвано', 403);
    const view = this.snapshot(hubId);
    if (!view.online || !view.sessionId || signal?.aborted)
      throw new CloudBridgeError('Нет свежей связи с хабом. Команда не отправлена');
    const queue = this.queues.get(hubId) || [];
    if (
      queue.length >= 8 ||
      [...this.queues.values()].reduce((count, rows) => count + rows.length, 0) >= 128
    )
      throw new CloudBridgeError('Хаб занят', 429);
    if (Buffer.byteLength(JSON.stringify(body ?? {})) > 48 * 1024)
      throw new CloudBridgeError('Слишком большой запрос', 413);
    return new Promise((resolve, reject) => {
      const entry: Entry = {
        hubId,
        sessionId: view.sessionId!,
        id: randomUUID(),
        method,
        path,
        ...(body === undefined ? {} : { body: structuredClone(body) }),
        actor: structuredClone(actor),
        sequence: 0,
        expires: performance.now() + (this.options.requestTimeoutMs ?? 10000),
        sent: false,
        resolve,
        reject,
        signal,
        timer: setTimeout(
          () =>
            this.fail(
              entry,
              new CloudBridgeError(
                entry.sent
                  ? 'Хаб не подтвердил результат. Повтора нет; обновите состояние'
                  : 'Запрос истёк до отправки',
                entry.sent ? 504 : 503,
                entry.sent && entry.method !== 'GET',
              ),
            ),
          this.options.requestTimeoutMs ?? 10000,
        ),
        cancel: () =>
          this.fail(
            entry,
            new CloudBridgeError(
              'Запрос отменён; проверьте актуальное состояние',
              499,
              entry.sent && entry.method !== 'GET',
            ),
          ),
      };
      queue.push(entry);
      this.queues.set(hubId, queue);
      signal?.addEventListener('abort', entry.cancel, { once: true });
      if (queue.length === 1) this.dispatch(entry);
    });
  }
  private dispatch(entry: Entry): void {
    const row = this.observations.get(entry.hubId),
      remaining = Math.floor(entry.expires - performance.now());
    if (
      !this.client?.connected ||
      !this.ready ||
      !this.snapshot(entry.hubId).online ||
      row?.state.sessionId !== entry.sessionId ||
      remaining < 250
    ) {
      this.fail(entry, new CloudBridgeError('Хаб недоступен или срок запроса истёк до отправки'));
      return;
    }
    entry.sequence = ++row.counter;
    const request: CloudRequest = {
      version: 1,
      id: entry.id,
      hubId: entry.hubId,
      sessionId: entry.sessionId,
      sequence: entry.sequence,
      expiresAtUptimeMs: row.state.uptimeMs + Math.floor(performance.now() - row.at) + remaining,
      method: entry.method,
      path: entry.path,
      ...(entry.body === undefined ? {} : { body: entry.body }),
      actor: entry.actor,
    };
    entry.sent = true;
    this.client.publish(
      `${CLOUD_TOPIC_PREFIX}/${entry.hubId}/request`,
      JSON.stringify(request),
      {
        qos: 0,
        retain: false,
        properties: { messageExpiryInterval: Math.max(1, Math.ceil(remaining / 1000)) },
      },
      (error) => {
        if (error)
          this.fail(
            entry,
            new CloudBridgeError(
              'Отправка не подтверждена; результат неизвестен',
              503,
              entry.method !== 'GET',
            ),
          );
      },
    );
  }
  private reply(hubId: string, value: unknown): void {
    const entry = this.queues.get(hubId)?.[0];
    if (
      !entry?.sent ||
      !cloudObject(value) ||
      value.version !== 1 ||
      value.hubId !== hubId ||
      value.id !== entry.id ||
      value.sessionId !== entry.sessionId ||
      value.sequence !== entry.sequence ||
      !Number.isInteger(value.status) ||
      Number(value.status) < 200 ||
      Number(value.status) > 599 ||
      !('data' in value)
    )
      return;
    if (performance.now() >= entry.expires) {
      this.fail(
        entry,
        new CloudBridgeError('Ответ пришёл после срока. Повтора нет', 504, entry.method !== 'GET'),
      );
      return;
    }
    this.remove(entry);
    entry.resolve({ status: Number(value.status), data: value.data });
  }
  private remove(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.cancel);
    const queue = this.queues.get(entry.hubId);
    if (!queue) return;
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    if (!queue.length) this.queues.delete(entry.hubId);
    else if (index === 0)
      queueMicrotask(() => {
        if (this.queues.get(entry.hubId)?.[0] === queue[0]) this.dispatch(queue[0]);
      });
  }
  private fail(entry: Entry, error: Error): void {
    if (!this.queues.get(entry.hubId)?.includes(entry)) return;
    this.remove(entry);
    entry.reject(error);
  }
  private cancelHub(hubId: string, message: string): void {
    const rows = this.queues.get(hubId);
    if (!rows) return;
    this.queues.delete(hubId);
    for (const row of rows) {
      clearTimeout(row.timer);
      row.signal?.removeEventListener('abort', row.cancel);
      row.reject(new CloudBridgeError(message, 503, row.sent && row.method !== 'GET'));
    }
  }
}
