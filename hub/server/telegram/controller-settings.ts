/** @file Edit operational PLC settings through the private, revision-checked hub service. */
import { irrigationDays, remoteTankReference } from '../../shared/irrigation.js';
import type { ControllerKind, DeviceView, EngineSnapshot } from '../../shared/types.js';

type Row = Record<string, unknown>;

export interface TelegramControllerSettingsActions {
  snapshot(): EngineSnapshot;
  service(
    deviceId: string,
    method: 'GET' | 'POST',
    path: string,
    body?: Row,
  ): Promise<{ status: number; data: unknown }>;
}

type ModuleTarget = {
  deviceId: string;
  bootId: string | null;
  revision?: number;
  connectionGeneration?: number;
};

export type TelegramControllerSettingsTarget = ModuleTarget & { itemId: string };

export type TelegramControllerSetting =
  | { kind: 'thermostats'; field: 'setpointC' | 'hysteresisC'; value: number }
  | { kind: 'thermostats'; field: 'mode'; value: 'heating' | 'cooling' }
  | { kind: 'tanks'; field: 'fillLevel'; value: number }
  | { kind: 'irrigation'; field: 'days'; value: number[] }
  | { kind: 'irrigation'; field: 'startTime' | 'tankId'; value: string }
  | { kind: 'irrigation'; field: 'durationMinutes'; value: number };

interface ModuleSettings {
  revision: number;
  enabled: boolean;
  items: Row[];
  data: Row;
  connection: ModuleTarget;
}

const settingsFields: Record<ControllerKind, readonly string[]> = {
  sockets: ['relayId', 'inputId'],
  lights: ['relayId', 'inputId'],
  meteo: ['portId', 'sensorType', 'address'],
  thermostats: ['meteoId', 'relayId', 'inputId', 'mode', 'setpointC', 'hysteresisC'],
  security: ['inputId', 'sensorType', 'entryDelay'],
  tanks: ['pumpRelayId', 'valveRelayId', 'levelInputs', 'fillLevel'],
  irrigation: ['relayId', 'tankId', 'days', 'startTime', 'durationMinutes'],
};
const optionalBindings = new Set(['inputId', 'pumpRelayId', 'valveRelayId', 'tankId']);
const record = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const statusError = (data: unknown, fallback: string) =>
  record(data) && typeof data.error === 'string' && data.error.trim() ? data.error : fallback;

function currentDevice(
  actions: TelegramControllerSettingsActions,
  target: ModuleTarget,
  kind: ControllerKind,
  permitted: () => boolean,
): DeviceView {
  if (!permitted()) throw new Error('Запрос устарел или доступ отозван.');
  const snapshot = actions.snapshot();
  const device = snapshot.devices.find((entry) => entry.id === target.deviceId);
  if (
    !snapshot.broker.connected ||
    !device?.online ||
    device.status !== 'online' ||
    !target.bootId ||
    device.bootId !== target.bootId ||
    (target.connectionGeneration !== undefined &&
      device.connectionGeneration !== target.connectionGeneration) ||
    !device.controllers[kind]?.fresh
  )
    throw new Error('Нет свежей связи с PLC. Обновите меню перед изменением.');
  if (!device.management?.supported)
    throw new Error('Настройка через хаб доступна после обновления прошивки этого PLC.');
  return device;
}

async function readModule(
  actions: TelegramControllerSettingsActions,
  target: ModuleTarget,
  kind: ControllerKind,
  permitted: () => boolean,
  freshnessKind = kind,
): Promise<ModuleSettings> {
  const device = currentDevice(actions, target, freshnessKind, permitted);
  const connection = { ...target, connectionGeneration: device.connectionGeneration };
  const result = await actions.service(target.deviceId, 'GET', `/controllers/${kind}`);
  currentDevice(actions, connection, freshnessKind, permitted);
  if (result.status !== 200)
    throw new Error(statusError(result.data, 'Не удалось прочитать настройки PLC.'));
  const data = result.data;
  if (
    !record(data) ||
    !integer(data.revision, 1, 0xffff_ffff) ||
    typeof data.enabled !== 'boolean' ||
    !Array.isArray(data.items) ||
    data.items.length > 16 ||
    !data.items.every(record)
  )
    throw new Error('PLC вернул неполные настройки. Обновите меню.');
  if (target.revision !== undefined && target.revision !== data.revision)
    throw new Error('Настройки изменились. Обновите меню перед сохранением.');
  return { revision: data.revision, enabled: data.enabled, items: data.items, data, connection };
}

function settingsRow(row: Row, fields: readonly string[]): Row {
  const result: Row = {};
  for (const field of fields) {
    const value = row[field];
    if (value === undefined && !optionalBindings.has(field))
      throw new Error('PLC вернул неполные настройки. Обновите меню.');
    result[field] = value === undefined ? '' : value;
  }
  return result;
}

function commonSettings(kind: ControllerKind, data: Row): Row {
  if (kind !== 'security') return {};
  if (!Array.isArray(data.keys) || data.keys.length > 16 || !data.keys.every(record))
    throw new Error('PLC вернул неполные настройки охраны.');
  return {
    ...settingsRow(data, ['sirenRelayId', 'readerPortId', 'exitDelaySeconds', 'entryDelaySeconds']),
    keys: data.keys.map((key) => settingsRow(key, ['id', 'name', 'address'])),
  };
}

