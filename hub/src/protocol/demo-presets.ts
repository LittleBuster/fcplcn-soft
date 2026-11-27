/** @file Initial virtual PLC wiring; subsequent settings are owned by the shared PLC model. */
import type { ControllerKind, Product } from '../../shared/types.js';

export interface DemoPreset {
  id: string;
  name: string;
  room: string;
  bootId: string;
  controllers: Record<ControllerKind, Record<string, unknown>>;
  temperatures: Record<string, number>;
  alarm?: boolean;
}

/** @brief Keep the original three-room demonstration while using firmware-compatible settings. */
export function demoPresets(
  product: Product,
  roms: (port: string) => string[],
  keys: readonly string[] = [],
): DemoPreset[] {
  const module = (items: Record<string, unknown>[] = [], enabled = false) => ({
    revision: 1,
    enabled,
    items,
  });
  const security = () => ({
    revision: 1,
    enabled: false,
    sirenRelayId: '',
    readerPortId: '',
    exitDelaySeconds: 30,
    entryDelaySeconds: 15,
    keys: [],
    items: [],
    armed: false,
    triggered: false,
  });
  const empty = () => ({
    sockets: module(),
    lights: module(),
    meteo: module(),
    thermostats: module(),
    security: security(),
    tanks: module(),
    irrigation: module(),
  });
  const outlet = (id: string, name: string, relay: number, state: boolean) => ({
    id,
    name,
    relayId: 'rly-0/' + relay,
    inputId: '',
    state,
  });
  const dht = (id: string, name: string) => ({
    id,
    name,
    portId: 'sens-0/1',
    sensorType: 'dht22',
    address: '',
  });
  const wire = (id: string, name: string) => ({
    id,
    name,
    portId: 'sens-0/2',
    sensorType: 'onewire',
    address: roms('sens-0/2')[0],
  });
  const thermostat = (
    id: string,
    name: string,
    meteoId: string,
    relay: number,
    setpointC: number,
  ) => ({
    id,
    name,
    meteoId,
    relayId: 'rly-0/' + relay,
    inputId: '',
    enabled: true,
    mode: 'heating',
    setpointC,
    hysteresisC: 1,
  });
  return [
    {
      id: product.id + '-demo-living',
      name: 'Гостиная',
      room: 'Первый этаж',
      bootId: 'demo-living-boot',
      controllers: {
        ...empty(),
        sockets: module(
          [
            outlet('socket-tv', 'Медиацентр', 1, true),
            outlet('socket-window', 'Розетка у окна', 2, false),
          ],
          true,
        ),
        lights: module(
          [
            outlet('light-main', 'Основной свет', 3, true),
            outlet('light-evening', 'Вечерний свет', 4, false),
          ],
          true,
        ),
        meteo: module(
          [dht('temp-living', 'Воздух в гостиной'), wire('temp-floor', 'Тёплый пол')],
          true,
        ),
        thermostats: module([thermostat('thermo-floor', 'Тёплый пол', 'temp-floor', 5, 27)], true),
      },
      temperatures: { 'temp-living': 21.8, 'temp-floor': 26.2 },
    },
    {
      id: product.id + '-demo-utility',
      name: 'Котельная',
      room: 'Технические помещения',
      bootId: 'demo-utility-boot',
      controllers: {
        ...empty(),
        sockets: module([outlet('socket-pump', 'Циркуляционный насос', 1, true)], true),
        lights: module([outlet('light-utility', 'Свет в котельной', 2, false)], true),
        meteo: module(
          [dht('temp-utility', 'Температура котельной'), wire('temp-water', 'Обратная линия')],
          true,
        ),
        thermostats: module(
          [thermostat('thermo-room', 'Отопление котельной', 'temp-utility', 3, 21)],
          true,
        ),
        irrigation: module(
          [
            {
              id: 'irrigation-garden',
              name: 'Полив сада',
              enabled: false,
              relayId: 'rly-0/8',
              tankId: 'tank-water',
              days: [1, 3, 5],
              startTime: '07:00',
              durationMinutes: 15,
            },
          ],
          true,
        ),
        tanks: module(
          [
            {
              id: 'tank-water',
              name: 'Бак с водой',
              pumpRelayId: 'rly-0/6',
              valveRelayId: 'rly-0/7',
              levelInputs: ['in-0/6', 'in-0/7'],
              fillLevel: 2,
              enabled: true,
            },
          ],
          true,
        ),
      },
      temperatures: { 'temp-utility': 19.4, 'temp-water': 42.5 },
    },
    {
      id: product.id + '-demo-garage',
      name: 'Гараж',
      room: 'Участок',
      bootId: 'demo-garage-boot',
      alarm: true,
      controllers: {
        ...empty(),
        lights: module([outlet('light-garage', 'Въездной свет', 1, true)], true),
        meteo: module([dht('temp-garage', 'Воздух в гараже')], true),
        security: {
          ...security(),
          enabled: true,
          readerPortId: keys.length ? 'sens-0/8' : '',
          keys: keys.length ? [{ id: 'demo-key', name: 'Ключ дома', address: keys[0] }] : [],
          sirenRelayId: 'rly-0/16',
          armed: true,
          triggered: true,
          items: [
            {
              id: 'zone-door',
              name: 'Входная дверь',
              inputId: 'in-0/1',
              sensorType: 'reed',
              entryDelay: false,
            },
            {
              id: 'zone-motion',
              name: 'Движение в гараже',
              inputId: 'in-0/2',
              sensorType: 'motion',
              entryDelay: false,
            },
          ],
        },
      },
      temperatures: { 'temp-garage': 12.3 },
    },
  ];
}
