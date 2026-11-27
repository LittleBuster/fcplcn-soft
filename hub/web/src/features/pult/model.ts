/** @file Реальные каналы домашнего пульта и правила отображения подтверждённых состояний. */
import type { ControllerView, DeviceView, HubSnapshot } from '../../../../shared/types.js';
import type { PultTemperatureSource } from '../../../../shared/pult.js';
import type { IconName } from '../../icons';
import { deviceName, number, rows, text, type Row } from '../../model';

export const pultKinds = [
  'lights',
  'sockets',
  'thermostats',
  'meteo',
  'tanks',
  'irrigation',
] as const;
export type PultKind = (typeof pultKinds)[number];
export type PultFilter = PultKind | 'all';

export const pultLabels: Record<PultFilter, string> = {
  all: 'Всё',
  lights: 'Свет',
  sockets: 'Розетки',
  thermostats: 'Климат',
  meteo: 'Датчики',
  tanks: 'Баки',
  irrigation: 'Полив',
};
export const pultIcons: Record<PultFilter, IconName> = {
  all: 'home',
  lights: 'light',
  sockets: 'socket',
  thermostats: 'thermometer',
  meteo: 'weather',
  tanks: 'tank',
  irrigation: 'irrigation',
};

export interface PultEntry {
  key: string;
  kind: PultKind;
  device: DeviceView;
  module: ControllerView;
  item: Row;
  room: string;
}

/** Преобразует снимок в устойчивый порядок каналов, сохраняя их исходный PLC и модуль. */
export function pultEntries(snapshot: HubSnapshot): PultEntry[] {
  return pultKinds.flatMap((kind) =>
    snapshot.devices.flatMap((device) => {
      const module = device.controllers[kind];
      if (!module) return [];
      return rows(module.data.items)
        .filter((item) => text(item.id))
        .map((item) => ({
          key: `${device.id}/${kind}/${text(item.id)}`,
          kind,
          device,
          module,
          item,
          room: device.room || deviceName(device),
        }));
    }),
  );
}

/** Проверяет свежесть устройства и модуля; потеря соединения отменяет знание состояния. */
export function pultFresh(entry: PultEntry, connected: boolean): boolean {
  return connected && entry.device.online && entry.device.status === 'online' && entry.module.fresh;
}

/** Читает только закреплённый датчик; потеря его связи не подменяет источник температуры. */
export function pultAirReading(
  entries: PultEntry[],
  connected: boolean,
  source: PultTemperatureSource | null | undefined,
): PultEntry | undefined {
  if (!source) return undefined;
  return entries.find(
    (entry) =>
      entry.kind === 'meteo' &&
      entry.device.id === source.deviceId &&
      text(entry.item.id) === source.itemId &&
      pultFresh(entry, connected) &&
      entry.module.data.enabled === true &&
      entry.item.available === true &&
      number(entry.item.temperatureC) !== null,
  );
}
