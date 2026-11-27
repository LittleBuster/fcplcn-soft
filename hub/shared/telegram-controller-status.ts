/** @file Present confirmed PLC telemetry in the Telegram menu and its preview. */
import { irrigationDays, irrigationRuleState, remoteTankReference } from './irrigation.js';
import type { ControllerKind, ControllerView, DeviceView } from './types.js';

type Row = Record<string, unknown>;

const phases: Record<string, string> = {
  disarmed: 'Охрана снята',
  armed: 'Под охраной',
  exit_delay: 'Задержка выхода',
  entry_delay: 'Задержка входа',
  alarm: '🚨 ТРЕВОГА',
};

const minimumCycle: Record<string, string> = {
  minimum_on: 'Минимальное время работы',
  minimum_off: 'Минимальная пауза',
};

const object = (value: unknown): value is Row =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(object) : []);
export const text = (value: unknown, fallback = '') =>
  typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .trim()
        .slice(0, 96) || fallback
    : fallback;
const numeric = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
export const reading = (value: unknown, unit = ' °C') =>
  numeric(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + unit : '—';
export const itemName = (item: Row) => text(item.name, text(item.id, 'Без имени'));

const state = (value: unknown, on: string, off: string) =>
  value === true ? on : value === false ? off : 'нет данных';

const mode = (value: unknown) =>
  value === 'heating' ? '🔥 Нагрев' : value === 'cooling' ? '❄️ Охлаждение' : 'не задан';

const output = (port: unknown, value: unknown, on: string, off: string, fresh: boolean) =>
  port === '' ? 'не назначен' : state(fresh ? value : null, on, off);

const water = (value: unknown) => state(value, 'есть', 'нет');

function thermostatTemperature(item: Row): string {
  return (item.sensorAvailable ?? item.available) === true && numeric(item.temperatureC)
    ? reading(item.temperatureC)
    : 'нет показаний';
}

function thermostatStatus(item: Row): string {
  if (item.inhibited === true) return 'заблокирован';
  if (item.enabled !== true) return 'выключен';
  if ((item.sensorAvailable ?? item.available) !== true) return 'ожидает датчик';
  if (typeof item.actual !== 'boolean') return 'нет данных выхода';
  if (item.actual && item.mode === 'heating') return 'нагревает';
  if (item.actual && item.mode === 'cooling') return 'охлаждает';
  if (item.actual) return 'реле включено';
  if (item.holdReason === 'minimum_off') return 'выдерживает паузу';
  return 'поддерживает температуру';
}

function irrigationTank(device: DeviceView, item: Row): string {
  if (item.tankId === '') return 'Без бака';
  if (remoteTankReference(item.tankId)) {
    // Full technical identities can be longer than other labels.
    return text(item.tankSourceLabel, String(item.tankId));
  }
  const tank = rows(device.controllers.tanks?.data.items).find((row) => row.id === item.tankId);
  return tank ? itemName(tank) : text(item.tankId, 'не выбран');
}

/** Put each live reading on its own line without treating missing feedback as OFF. */
export function controllerItemStatusLines(
  kind: ControllerKind,
  item: Row,
  fresh: boolean,
  moduleEnabled = true,
): [heading: string, ...details: string[]] {
  const name = itemName(item);
  if (!fresh) return [`⚫ ${name}`, 'Состояние: данные устарели'];
  if (!moduleEnabled) return [`⚪ ${name}`, 'Состояние: модуль выключен'];
  switch (kind) {
    case 'security':
      return item.available !== true || typeof item.active !== 'boolean'
        ? [`⚫ ${name}`, 'Состояние: недоступно']
        : [
            `${item.active ? '🔴' : '🟢'} ${name}`,
            `Состояние: ${item.active ? 'сработка' : 'норма'}`,
          ];
    case 'meteo':
      return [
        `${item.available === true ? '🌡' : '⚫'} ${name}`,
        `Температура: ${item.available === true && numeric(item.temperatureC) ? reading(item.temperatureC) : 'нет показаний'}`,
        ...(item.available === true && numeric(item.humidityPct)
          ? [`Влажность: ${reading(item.humidityPct, ' %')}`]
          : []),
      ];
    case 'irrigation':
      return [`💧 ${name}`, `Состояние: ${irrigationRuleState(item)}`];
    case 'tanks': {
      const level =
        item.enabled === true && item.available === true && numeric(item.levelPct)
          ? reading(item.levelPct, ' %')
          : 'нет данных';
      const pump = output(item.pumpRelayId, item.pumpActual, 'работает', 'выключен', fresh);
      const valve = output(item.valveRelayId, item.valveActual, 'открыт', 'закрыт', fresh);
      return [
        `🛢 ${name}`,
        `Мониторинг: ${state(item.enabled, 'включён', 'выключен')}`,
        `Уровень: ${level}`,
        `Насос: ${pump}`,
        `Кран: ${valve}`,
      ];
    }
    case 'thermostats': {
      const icon = item.inhibited === true ? '⚠️' : item.enabled === true ? '🟢' : '⚪';
      return [
        `${icon} ${name}`,
        `Состояние: ${thermostatStatus(item)}`,
        `Температура: ${thermostatTemperature(item)}`,
        `Уставка: ${reading(item.setpointC)}`,
      ];
    }
    case 'sockets':
    case 'lights':
      return item.available !== true || typeof item.actual !== 'boolean'
        ? [`⚫ ${name}`, 'Состояние: недоступно']
        : [
            `${item.actual ? '🟢' : '⚪'} ${name}`,
            `Состояние: ${item.actual ? 'включено' : 'выключено'}`,
          ];
  }
}

/** Show stored settings alongside separately qualified hardware feedback. */
export function controllerItemDetails(
  device: DeviceView,
  kind: ControllerKind,
  item: Row,
  fresh: boolean,
  moduleEnabled = true,
): string[] {
  const live = fresh && moduleEnabled;
  const info: string[] = [];
  switch (kind) {
    case 'sockets':
    case 'lights':
      info.push(
        `Реле: ${text(item.relayId, 'не назначено')}`,
        `Вход кнопки: ${text(item.inputId, 'не назначен')}`,
        `Сохранённое состояние: ${state(item.state, 'включено', 'выключено')}`,
        `Подтверждение реле: ${state(fresh ? item.actual : null, 'включено', 'выключено')}`,
      );
      if (item.inputId && live && typeof item.inputLevel === 'boolean')
        info.push(`Уровень входа: ${item.inputLevel ? 'HIGH' : 'LOW'}`);
      break;
    case 'meteo':
      info.push(
        `Датчик: ${item.sensorType === 'onewire' ? 'DS18B20 / OneWire' : item.sensorType === 'dht22' ? 'DHT22' : text(item.sensorType, '—')}`,
        `Порт: ${text(item.portId, 'не назначен')}`,
      );
      if (live && item.available === true && numeric(item.ageMs) && item.ageMs >= 0)
        info.push(`Возраст показания на момент получения: ${reading(item.ageMs / 1000, ' с')}`);
      if (item.sensorType === 'onewire' && item.address) info.push(`ROM: ${text(item.address)}`);
      break;
    case 'thermostats': {
      info.push(`Режим: ${mode(item.mode)}`);
      if (!live) info.push(`Уставка: ${reading(item.setpointC)}`);
      info.push(
        `Гистерезис: ${reading(item.hysteresisC)}`,
        `Датчик: ${text(item.sensorName, text(item.meteoId, 'не назначен'))}`,
        `Реле: ${text(item.relayId, 'не назначено')}`,
        `Подтверждение реле: ${state(fresh ? item.actual : null, 'включено', 'выключено')}`,
      );
      if (item.inputId) info.push(`Вход кнопки: ${text(item.inputId)}`);
      if (live && item.usingCachedTemperature === true)
        info.push('Используется последнее допустимое показание.');
      const hold = minimumCycle[text(item.holdReason)];
      if (
        live &&
        item.enabled === true &&
        typeof hold === 'string' &&
        numeric(item.holdRemainingSeconds)
      )
        info.push(
          `Ограничение: ${hold}`,
          `По данным PLC осталось ${reading(item.holdRemainingSeconds, ' с')}`,
        );
      const inputError = live ? text(item.inputError) : '';
      if (inputError) info.push(`⚠️ Кнопка: ${inputError}`);
      break;
    }
    case 'security': {
      const type = item.sensorType === 'motion' ? 'Датчик движения' : 'Геркон';
      info.push(
        `Тип: ${type}`,
        `Вход: ${text(item.inputId, 'не назначен')}`,
        `Задержка входа: ${state(item.entryDelay, 'применяется', 'выключена')}`,
        `Контакт: ${state(live && item.available === true ? item.closed : null, 'замкнут', 'разомкнут')}`,
      );
      break;
    }
    case 'tanks': {
      const inputs = Array.isArray(item.levelInputs) ? item.levelInputs : [];
      const wet = Array.isArray(item.levelsWet) ? item.levelsWet : [];
      const levels = Math.max(inputs.length, wet.length);
      const levelKnown = live && item.enabled === true && item.available === true;
      for (let i = 0; i < Math.min(3, levels); i++) {
        const port = text(inputs[i]);
        if (port) info.push(`Вход уровня ${i + 1}: ${port}`);
        info.push(
          `Уровень ${i + 1}: ${state(levelKnown ? wet[i] : null, 'датчик в воде', 'датчик сухой')}`,
        );
      }
      info.push(
        `Реле насоса: ${text(item.pumpRelayId, 'не назначено')}`,
        `Реле крана: ${text(item.valveRelayId, 'не назначено')}`,
      );
      if (item.valveRelayId !== '' && numeric(item.fillLevel))
        info.push(`Уровень закрытия крана: ${item.fillLevel}`);
      break;
    }
    case 'irrigation':
      info.push(
        `Дни полива: ${irrigationDays(item.days)}`,
        `Время старта: ${text(item.startTime, '—')}`,
        `Длительность: ${reading(item.durationMinutes, ' мин')}`,
        `Источник воды: ${irrigationTank(device, item)}`,
        `Кран: ${output(item.relayId, item.valveActual, 'открыт', 'закрыт', fresh)}`,
      );
      if (item.tankId)
        info.push(`Вода по нижнему датчику: ${water(live ? item.waterAvailable : null)}`);
      if (live && item.actual === true && numeric(item.remainingSeconds))
        info.push(`По данным PLC осталось ${reading(item.remainingSeconds, ' с')}`);
      break;
  }
  const error = live ? text(item.error) : '';
  if (error) info.push(`⚠️ ${error}`);
  return info;
}

function securityPhase(data: Row): string {
  const phase = phases[text(data.phase)];
  return typeof phase === 'string' ? phase : 'Неизвестный режим охраны';
}

/** Report module health and, for security, readiness and confirmed siren state. */
export function controllerModuleDetails(
  kind: ControllerKind,
  module: ControllerView | undefined,
  fresh: boolean,
): string[] {
  if (!module) return ['Модуль пока недоступен.'];
  const { data } = module;
  if (!fresh) return ['Состояние модуля устарело.'];
  if (data.enabled !== true) return ['⚪ Модуль выключен.'];
  const error = text(data.error);
  const lines = error ? [`⚠️ ${error}`] : [];
  if (kind !== 'security') return lines;

  const zones = rows(data.items);
  const available = zones.filter(
    (zone) => zone.available === true && typeof zone.active === 'boolean',
  );
  lines.push(
    securityPhase(data),
    `Зоны на связи: ${available.length}/${zones.length}`,
    `Сработавшие зоны: ${available.filter((zone) => zone.active === true).length}`,
    `Сирена: ${output(data.sirenRelayId, data.sirenActual, 'включена', 'выключена', data.sirenAvailable !== false)}`,
  );
  if (data.armed === false) {
    lines.push(`Постановка: ${state(data.readyToArm, 'готова', 'заблокирована')}`);
    if (data.readyToArm === false && data.armBlockReason)
      lines.push(`⚠️ ${text(data.armBlockReason)}`);
  }
  if (data.alarmReason && data.triggered === true)
    lines.push(`Причина тревоги: ${text(data.alarmReason)}`);
  if (numeric(data.remainingSeconds) && data.remainingSeconds > 0)
    lines.push(`По данным PLC осталось ${reading(data.remainingSeconds, ' с')}`);
  if (numeric(data.entryDelaySeconds) && numeric(data.exitDelaySeconds))
    lines.push(
      `Задержка входа: ${reading(data.entryDelaySeconds, ' с')}`,
      `Задержка выхода: ${reading(data.exitDelaySeconds, ' с')}`,
    );
  if (typeof data.readerPortId === 'string') {
    const reader = data.reader;
    lines.push(
      data.readerPortId
        ? `Считыватель iButton: ${state(object(reader) ? reader.available : null, 'на связи', 'недоступен')}`
        : 'Считыватель iButton: не назначен',
    );
  }
  if (numeric(data.keyCount)) lines.push(`Разрешённых ключей: ${data.keyCount}`);
  return lines;
}

/** Use counts only when the reported module can provide meaningful current values. */
export function controllerModuleSummaryLines(
  kind: ControllerKind,
  module: ControllerView,
  fresh: boolean,
): string[] {
  if (!fresh) return ['Состояние: данные устарели'];
  if (module.data.enabled !== true) return ['Состояние: модуль выключен'];
  if (kind === 'security') return [securityPhase(module.data)];
  const items = rows(module.data.items);
  if (kind === 'meteo')
    return [
      `С показаниями: ${items.filter((item) => item.available === true).length}/${items.length}`,
    ];
  if (kind === 'sockets' || kind === 'lights') {
    const known = items.filter(
      (item) => item.available === true && typeof item.actual === 'boolean',
    );
    const unavailable = items.length - known.length;
    return [
      `Включено: ${known.filter((item) => item.actual === true).length}/${items.length}`,
      ...(unavailable ? [`Недоступно: ${unavailable}`] : []),
    ];
  }
  return [`Включено: ${items.filter((item) => item.enabled === true).length}/${items.length}`];
}

export const telegramSettingLabels = {
  setpointC: '🌡️ Уставка',
  mode: '🎚️ Режим',
  hysteresisC: '↕️ Гистерезис',
  fillLevel: '💧 Уровень закрытия крана',
  days: '📅 Дни полива',
  startTime: '🕒 Время старта',
  durationMinutes: '⏱️ Длительность',
  tankId: '🛢 Бак',
} as const;

export function telegramTankChoiceLabel(id: string, label: string): string {
  return `${id ? '🛢' : '➖'} ${label}`;
}

export function telegramLevelChoiceLabels(levelCount: number): string[] {
  if (levelCount === 3) return ['💧 Нижний', '💧 Средний', '💧 Верхний'];
  if (levelCount === 2) return ['💧 Нижний', '💧 Верхний'];
  return levelCount === 1 ? ['💧 Датчик уровня'] : [];
}
