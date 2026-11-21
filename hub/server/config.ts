/** @file Validate server and broker settings before opening a LAN listener. */
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import type { EngineOptions, Product } from '../shared/types.js';

export interface HubConfig {
  host: string;
  port: number;
  password: string;
  dataDir: string;
  mode: 'demo' | 'mqtt';
  brokerUrl: string;
  mqttUsername?: string;
  mqttPassword?: string;
  clientId: string;
}

export function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

/** Read secrets from the process environment; never return them through the web API. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  args = process.argv.slice(2),
): HubConfig {
  const mode = args.includes('--demo') ? 'demo' : env.FCPLCN_HUB_MODE || 'mqtt';
  if (mode !== 'demo' && mode !== 'mqtt') throw new Error('FCPLCN_HUB_MODE: mqtt или demo');
  const host = env.FCPLCN_HUB_HOST || '127.0.0.1';
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw new Error('Некорректный адрес хаба');
  const port = Number(env.FCPLCN_HUB_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт хаба: 1–65535');
  const password = env.FCPLCN_HUB_PASSWORD || '';
  if (Buffer.byteLength(password) > 256 || (password && password.length < 8))
    throw new Error('Пароль хаба должен содержать от 8 до 256 символов');
  const brokerUrl = env.FCPLCN_HUB_MQTT_URL || 'mqtt://127.0.0.1:1883';
  const url = new URL(brokerUrl);
  if (!['mqtt:', 'mqtts:'].includes(url.protocol) || url.hash || url.search || url.pathname !== '')
    throw new Error('Адрес брокера должен иметь вид mqtt://host:1883 или mqtts://host:8883');
  return {
    host,
    port,
    password,
    mode,
    brokerUrl,
    dataDir: resolve(env.FCPLCN_HUB_DATA_DIR || './data'),
    mqttUsername: env.FCPLCN_HUB_MQTT_USERNAME || undefined,
    mqttPassword: env.FCPLCN_HUB_MQTT_PASSWORD || undefined,
    clientId: `fcplcn-hub-${hostname()
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 40)}`,
  };
}

export function engineOptions(
  config: HubConfig,
  product: Product,
  storage: Pick<EngineOptions, 'labels' | 'onLabelsChanged'>,
): EngineOptions {
  return {
    product,
    mode: config.mode,
    brokerUrl: config.brokerUrl,
    username: config.mqttUsername,
    password: config.mqttPassword,
    clientId: config.clientId,
    staleAfterMs: 45_000,
    commandTimeoutMs: 8_000,
    demoDataDir: config.mode === 'demo' ? config.dataDir : undefined,
    ...storage,
  };
}