async function writeModule(
  actions: TelegramControllerSettingsActions,
  kind: ControllerKind,
  module: ModuleSettings,
  enabled: boolean,
  items: Row[],
  permitted: () => boolean,
): Promise<void> {
  const body = {
    ...commonSettings(kind, module.data),
    baseRevision: module.revision,
    enabled,
    items: items.map((item) => settingsRow(item, ['id', 'name', ...settingsFields[kind]])),
  };
  const device = currentDevice(actions, module.connection, kind, permitted);
  if (device.management?.busy) throw new Error('PLC занят. Обновите меню и попробуйте снова.');
  const result = await actions.service(device.id, 'POST', `/controllers/${kind}`, body);
  if (result.status !== 200 || !record(result.data) || result.data.ok !== true)
    throw new Error(statusError(result.data, 'PLC не подтвердил сохранение. Обновите меню.'));
}

function tankLabel(value: unknown, fallback: string): string {
  return typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .trim()
        .slice(0, 64) || fallback
    : fallback;
}

async function irrigationTanks(
  actions: TelegramControllerSettingsActions,
  irrigation: ModuleSettings,
  permitted: () => boolean,
): Promise<{ id: string; label: string }[]> {
  const local = await readModule(
    actions,
    { ...irrigation.connection, revision: undefined },
    'tanks',
    permitted,
    'irrigation',
  );
  const results = new Map<string, string>([['', 'Без бака']]);
  for (const item of local.items)
    if (typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(item.id))
      results.set(item.id, tankLabel(item.name, item.id));
  const remote = irrigation.data.remoteTanks;
  if (Array.isArray(remote)) {
    for (const item of remote.slice(0, 96)) {
      if (!record(item) || typeof item.id !== 'string') continue;
      const reference = remoteTankReference(item.id);
      if (reference && reference.deviceId !== irrigation.connection.deviceId)
        results.set(
          item.id,
          `${tankLabel(item.name, reference.tankId)} · ${tankLabel(item.deviceName, reference.deviceId)}`,
        );
    }
  }
  return [...results].map(([id, label]) => ({ id, label }));
}

export async function readTelegramIrrigationTanks(
  actions: TelegramControllerSettingsActions,
  target: TelegramControllerSettingsTarget,
  permitted: () => boolean,
): Promise<{ id: string; label: string }[]> {
  const module = await readModule(actions, target, 'irrigation', permitted);
  if (!module.items.some((item) => item.id === target.itemId))
    throw new Error('Правило полива удалено. Обновите меню.');
  return irrigationTanks(actions, module, permitted);
}

function settingValue(setting: TelegramControllerSetting, item: Row): unknown {
  const { field, value } = setting;
  switch (field) {
    case 'setpointC':
      if (
        typeof value === 'number' &&
        value >= -55 &&
        value <= 125 &&
        Math.abs(Math.round(value * 10) - value * 10) < 1e-7
      )
        return value;
      throw new Error('Уставка от −55 до 125 °C, до одного знака после запятой.');
    case 'hysteresisC':
      if (integer(value, 1, 20)) return value;
      throw new Error('Гистерезис от 1 до 20 °C, целым числом.');
    case 'mode':
      if (value === 'heating' || value === 'cooling') return value;
      throw new Error('Выберите нагрев или охлаждение.');
    case 'fillLevel':
      if (Array.isArray(item.levelInputs) && integer(value, 1, item.levelInputs.length))
        return value;
      throw new Error('Выберите один из настроенных уровней этого бака.');
    case 'days':
      if (irrigationDays(value) !== '—') return [...value].sort((a, b) => a - b);
      throw new Error('Выберите хотя бы один день недели.');
    case 'startTime':
      if (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
      throw new Error('Укажите время в формате ЧЧ:ММ, например 06:30.');
    case 'durationMinutes':
      if (integer(value, 1, 1440)) return value;
      throw new Error('Длительность от 1 до 1440 минут, целым числом.');
    case 'tankId':
      return value;
  }
}

export async function updateTelegramControllerSetting(
  actions: TelegramControllerSettingsActions,
  target: TelegramControllerSettingsTarget,
  setting: TelegramControllerSetting,
  permitted: () => boolean,
): Promise<void> {
  const { kind, field } = setting;
  const module = await readModule(actions, target, kind, permitted);
  const item = module.items.find(({ id }) => id === target.itemId);
  if (!item) throw new Error('Устройство удалено из настроек PLC. Обновите меню.');
  const value = settingValue(setting, item);
  if (JSON.stringify(value) === JSON.stringify(item[field])) return;
  if (
    field === 'tankId' &&
    value !== '' &&
    !(await irrigationTanks(actions, module, permitted)).some(({ id }) => id === value)
  )
    throw new Error('Этого бака сейчас нет в каталоге. Обновите список.');
  await writeModule(
    actions,
    kind,
    module,
    module.enabled,
    module.items.map((row) => (row === item ? { ...row, [field]: value } : row)),
    permitted,
  );
}

export async function updateTelegramModuleEnabled(
  actions: TelegramControllerSettingsActions,
  target: ModuleTarget,
  kind: ControllerKind,
  enabled: boolean,
  permitted: () => boolean,
): Promise<void> {
  const module = await readModule(actions, target, kind, permitted);
  if (module.enabled === enabled) return;
  await writeModule(actions, kind, module, enabled, module.items, permitted);
}
