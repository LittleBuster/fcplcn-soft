/** @file Live Mosquitto dynamic-security provisioning; credentials are individual and revocable. */
import { randomBytes, randomUUID } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import { cloudHubId, type CloudBrokerCredentials } from '../../hub/shared/cloud.js';

export interface BrokerAdminOptions {
  brokerUrl: string;
  username: string;
  password: string;
  ca?: string;
  publicBrokerUrl: string;
  publicCa?: string;
  allowInsecureLoopback?: boolean;
}
export function checkedBrokerUrl(value: string, allowInsecureLoopback = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || url.pathname)
    throw new Error('Некорректный адрес облачного брокера');
  if (
    url.protocol !== 'mqtts:' &&
    !(
      allowInsecureLoopback &&
      url.protocol === 'mqtt:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error('Облачное MQTT-соединение требует TLS');
  return value;
}
export class BrokerAdmin {
  private client: MqttClient | null = null;
  private ready = false;
  private readonly pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(private readonly options: BrokerAdminOptions) {
    checkedBrokerUrl(options.brokerUrl, options.allowInsecureLoopback);
    checkedBrokerUrl(options.publicBrokerUrl, options.allowInsecureLoopback);
  }
  async start(): Promise<void> {
    if (this.client) return;
    const client = mqtt.connect(this.options.brokerUrl, {
      protocolVersion: 5,
      clean: true,
      queueQoSZero: false,
      reconnectPeriod: 1000,
      clientId: 'fcplcn-cloud-admin-' + randomUUID(),
      username: this.options.username,
      password: this.options.password,
      rejectUnauthorized: true,
      ...(this.options.ca ? { ca: this.options.ca } : {}),
      properties: { sessionExpiryInterval: 0 },
      connectTimeout: 10000,
    });
    this.client = client;
    client.on('message', (_topic, payload, packet) => {
      if (packet.retain || payload.length > 65536) return;
      try {
        const response = JSON.parse(payload.toString()) as {
          responses?: { correlationData?: string; error?: string }[];
        };
        for (const row of response.responses || []) {
          const pending = row.correlationData && this.pending.get(row.correlationData);
          if (!pending) continue;
          this.pending.delete(row.correlationData!);
          clearTimeout(pending.timer);
          if (row.error) pending.reject(new Error('Брокер отклонил изменение прав подключения'));
          else pending.resolve();
        }
      } catch {
        /* Uncorrelated malformed admin replies cannot resolve a provisioning operation. */
      }
    });
    const disconnected = () => {
      this.ready = false;
      for (const row of this.pending.values()) {
        clearTimeout(row.timer);
        row.reject(new Error('Брокер не подтвердил изменение прав; результат неизвестен'));
      }
      this.pending.clear();
    };
    client.on('offline', disconnected);
    client.on('close', disconnected);
    client.on('error', () => {});
    client.on('connect', () => {
      client.subscribe(
        '$CONTROL/dynamic-security/v1/response',
        { qos: 0, rap: true, rh: 2 },
        (error, grants) => {
          this.ready = !error && grants?.every((grant) => grant.qos <= 2) === true;
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 11000;
      const timer = setInterval(() => {
        if (this.ready) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() >= until) {
          clearInterval(timer);
          reject(new Error('Облачный брокер не готов к выдаче подключений'));
        }
      }, 20);
    });
  }
  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.ready = false;
    for (const row of this.pending.values()) {
      clearTimeout(row.timer);
      row.reject(new Error('Служба брокера остановлена'));
    }
    this.pending.clear();
    if (client) await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
  }
  private command(command: Record<string, unknown>): Promise<void> {
    const client = this.client;
    if (!client?.connected || !this.ready)
      return Promise.reject(new Error('Облачный брокер недоступен'));
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Брокер не подтвердил изменение прав; результат неизвестен'));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      client.publish(
        '$CONTROL/dynamic-security/v1',
        JSON.stringify({ commands: [{ ...command, correlationData: id }] }),
        { qos: 0, retain: false, properties: { messageExpiryInterval: 8 } },
        (error) => {
          if (!error || !this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error('Изменение прав брокера не отправлено'));
        },
      );
    });
  }
  async provision(hubId: string): Promise<CloudBrokerCredentials> {
    if (!cloudHubId(hubId)) throw new Error('Некорректный идентификатор хаба');
    const password = randomBytes(32).toString('base64url');
    const prefix = `fcplcn-cloud/v1/hubs/${hubId}`,
      role = 'fcplcn-hub-' + hubId;
    // Mosquitto 2.0 dynamic-security does not expand %u. Literal per-hub ACLs also prevent wildcard escalation.
    await this.command({
      command: 'createRole',
      rolename: role,
      acls: [
        ...['hello', 'state', 'reply'].map((part) => ({
          acltype: 'publishClientSend',
          topic: `${prefix}/${part}`,
          allow: true,
          priority: 1,
        })),
        { acltype: 'publishClientReceive', topic: `${prefix}/request`, allow: true, priority: 1 },
        { acltype: 'subscribeLiteral', topic: `${prefix}/request`, allow: true, priority: 1 },
        { acltype: 'unsubscribeLiteral', topic: `${prefix}/request`, allow: true, priority: 1 },
      ],
    });
    try {
      await this.command({
        command: 'createClient',
        username: hubId,
        password,
        clientid: hubId,
        roles: [{ rolename: role, priority: 1 }],
      });
    } catch (error) {
      await this.command({ command: 'deleteRole', rolename: role }).catch(() => {});
      throw error;
    }
    return {
      username: hubId,
      password,
      brokerUrl: this.options.publicBrokerUrl,
      ...(this.options.publicCa ? { ca: this.options.publicCa } : {}),
    };
  }
  async revoke(hubId: string): Promise<void> {
    if (!cloudHubId(hubId)) throw new Error('Некорректный идентификатор хаба');
    await this.command({ command: 'disableClient', username: hubId });
  }
}
