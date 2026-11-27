/** @file Безопасное представление снимков PLC: подписи, телеметрия и сводные показатели. */

import type { CommandView, ControllerKind, DeviceView, HubSnapshot } from '../../shared/types.js';
import type { IconName } from './icons';

export type Row = Record<string, unknown>;
export const titles: Record<ControllerKind, string> = {
  sockets: 'Розетки',
  lights: 'Свет',
  meteo: 'Метео',
  thermostats: 'Термостаты',
  security: 'Охрана',
  tanks: 'Баки',
  irrigation: 'Полив',
};
export const moduleIcons: Record<ControllerKind, IconName> = {
  sockets: 'socket',
  lights: 'light',
  meteo: 'weather',
  thermostats: 'thermometer',
  security: 'shield',
  tanks: 'tank',
  irrigation: 'irrigation',
};
export const kinds: ControllerKind[] = [
  'sockets',
  'lights',
  'meteo',
  'thermostats',
  'security',
  'tanks',
  'irrigation',
];

/** Принимает только строку; значения другого типа заменяются запасной подписью. */
export const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/**
 * Принимает только конечное число; отсутствующее или некорректное значение остаётся неизвестным.
 */
export const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Оставляет в массиве только объекты строк телеметрии. */
export const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((row): row is Row =>
        Boolean(row && typeof row === 'object' && !Array.isArray(row)),
      )
    : [];

/** Форматирует температуру с одним десятичным знаком или показывает отсутствие показания. */
export const temperature = (value: unknown): string =>
  number(value) === null
    ? '—'
    : (value as number).toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/** Выбирает имя PLC с запасным вариантом в виде его стабильного идентификатора. */
export const deviceName = (device: DeviceView) => device.name || device.id;

/** Переводит состояние связи PLC в подпись для пользователя. */
export const statusText = (device: DeviceView) =>
  ({
    online: 'На связи',
    offline: 'Не в сети',
    stale: 'Данные устарели',
    unknown: 'Ожидаем данные',
  })[device.status];

/** Переводит результат команды в подпись, отличая ожидание от подтверждения. */
export const commandText = (command: CommandView) =>
  ({
    pending: 'Ожидаем PLC',
    applied: 'Выполнено',
    rejected: 'Отклонено',
    unknown: 'Не подтверждено',
  })[command.status];

/** Форматирует локальное время события; отсутствие времени отображается прочерком. */
export function time(value: string | null): string {
  return value
    ? new Date(value).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
}

/** Представляет время работы PLC в днях, часах и минутах. */
export function uptime(value: number | null): string {
  if (value === null) return '—';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return days ? `${days} д ${hours} ч` : hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

/** Считает показатели обзора только по свежим устройствам и свежим состояниям модулей. */
export function metrics(snapshot: HubSnapshot) {
  const fresh = snapshot.devices.filter((device) => device.online && device.status === 'online');
  let outputs = 0;
  let sensors = 0;
  let alarms = 0;
  for (const device of fresh)
    for (const kind of kinds) {
      const module = device.controllers[kind];
      if (!module?.fresh) continue;
      if (kind === 'security') alarms += module.data.phase === 'alarm' ? 1 : 0;
      if (kind === 'meteo')
        sensors += rows(module.data.items).filter(
          (item) => item.available === true && number(item.temperatureC) !== null,
        ).length;
      if (kind === 'irrigation') {
        // Several rules on the same PLC can use one valve.
        const opened = rows(module.data.items).filter((item) => item.valveActual === true);
        outputs += new Set(opened.map((item) => item.relayId)).size;
      }
      if (kind === 'tanks')
        for (const item of rows(module.data.items))
          outputs += Number(item.pumpActual === true) + Number(item.valveActual === true);
      if (['sockets', 'lights', 'thermostats'].includes(kind))
        outputs += rows(module.data.items).filter((item) => item.actual === true).length;
    }
  return { online: fresh.length, outputs, sensors, alarms };
}
