/** @file Показания и управление отдельной розеткой, лампой, датчиком или термостатом. */

import type {
  ControllerKind,
  ControllerView,
  DeviceView,
  WritableControllerKind,
} from '../../../shared/types.js';
import { Icon, type IconName } from '../icons';
import { number, temperature, text, type Row } from '../model';
import type { CommandAction } from './types';

/** Показывает собственную иконку канала; активное состояние требует свежего подтверждения PLC. */
export function ItemCard({
  device,
  kind,
  module,
  item,
  pending,
  connected,
  controlsBlocked,
  onCommand,
}: {
  device: DeviceView;
  kind: ControllerKind;
  module: ControllerView;
  item: Row;
  pending: boolean;
  connected: boolean;
  controlsBlocked: boolean;
  onCommand: CommandAction;
}) {
  const id = text(item.id);
  const name = text(item.name, id);
  const fresh = module.fresh && device.online && device.status === 'online' && connected;
  const enabled = module.data.enabled === true;

  // Тип канала определяет иконку и смысл значения, но не заменяет проверку свежести.
  const sensor = kind === 'meteo';
  const thermostat = kind === 'thermostats';
  const zone = kind === 'security';
  const known = fresh && item.available === true;
  const active = known && (zone ? item.active === true : sensor ? true : item.actual === true);
  const icon: IconName =
    kind === 'lights'
      ? 'light'
      : kind === 'sockets'
        ? 'socket'
        : thermostat
          ? item.mode === 'cooling'
            ? 'cooling'
            : 'heating'
          : zone
            ? item.sensorType === 'motion'
              ? 'motion'
              : 'door'
            : item.sensorType === 'dht22'
              ? 'weather'
              : 'thermometer';
  const state = !fresh || !known ? 'unknown' : zone && active ? 'alarm' : active ? 'on' : 'off';
  const value = thermostat ? item.enabled === true : item.actual === true;

  // Кнопка доступна только при свежем состоянии и отсутствии конкурирующей операции.
  const canCommand =
    !sensor &&
    !zone &&
    fresh &&
    enabled &&
    !pending &&
    !controlsBlocked &&
    (thermostat ? typeof item.enabled === 'boolean' : known && typeof item.actual === 'boolean');
  const caption = !fresh
    ? 'Нет свежих данных'
    : zone
      ? !known
        ? 'Нет данных входа'
        : active
          ? 'Тревога'
          : 'Норма'
      : sensor
        ? known
          ? item.sensorType === 'dht22'
            ? 'Температура и влажность'
            : 'Температура'
          : 'Датчик недоступен'
        : thermostat
          ? value
            ? item.actual === true
              ? item.mode === 'cooling'
                ? 'Охлаждение'
                : 'Нагрев'
              : 'Поддержание'
            : 'Выключен'
          : !known
            ? 'Выход недоступен'
            : active
              ? 'Включено'
              : 'Выключено';
  const art = (
    <>
      <Icon name={icon} className="equipment-icon" />
      {sensor || thermostat ? (
        <div class="reading">
          <strong>{fresh && item.available === true ? temperature(item.temperatureC) : '—'}</strong>
          <span>°C</span>
        </div>
      ) : null}
      {sensor && number(item.humidityPct) !== null && known ? (
        <div class="humidity">
          Влажность <b>{number(item.humidityPct)?.toLocaleString('ru-RU')} %</b>
        </div>
      ) : null}
      <span class="equipment-state">{pending ? 'Ожидаем подтверждения…' : caption}</span>
    </>
  );

  return (
    <article
      class={`equipment-card tone-${kind} state-${state}`}
      data-item-id={id}
      data-controller-kind={kind}
    >
      {sensor || zone ? (
        <div class="equipment-visual" role="group" aria-label={`${name}: ${caption}`}>
          {art}
        </div>
      ) : (
        <button
          class="equipment-visual"
          onClick={() => {
            if (canCommand) void onCommand(device.id, kind as WritableControllerKind, id, !value);
          }}
          disabled={!canCommand}
          aria-label={`${value ? 'Выключить' : 'Включить'} ${name}`}
          aria-pressed={
            fresh && typeof (thermostat ? item.enabled : item.actual) === 'boolean'
              ? value
              : 'mixed'
          }
          aria-busy={pending}
        >
          {art}
          <span class="visual-action">
            {pending ? <Icon name="refresh" /> : <Icon name="power" />}
          </span>
        </button>
      )}
      <div class="equipment-copy">
        <h3>{name}</h3>
        <span class="port-label">
          {text(zone ? item.inputId : sensor ? item.portId : item.relayId)}
        </span>
        {thermostat ? (
          <div class="thermo-target">
            <span>
              Уставка <b>{temperature(item.setpointC)} °C</b>
            </span>
            <span>
              Гистерезис <b>{number(item.hysteresisC) ?? '—'}°</b>
            </span>
          </div>
        ) : null}
        <p>
          {zone
            ? item.sensorType === 'motion'
              ? 'Датчик движения'
              : 'Геркон двери / окна'
            : sensor
              ? item.sensorType === 'dht22'
                ? 'DHT22'
                : 'DS18B20 · OneWire'
              : thermostat
                ? item.mode === 'cooling'
                  ? 'Автономное охлаждение'
                  : 'Автономный нагрев'
                : text(item.inputId)
                  ? `Кнопка ${text(item.inputId)}`
                  : 'Управление из веба и хаба'}
        </p>
        {fresh && text(item.error) ? <p class="inline-error">{text(item.error)}</p> : null}
      </div>
    </article>
  );
}
