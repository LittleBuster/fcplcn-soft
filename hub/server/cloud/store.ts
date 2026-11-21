/** @file Private, atomic cloud pairing credentials. Defaults never open an external connection. */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { cloudHubId, cloudObject, type CloudClaim } from '../../shared/cloud.js';

export interface CloudSettings {
  version: 1;
  revision: number;
  installationId: string;
  enabled: boolean;
  url: string;
  name: string;
  claim: CloudClaim | null;
}
export class HubCloudError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
export function checkedCloudOrigin(value: unknown, allowInsecureLoopback = false): string {
  if (typeof value !== 'string' || value.length > 512)
    throw new HubCloudError('Укажите HTTPS-адрес облака');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HubCloudError('Укажите HTTPS-адрес облака');
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !['', '/'].includes(url.pathname) ||
    (url.protocol !== 'https:' &&
      !(
        allowInsecureLoopback &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new HubCloudError('Нужен корневой HTTPS-адрес облака');
  return url.origin;
}
export function checkedClaim(value: unknown, allowInsecureLoopback = false): CloudClaim {
  if (
    !cloudObject(value) ||
    value.protocolVersion !== 1 ||
    !cloudHubId(value.hubId) ||
    typeof value.homeId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(value.homeId) ||
    !cloudObject(value.broker) ||
    value.broker.username !== value.hubId ||
    typeof value.broker.password !== 'string' ||
    value.broker.password.length < 32 ||
    value.broker.password.length > 256 ||
    typeof value.broker.brokerUrl !== 'string' ||
    (value.broker.ca !== undefined &&
      (typeof value.broker.ca !== 'string' || value.broker.ca.length > 32768))
  )
    throw new HubCloudError('Облако вернуло некорректные параметры подключения', 502);
  let broker: URL;
  try {
    broker = new URL(value.broker.brokerUrl);
  } catch {
    throw new HubCloudError('Облако вернуло некорректный адрес брокера', 502);
  }
  if (
    broker.username ||
    broker.password ||
    broker.hash ||
    broker.search ||
    broker.pathname ||
    (broker.protocol !== 'mqtts:' &&
      !(
        allowInsecureLoopback &&
        broker.protocol === 'mqtt:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(broker.hostname)
      ))
  )
    throw new HubCloudError('Облачный брокер должен использовать TLS', 502);
  return structuredClone(value) as unknown as CloudClaim;
}
export class HubCloudStore {
  readonly path: string;
  private value: CloudSettings = {
    version: 1,
    revision: 1,
    installationId: randomUUID(),
    enabled: false,
    url: '',
    name: 'FCPLCn Хаб',
    claim: null,
  };
  private failure: string | null = null;
  constructor(
    directory: string,
    private readonly allowInsecureLoopback = false,
  ) {
    this.path = join(directory, 'cloud.json');
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      let stat;
      try {
        stat = lstatSync(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('invalid');
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (
        !cloudObject(value) ||
        value.version !== 1 ||
        !Number.isSafeInteger(value.revision) ||
        Number(value.revision) < 1 ||
        Number(value.revision) > 0xffffffff ||
        typeof value.installationId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,96}$/.test(value.installationId) ||
        typeof value.enabled !== 'boolean' ||
        typeof value.name !== 'string' ||
        value.name.length > 96 ||
        typeof value.url !== 'string' ||
        (value.enabled && !value.claim)
      )
        throw new Error('invalid');
      if (value.url) checkedCloudOrigin(value.url, allowInsecureLoopback);
      if (value.claim) checkedClaim(value.claim, allowInsecureLoopback);
      this.value = value as unknown as CloudSettings;
      chmodSync(this.path, 0o600);
    } catch {
      this.failure =
        'Не удалось прочитать настройки облака. Подключение остановлено; файл сохранён.';
    }
  }
  get error(): string | null {
    return this.failure;
  }
  private healthy(): void {
    if (this.failure) throw new HubCloudError(this.failure, 503);
  }
  private commit(next: CloudSettings): void {
    this.healthy();
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(next) + '\n');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
      const parent = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      this.value = next;
    } catch {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        /* An absent temporary file is already cleaned. */
      }
      this.failure = 'Не удалось сохранить настройки облака. Подключение остановлено.';
      throw new HubCloudError(this.failure, 503);
    }
  }
  privateConfig(): CloudSettings {
    const value = structuredClone(this.value);
    if (this.failure) {
      value.enabled = false;
      value.claim = null;
    }
    return value;
  }
  ensureIdentity(): void {
    this.healthy();
    if (!existsSync(this.path)) this.commit(structuredClone(this.value));
  }
  publicConfig() {
    const value = this.value;
    return {
      revision: value.revision,
      enabled: !this.failure && value.enabled,
      url: value.url,
      paired: Boolean(value.claim),
      hubId: value.claim?.hubId || '',
      homeId: value.claim?.homeId || '',
      name: value.name,
    };
  }
  pair(url: string, claim: unknown, name: string): void {
    this.healthy();
    const checked = checkedClaim(claim, this.allowInsecureLoopback);
    this.commit({
      ...this.value,
      revision: this.value.revision + 1,
      enabled: true,
      url: checkedCloudOrigin(url, this.allowInsecureLoopback),
      claim: checked,
      name: name.slice(0, 96) || this.value.name,
    });
  }
  update(body: unknown): void {
    this.healthy();
    if (
      !cloudObject(body) ||
      Object.keys(body).some((key) => !['baseRevision', 'enabled'].includes(key)) ||
      typeof body.enabled !== 'boolean' ||
      !Number.isSafeInteger(body.baseRevision)
    )
      throw new HubCloudError('Укажите ревизию и состояние подключения');
    if (body.baseRevision !== this.value.revision)
      throw new HubCloudError('Настройки облака изменены. Обновите страницу.', 409);
    if (this.value.revision >= 0xffffffff)
      throw new HubCloudError('Исчерпан номер ревизии настроек облака', 409);
    if (body.enabled && !this.value.claim)
      throw new HubCloudError('Сначала привяжите хаб к дому в облаке');
    this.commit({ ...this.value, revision: this.value.revision + 1, enabled: body.enabled });
  }
  disconnect(): void {
    this.healthy();
    this.commit({ ...this.value, revision: this.value.revision + 1, enabled: false, claim: null });
  }
}
