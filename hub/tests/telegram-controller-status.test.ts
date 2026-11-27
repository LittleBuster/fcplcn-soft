/** @file Telegram reads PLC humidity and distinguishes actual outputs from settings. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  controllerItemDetails,
  controllerItemStatusLines,
  controllerModuleDetails,
  controllerModuleSummaryLines,
} from '../shared/telegram-controller-status.js';
import type { ControllerView, DeviceView } from '../shared/types.js';

const device: DeviceView = {
  id: 'fcplcn-target',
  name: 'Участок',
  room: '',
  boardId: 'test',
  firmwareVersion: 'test',
  bootId: 'boot',
  status: 'online',
  online: true,
  lastSeenAt: null,
  uptimeSec: 100,
  controllers: {},
};

test('Meteo renders the firmware humidity field and omits stale measurements', () => {
  const air = {
    name: 'Датчик',
    available: true,
    sensorType: 'dht22',
    temperatureC: 21.5,
    humidityPct: 48.6,
    ageMs: 250,
  };
  assert.deepEqual(controllerItemStatusLines('meteo', air, true), [
    '🌡 Датчик',
    'Температура: 21,5 °C',
    'Влажность: 48,6 %',
  ]);
  assert.deepEqual(controllerItemStatusLines('meteo', air, false), [
    '⚫ Датчик',
    'Состояние: данные устарели',
  ]);
  assert.deepEqual(controllerItemStatusLines('meteo', { ...air, available: false }, true), [
    '⚫ Датчик',
    'Температура: нет показаний',
  ]);
  assert.match(controllerItemDetails(device, 'meteo', air, true).join('\n'), /Датчик: DHT22/);
});

test('Telegram keeps a configured thermostat distinct from observed feedback and pause', () => {
  const thermostat = {
    name: 'Дом',
    enabled: true,
    sensorAvailable: true,
    temperatureC: 26,
    mode: 'cooling',
    setpointC: 23,
    hysteresisC: 1,
    actual: false,
    holdReason: 'minimum_off',
    holdRemainingSeconds: 17,
    relayId: 'rly-0/2',
  };
  assert.deepEqual(controllerItemStatusLines('thermostats', thermostat, true), [
    '🟢 Дом',
    'Состояние: выдерживает паузу',
    'Температура: 26 °C',
    'Уставка: 23 °C',
  ]);
  assert.match(
    controllerItemDetails(device, 'thermostats', thermostat, true).join('\n'),
    /Ограничение: Минимальная пауза\nПо данным PLC осталось 17 с/,
  );
  assert.doesNotMatch(
    controllerItemDetails(device, 'thermostats', thermostat, false).join('\n'),
    /17 с|выключено/,
  );
  assert.match(
    controllerItemStatusLines('thermostats', { ...thermostat, actual: null }, true).join('\n'),
    /нет данных выхода/,
  );

  const socket = { id: 'socket', name: 'Розетка', actual: null, available: true, state: true };
  const module: ControllerView = {
    kind: 'sockets',
    fresh: true,
    receivedAt: '',
    data: { enabled: true, items: [socket] },
  };
  assert.deepEqual(controllerModuleSummaryLines('sockets', module, true), [
    'Включено: 0/1',
    'Недоступно: 1',
  ]);
  assert.match(
    controllerItemDetails(device, 'sockets', socket, true).join('\n'),
    /Сохранённое состояние: включено\nПодтверждение реле: нет данных/,
  );
});

test('irrigation presents a labelled remote tank and separates a running rule from an open valve', () => {
  const row = {
    id: 'sprinkler',
    enabled: true,
    tankId: 'fcplcn-shed/stock',
    tankSourceLabel: 'Гараж · Запас воды',
    days: [1, 5],
    startTime: '06:30',
    durationMinutes: 12,
    remainingSeconds: 34,
    actual: false,
    valveActual: true,
    waterAvailable: true,
  };
  const detail = controllerItemDetails(device, 'irrigation', row, true).join('\n');
  assert.match(detail, /Дни полива: Пн, Пт\nВремя старта: 06:30\nДлительность: 12 мин/);
  assert.match(detail, /Источник воды: Гараж · Запас воды/);
  assert.match(detail, /Кран: открыт\nВода по нижнему датчику: есть/);
  assert.deepEqual(controllerItemStatusLines('irrigation', row, true), [
    '💧 sprinkler',
    'Состояние: Ожидает старта',
  ]);
  assert.doesNotMatch(detail, /34 с/);
  assert.match(
    controllerItemDetails(device, 'irrigation', row, false).join('\n'),
    /Кран: нет данных\nВода по нижнему датчику: нет данных/,
  );
});

test('security details report readiness and preserve iButton allowlist privacy', () => {
  const module: ControllerView = {
    kind: 'security',
    fresh: true,
    receivedAt: '',
    data: {
      enabled: true,
      armed: false,
      phase: 'disarmed',
      entryDelaySeconds: 15,
      exitDelaySeconds: 30,
      readyToArm: false,
      armBlockReason: 'Зона открыта',
      sirenRelayId: 'rly-0/5',
      sirenAvailable: false,
      sirenActual: true,
      readerPortId: 'sens-0/6',
      reader: { available: true, address: 'private-reader-ROM' },
      keys: [{ address: 'private-key-ROM', name: 'Private key' }],
      keyCount: 1,
      items: [{ id: 'door', available: false, active: true }],
    },
  };
  const details = controllerModuleDetails('security', module, true).join('\n');
  assert.match(details, /Зоны на связи: 0\/1\nСработавшие зоны: 0/);
  assert.match(details, /Задержка входа: 15 с\nЗадержка выхода: 30 с/);
  assert.match(details, /Сирена: нет данных/);
  assert.match(details, /Постановка: заблокирована\n⚠️ Зона открыта/);
  assert.match(details, /Считыватель iButton: на связи\nРазрешённых ключей: 1/);
  assert.doesNotMatch(details, /private/i);
});
