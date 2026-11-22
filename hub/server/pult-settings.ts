/** @file Durable, explicitly selected temperature source; no PLC commands or fallback selection. */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { PultSettingsView, PultTemperatureSource } from '../shared/pult.js';
import type { DeviceView } from '../shared/types.js';

const deviceIdPattern = /^fcplcn-[a-zA-Z0-9_-]{1,96}$/;
const itemIdPattern = /^[a-zA-Z0-9_-]{1,32}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).sort().join(',') === expected.sort().join(',');
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const name = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 256 &&
  !/[\x00-\x1f\x7f]/.test(value);
const reference = (
  value: unknown,
): value is Record<string, unknown> & { deviceId: string; itemId: string } =>
  object(value) &&
  typeof value.deviceId === 'string' &&
  deviceIdPattern.test(value.deviceId) &&
  typeof value.itemId === 'string' &&
  itemIdPattern.test(value.itemId);
const source = (value: unknown): value is PultTemperatureSource =>
  object(value) &&
  keys(value, ['deviceId', 'itemId', 'deviceName', 'itemName']) &&
  reference(value) &&
  name(value.deviceName) &&
  name(value.itemName);
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });

/** Private atomic storage, with an in-memory mode for isolated users of HubControl. */
export class PultSettingsStore {
  readonly path?: string;
  constructor(directory?: string) {
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.path = join(directory, 'pult.json');
    }
  }

  load(): PultSettingsView {
    const empty = { revision: 0, temperatureSource: null };
    if (!this.path) return empty;
    const information = lstatSync(this.path, { throwIfNoEntry: false });
    if (!information) return empty;
    if (!information.isFile() || information.isSymbolicLink() || information.size > 4096)
      throw new Error('Настройки пульта должны храниться в обычном приватном файле');
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw new Error('Повреждён файл настроек пульта; данные сохранены без изменений');
    }
    if (
      !object(saved) ||
      !keys(saved, ['version', 'revision', 'temperatureSource']) ||
      saved.version !== 1 ||
      !revision(saved.revision) ||
      (saved.temperatureSource !== null && !source(saved.temperatureSource))
    )
      throw new Error('Неподдерживаемый формат настроек пульта; данные сохранены без изменений');
    chmodSync(this.path, 0o600);
    return { revision: saved.revision, temperatureSource: saved.temperatureSource };
  }

  /** Commit memory only once the atomic rename has committed the same document. */
  save(value: PultSettingsView, committed: () => void): void {
    if (!this.path) {
      committed();
      return;
    }
    const information = lstatSync(this.path, { throwIfNoEntry: false });
    if (information && (!information.isFile() || information.isSymbolicLink()))
      throw new Error('Небезопасный файл настроек пульта');
    const temporary = this.path + '.next-' + randomBytes(6).toString('hex');
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, ...value }) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      committed();
      const parent = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}

/** Revisioned hub preference; a missing selected sensor never silently selects a different one. */
export class PultSettings {
  private readonly store: PultSettingsStore;
  private value: PultSettingsView;
  constructor(directory?: string) {
    this.store = new PultSettingsStore(directory);
    this.value = this.store.load();
  }

  snapshot(): PultSettingsView {
    return structuredClone(this.value);
  }

  update(body: Record<string, unknown>, devices: DeviceView[]): PultSettingsView {
    if (
      !keys(body, ['baseRevision', 'temperatureSource']) ||
      !revision(body.baseRevision) ||
      (body.temperatureSource !== null &&
        (!object(body.temperatureSource) ||
          !keys(body.temperatureSource, ['deviceId', 'itemId']) ||
          !reference(body.temperatureSource)))
    )
      throw fail('Выберите контроллер и датчик температуры');
    if (body.baseRevision !== this.value.revision)
      throw fail('Настройки пульта уже изменены. Обновите их перед сохранением.', 409);
    if (this.value.revision === Number.MAX_SAFE_INTEGER)
      throw fail('Достигнут предел ревизий настроек пульта', 409);
    let selected: PultTemperatureSource | null = null;
    if (body.temperatureSource !== null) {
      const target = body.temperatureSource;
      const device = devices.find((entry) => entry.id === target.deviceId);
      const items = device?.controllers.meteo?.data.items;
      const item = Array.isArray(items)
        ? items.find((entry) => object(entry) && entry.id === target.itemId)
        : undefined;
      if (device && object(item)) {
        const deviceName = device.name || device.id;
        const itemName = typeof item.name === 'string' && item.name ? item.name : target.itemId;
        if (!name(deviceName) || !name(itemName))
          throw fail('Слишком длинное или некорректное имя выбранного датчика');
        selected = { ...target, deviceName, itemName };
      } else if (
        this.value.temperatureSource?.deviceId === target.deviceId &&
        this.value.temperatureSource.itemId === target.itemId
      )
        selected = this.value.temperatureSource;
      else throw fail('Выбранный датчик температуры не найден');
    }
    const next: PultSettingsView = {
      revision: this.value.revision + 1,
      temperatureSource: selected,
    };
    this.store.save(next, () => {
      this.value = next;
    });
    return this.snapshot();
  }
}
