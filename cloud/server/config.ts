/** @file Validate cloud origins and load private credentials before opening public listeners. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
export interface CloudConfig {
  host: string;
  port: number;
  publicOrigin: string;
  secureCookies: boolean;
  databaseUrl: string;
  setupKey: string;
  masterKey: Buffer;
  dataDir: string;
  brokerUrl: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttCa?: string;
  publicBrokerUrl: string;
  publicMqttCa?: string;
  allowInsecureLoopback: boolean;
}
function value(env: NodeJS.ProcessEnv, name: string): string {
  const file = env[name + '_FILE'];
  return file ? readFileSync(file, 'utf8').trim() : env[name] || '';
}
function certificate(raw: string): string | undefined {
  if (!raw) return undefined;
  return raw.includes('-----BEGIN CERTIFICATE-----') ? raw : readFileSync(raw, 'utf8');
}
export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const host = env.FCPLCN_CLOUD_HOST || '127.0.0.1',
    port = Number(env.FCPLCN_CLOUD_PORT || 4100);
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Некорректный адрес облачного сервера');
  const origin = new URL(env.FCPLCN_CLOUD_PUBLIC_ORIGIN || `http://127.0.0.1:${port}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    !['http:', 'https:'].includes(origin.protocol) ||
    (origin.protocol === 'http:' && !local)
  )
    throw new Error(
      'Облачный PUBLIC_ORIGIN должен быть HTTPS; HTTP разрешён только для локального стенда',
    );
  const databaseUrl = value(env, 'FCPLCN_CLOUD_DATABASE_URL');
  if (!databaseUrl || !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol))
    throw new Error('Задайте FCPLCN_CLOUD_DATABASE_URL');
  const dataDir = resolve(env.FCPLCN_CLOUD_DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const saved = (name: string, provided: string) => {
    if (provided) return provided;
    const file = resolve(dataDir, name);
    if (!existsSync(file))
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return readFileSync(file, 'utf8').trim();
  };
  const setupKey = saved('setup.key', value(env, 'FCPLCN_CLOUD_SETUP_KEY'));
  if (setupKey.length < 24 || setupKey.length > 256)
    throw new Error('Ключ первоначальной настройки должен содержать 24–256 символов');
  const rawKey = saved('master.key', value(env, 'FCPLCN_CLOUD_MASTER_KEY'));
  let masterKey: Buffer;
  if (/^[a-fA-F0-9]{64}$/.test(rawKey)) masterKey = Buffer.from(rawKey, 'hex');
  else {
    masterKey = Buffer.from(rawKey, 'base64');
    if (masterKey.length !== 32)
      throw new Error('MASTER_KEY должен содержать 32 случайных байта в hex или base64');
  }
  const brokerUrl = env.FCPLCN_CLOUD_MQTT_URL || 'mqtts://127.0.0.1:8883';
  const mqttUsername = value(env, 'FCPLCN_CLOUD_MQTT_USERNAME'),
    mqttPassword = value(env, 'FCPLCN_CLOUD_MQTT_PASSWORD');
  if (!mqttUsername || !mqttPassword)
    throw new Error('Задайте индивидуальные учётные данные облачного MQTT-сервиса');
  return {
    host,
    port,
    publicOrigin: origin.origin,
    secureCookies: origin.protocol === 'https:',
    databaseUrl,
    setupKey,
    masterKey,
    dataDir,
    brokerUrl,
    mqttUsername,
    mqttPassword,
    mqttCa: certificate(value(env, 'FCPLCN_CLOUD_MQTT_CA')),
    publicBrokerUrl: env.FCPLCN_CLOUD_PUBLIC_MQTT_URL || brokerUrl,
    publicMqttCa: certificate(value(env, 'FCPLCN_CLOUD_PUBLIC_MQTT_CA')),
    allowInsecureLoopback: env.FCPLCN_CLOUD_ALLOW_INSECURE_LOOPBACK === '1' && local,
  };
}
