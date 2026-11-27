/** @file Outbound cloud uplink. PLC traffic and autonomous logic remain entirely local. */
import mqtt, { type MqttClient } from 'mqtt';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  CLOUD_MAX_PACKET,
  CLOUD_TOPIC_PREFIX,
  cloudObject,
  cloudPermitted,
  type CloudReply,
  type CloudRequest,
  type CloudState,
  type HubCloudView,
} from '../../shared/cloud.js';
import { HubControl } from '../control.js';
import { HubCloudStore, HubCloudError, checkedCloudOrigin } from './store.js';
import {
  cloudActivityActor,
  cloudActivityEntry,
  cloudSceneActivity,
  withActivity,
} from '../activity-context.js';

interface Context {
  generation: number;
  sessionId: string;
  client: MqttClient;
  abort: AbortController;
  ready: boolean;
  sequence: number;
  requestSequence: number;
  pending: number;
  chain: Promise<void>;
  cache: Map<string, { signature: string; reply: CloudReply }>;
}
export interface HubCloudOptions {
  allowInsecureLoopback?: boolean;
  request?: typeof fetch;
  publishIntervalMs?: number;
}
/** Receive a bounded secret-bearing enrollment response; never propagate fetch URL errors. */
async function responseJson(response: Response, maximum = 65536): Promise<unknown> {
  if (!response.body) throw new HubCloudError('Облако вернуло пустой ответ', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new HubCloudError('Слишком большой ответ облака', 502);
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    reader.releaseLock();
  }
}
export class HubCloud {
  private context: Context | null = null;
  private generation = 0;
  private readonly began = performance.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pairing = false;
  private readonly request: typeof fetch;
  private status: HubCloudView['status'] = {
    state: 'disabled',
    error: null,
    lastConnectedAt: null,
    lastPublishedAt: null,
  };
  constructor(
    private readonly store: HubCloudStore,
    private readonly control: HubControl,
    private readonly options: HubCloudOptions = {},
  ) {
    this.request = options.request || fetch;
  }
  private uptime(): number {
    return Math.floor(performance.now() - this.began);
  }
  snapshot(): HubCloudView {
    return {
      config: this.store.publicConfig(),
      status: this.store.error
        ? { ...this.status, state: 'error', error: this.store.error }
        : { ...this.status },
    };
  }
  sessionId(): string | null {
    return this.status.state === 'online' && this.context?.ready ? this.context.sessionId : null;
  }
  start(): void {
    this.reload();
  }
  private current(context: Context): boolean {
    return (
      this.context === context &&
      context.generation === this.generation &&
      !context.abort.signal.aborted &&
      this.store.privateConfig().enabled
    );
  }
  private async retire(): Promise<void> {
    this.generation++;
    const context = this.context;
    this.context = null;
    context?.abort.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (context)
      await new Promise<void>((resolve) => context.client.end(true, {}, () => resolve()));
  }
  async stop(): Promise<void> {
    await this.retire();
    this.status.state = 'disabled';
  }
  reload(): void {
    // Abort synchronously before creating a replacement client, even when the old end callback is delayed.
    this.generation++;
    const old = this.context;
    this.context = null;
    old?.abort.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    old?.client.end(true);
    const config = this.store.privateConfig();
    this.status = {
      state: this.store.error ? 'error' : 'disabled',
      error: this.store.error,
      lastConnectedAt: null,
      lastPublishedAt: null,
    };
    if (!config.enabled || !config.claim || this.store.error) return;
    const credentials = config.claim.broker;
    this.status.state = 'connecting';
    const client = mqtt.connect(credentials.brokerUrl, {
      protocolVersion: 5,
      clientId: config.claim.hubId,
      username: credentials.username,
      password: credentials.password,
      clean: true,
      queueQoSZero: false,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      rejectUnauthorized: true,
      ...(credentials.ca ? { ca: credentials.ca } : {}),
      properties: { sessionExpiryInterval: 0, maximumPacketSize: CLOUD_MAX_PACKET },
    });
    const context: Context = {
      generation: this.generation,
      sessionId: '',
      client,
      abort: new AbortController(),
      ready: false,
      sequence: 0,
      requestSequence: 0,
      pending: 0,
      chain: Promise.resolve(),
      cache: new Map(),
    };
    this.context = context;
    const offline = () => {
      if (!this.current(context)) return;
      context.ready = false;
      context.abort.abort();
      context.abort = new AbortController();
      context.sessionId = '';
      context.cache.clear();
      context.requestSequence = 0;
      this.status = {
        ...this.status,
        state: 'connecting',
        error: 'Связь с облаком потеряна. Локальное управление продолжает работать.',
      };
    };
    client.on('offline', offline);
    client.on('close', offline);
    client.on('error', () => {
      if (this.current(context))
        this.status = {
          ...this.status,
          state: 'error',
          error: 'Не удалось подключиться к облачному брокеру',
        };
    });
    client.on('connect', () => {
      if (!this.current(context)) return;
      context.sessionId = randomUUID();
      context.sequence = 0;
      context.requestSequence = 0;
      context.cache.clear();
      client.subscribe(
        `${CLOUD_TOPIC_PREFIX}/${config.claim!.hubId}/request`,
        { qos: 0, rap: true, rh: 2 },
        (error, grants) => {
          if (!this.current(context)) return;
          context.ready = !error && grants?.length === 1 && grants[0].qos <= 2;
          if (!context.ready) {
            this.status = {
              ...this.status,
              state: 'error',
              error: 'Брокер не разрешил канал управления хабом',
            };
            return;
          }
          this.status = {
            state: 'online',
            error: null,
            lastConnectedAt: new Date().toISOString(),
            lastPublishedAt: null,
          };
          this.publish(context, 'hello');
        },
      );
    });
    client.on('message', (topic, payload, packet) => {
      if (
        !this.current(context) ||
        !context.ready ||
        packet.retain ||
        topic !== `${CLOUD_TOPIC_PREFIX}/${config.claim!.hubId}/request` ||
        payload.length > 64 * 1024 ||
        context.pending >= 8
      )
        return;
      let value: unknown;
      try {
        value = JSON.parse(payload.toString());
      } catch {
        return;
      }
      if (!cloudObject(value)) return;
      const session = context.sessionId,
        signal = context.abort.signal;
      context.pending++;
      context.chain = context.chain
        .then(() => this.consume(context, session, signal, value as unknown as CloudRequest))
        .catch(() => {})
        .finally(() => context.pending--);
    });
    this.timer = setInterval(
      () => this.publish(context, 'state'),
      this.options.publishIntervalMs ?? 2000,
    ).unref();
  }
  private publish(context: Context, kind: 'hello' | 'state'): void {
    const config = this.store.privateConfig();
    if (
      !this.current(context) ||
      !context.ready ||
      !context.client.connected ||
      !config.claim ||
      !context.sessionId
    )
      return;
    const snapshot = structuredClone(this.control.overview());
    // Full history is fetched explicitly. Periodic WAN snapshots keep a bounded recent summary.
    snapshot.commands = snapshot.commands.slice(0, 30).map(cloudActivityEntry);
    snapshot.outages = snapshot.outages?.slice(0, 30);
    snapshot.scenes = cloudSceneActivity(snapshot.scenes);
    snapshot.scenes.runs = snapshot.scenes.runs
      .slice(0, 5)
      .map((run) => ({ ...run, results: run.results.slice(0, 128) }));
    const state: CloudState = {
      version: 1,
      hubId: config.claim.hubId,
      sessionId: context.sessionId,
      sequence: ++context.sequence,
      uptimeMs: this.uptime(),
      requestSequence: context.requestSequence,
      snapshot,
    };
    let encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > CLOUD_MAX_PACKET) {
      state.snapshot.scenes.runs = [];
      state.snapshot.commands = [];
      state.snapshot.outages = [];
      (state.snapshot as unknown as Record<string, unknown>).cloudTruncated = true;
      encoded = JSON.stringify(state);
    }
    if (Buffer.byteLength(encoded) > CLOUD_MAX_PACKET) {
      state.snapshot.devices = state.snapshot.devices.slice(0, 32);
      state.snapshot.scenes.definitions = state.snapshot.scenes.definitions.slice(0, 8);
      encoded = JSON.stringify(state);
    }
    if (Buffer.byteLength(encoded) > CLOUD_MAX_PACKET) return;
    context.client.publish(
      `${CLOUD_TOPIC_PREFIX}/${config.claim.hubId}/${kind}`,
      encoded,
      { qos: 0, retain: false, properties: { messageExpiryInterval: 10 } },
      (error) => {
        if (!error && this.current(context)) this.status.lastPublishedAt = new Date().toISOString();
      },
    );
  }
  private async consume(
    context: Context,
    session: string,
    connectionSignal: AbortSignal,
    request: CloudRequest,
  ): Promise<void> {
    const config = this.store.privateConfig();
    const live = () =>
      this.current(context) &&
      context.ready &&
      context.sessionId === session &&
      !connectionSignal.aborted;
    if (
      !live() ||
      !config.claim ||
      request.version !== 1 ||
      request.hubId !== config.claim.hubId ||
      request.sessionId !== session ||
      typeof request.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,96}$/.test(request.id) ||
      !Number.isInteger(request.sequence) ||
      request.sequence < 1 ||
      request.sequence > 0xffffffff ||
      !Number.isSafeInteger(request.expiresAtUptimeMs) ||
      !cloudObject(request.actor) ||
      typeof request.actor.userId !== 'string' ||
      request.actor.userId.length > 128 ||
      (request.actor.displayName !== undefined &&
        (typeof request.actor.displayName !== 'string' ||
          request.actor.displayName.length > 128)) ||
      !cloudPermitted(request.actor, request.method, request.path, request.body)
    )
      return;
    const signature = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = context.cache.get(request.id);
    if (existing) {
      if (existing.signature === signature) this.respond(context, existing.reply);
      return;
    }
    const remaining = request.expiresAtUptimeMs - this.uptime();
    let reply: CloudReply;
    if (request.sequence <= context.requestSequence || remaining < 250 || remaining > 15000) {
      reply = {
        version: 1,
        id: request.id,
        hubId: request.hubId,
        sessionId: session,
        sequence: request.sequence,
        status: 409,
        data: { error: 'Запрос устарел или не соответствует текущей сессии' },
      };
    } else {
      context.requestSequence = request.sequence;
      const timeout = AbortSignal.timeout(Math.max(1, remaining));
      const signal = AbortSignal.any([connectionSignal, timeout]);
      try {
        if (!live() || signal.aborted) return;
        const result = await withActivity(
          { actor: cloudActivityActor(request.actor.userId, request.actor.displayName) },
          () =>
            this.control.dispatch(request.method, request.path, request.body || {}, {
              actor: request.actor,
              signal,
              remainingMs: remaining,
            }),
        );
        reply = {
          version: 1,
          id: request.id,
          hubId: request.hubId,
          sessionId: session,
          sequence: request.sequence,
          status: result.status,
          data: result.data,
        };
      } catch (error) {
        const failure = error as { statusCode?: number; message?: string };
        reply = {
          version: 1,
          id: request.id,
          hubId: request.hubId,
          sessionId: session,
          sequence: request.sequence,
          status: failure.statusCode || 503,
          data: {
            error:
              failure.statusCode && failure.statusCode < 500
                ? failure.message
                : 'Хаб не подтвердил операцию',
          },
        };
      }
    }
    if (!live()) return;
    // Private configuration/backup replies stay only in this bounded RAM duplicate cache, never telemetry.
    if (Buffer.byteLength(JSON.stringify(reply)) > CLOUD_MAX_PACKET)
      reply = {
        ...reply,
        status: 413,
        data: { error: 'Ответ слишком велик. Запросите меньшую часть истории.' },
      };
    context.cache.set(request.id, { signature, reply });
    while (context.cache.size > 16) context.cache.delete(context.cache.keys().next().value!);
    this.respond(context, reply);
    this.publish(context, 'state');
  }
  private respond(context: Context, reply: CloudReply): void {
    if (
      !this.current(context) ||
      !context.ready ||
      !context.client.connected ||
      reply.sessionId !== context.sessionId
    )
      return;
    context.client.publish(`${CLOUD_TOPIC_PREFIX}/${reply.hubId}/reply`, JSON.stringify(reply), {
      qos: 0,
      retain: false,
      properties: { messageExpiryInterval: 10 },
    });
  }
  update(body: unknown): HubCloudView {
    if (this.pairing) throw new HubCloudError('Дождитесь завершения привязки', 409);
    this.store.update(body);
    this.reload();
    return this.snapshot();
  }
  async pair(body: unknown): Promise<HubCloudView> {
    if (this.pairing) throw new HubCloudError('Привязка уже выполняется', 409);
    if (this.store.error) throw new HubCloudError(this.store.error, 503);
    if (
      !cloudObject(body) ||
      Object.keys(body).some((key) => !['url', 'code', 'name'].includes(key)) ||
      typeof body.code !== 'string' ||
      !/^[A-Za-z0-9_-]{6,128}$/.test(body.code) ||
      (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 96))
    )
      throw new HubCloudError('Укажите адрес облака и одноразовый код');
    const config = this.store.privateConfig();
    if (config.claim)
      throw new HubCloudError('Хаб уже привязан. Сначала отключите прежнюю привязку.', 409);
    const origin = checkedCloudOrigin(body.url, this.options.allowInsecureLoopback);
    this.store.ensureIdentity();
    this.pairing = true;
    try {
      const response = await this.request(origin + '/api/v1/hubs/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: body.code,
          installationId: config.installationId,
          name: body.name || config.name,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new HubCloudError(
          response.status === 409
            ? 'Код уже использован или у дома есть другой хаб'
            : response.status === 429
              ? 'Слишком много попыток привязки. Повторите позже.'
              : 'Код привязки отклонён или истёк',
          response.status === 429 ? 429 : 400,
        );
      const claim = await responseJson(response);
      this.store.pair(origin, claim, typeof body.name === 'string' ? body.name : config.name);
      this.reload();
      return this.snapshot();
    } catch (error) {
      if (error instanceof HubCloudError) throw error;
      throw new HubCloudError('Не удалось связаться с облаком. Проверьте адрес и сертификат.', 503);
    } finally {
      this.pairing = false;
    }
  }
  async disconnect(): Promise<HubCloudView> {
    if (this.pairing) throw new HubCloudError('Дождитесь завершения привязки', 409);
    const config = this.store.privateConfig();
    await this.retire();
    let revoked = true;
    if (config.claim) {
      try {
        const response = await this.request(config.url + '/api/v1/hubs/disconnect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + config.claim.broker.password,
          },
          body: JSON.stringify({
            hubId: config.claim.hubId,
            installationId: config.installationId,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        revoked = response.ok;
      } catch {
        revoked = false;
      }
    }
    this.store.disconnect();
    this.status = {
      state: 'disabled',
      error: revoked
        ? null
        : 'Локально отключено. Облако не подтвердило отзыв; удалите хаб в облачной панели.',
      lastConnectedAt: null,
      lastPublishedAt: null,
    };
    return this.snapshot();
  }
}
