/** @file Крупная touch-карточка канала: подтверждённое состояние, явная команда и переход к PLC. */
import { IrrigationCard } from '../../components/irrigation-card';
import { TankCard } from '../../components/tank-card';
import { Icon, type IconName } from '../../icons';
import { deviceName, number, temperature, text } from '../../model';
import type { CommandAction, ConfigureIrrigation } from '../../components/types';
import { MeteoHistoryButton } from '../meteo/history-button';
import { pultFresh, pultLabels, type PultEntry } from './model';

interface PultControlTileProps {
  entry: PultEntry;
  pending: boolean;
  connected: boolean;
  controlsBlocked: boolean;
  onCommand: CommandAction;
  configureIrrigation?: ConfigureIrrigation;
  openDevice: (id: string) => void;
}

const thermostatCaptions = {
  heating: 'Нагрев',
  cooling: 'Охлаждение',
  holding: 'Поддержание',
  waiting: 'Ожидаем датчик',
  off: 'Выключен',
  error: 'Ошибка термостата',
  unknown: 'Состояние неизвестно',
};

/** Показывает переключение только после ответа PLC; устаревшие данные блокируют команду. */
export function PultControlTile({
  entry,
  pending,
  connected,
  controlsBlocked,
  onCommand,
  configureIrrigation,
  openDevice,
}: PultControlTileProps) {
  const { device, module, item, kind } = entry;
  if (kind === 'tanks' || kind === 'irrigation') {
    const Card = kind === 'tanks' ? TankCard : IrrigationCard;
    return (
      <Card
        device={device}
        module={module}
        item={item}
        pending={pending}
        connected={connected}
        controlsBlocked={controlsBlocked}
        configureIrrigation={configureIrrigation}
        onCommand={onCommand}
        openDevice={openDevice}
      />
    );
  }
  const id = text(item.id);
  const name = text(item.name, id);
  const sensor = kind === 'meteo';
  const thermostat = kind === 'thermostats';
  const fresh = pultFresh(entry, connected);
  const moduleEnabled = module.data.enabled === true;
  const available = fresh && item.available === true;
  const measurementKnown = available && number(item.temperatureC) !== null;
  const humidity = number(item.humidityPct);
  const hasHumidity = sensor && (item.sensorType === 'dht22' || humidity !== null);
  const known =
    fresh &&
    (sensor
      ? measurementKnown
      : thermostat
        ? typeof item.enabled === 'boolean'
        : available && typeof item.actual === 'boolean');
  const value = thermostat ? item.enabled === true : item.actual === true;
  const active = known && moduleEnabled && value;
  const canCommand = !sensor && fresh && moduleEnabled && known && !pending && !controlsBlocked;
  const icon: IconName =
    kind === 'lights'
      ? 'light'
      : kind === 'sockets'
        ? 'socket'
        : thermostat
          ? item.mode === 'cooling'
            ? 'cooling'
            : 'heating'
          : item.sensorType === 'dht22'
            ? 'weather'
            : 'thermometer';
  const diagnostic = fresh ? text(item.error) : '';
  let thermostatState: keyof typeof thermostatCaptions | undefined;
  if (thermostat) {
    if (!known) thermostatState = 'unknown';
    else if (item.inhibited === true) thermostatState = 'error';
    else if (!active) thermostatState = 'off';
    else if (diagnostic && (item.sensorAvailable === true || item.actual === null))
      thermostatState = 'error';
    else if (!available || typeof item.actual !== 'boolean') thermostatState = 'waiting';
    else if (!item.actual) thermostatState = 'holding';
    else thermostatState = item.mode === 'cooling' ? 'cooling' : 'heating';
  }
  const error = thermostatState === 'off' ? '' : diagnostic;
  const caption = !fresh
    ? 'Нет свежих данных'
    : !moduleEnabled
      ? 'Модуль выключен'
      : pending
        ? 'Ожидаем PLC…'
        : sensor
          ? measurementKnown
            ? 'Свежее измерение'
            : 'Датчик недоступен'
          : !known
            ? 'Состояние неизвестно'
            : thermostatState
              ? thermostatCaptions[thermostatState]
              : value
                ? 'Включено'
                : 'Выключено';
  const tone =
    !fresh || !known
      ? 'unknown'
      : thermostatState === 'error' || (!thermostat && error)
        ? 'error'
        : active || (sensor && measurementKnown)
          ? 'on'
          : 'off';

  const contents = (
    <>
      <span class="pult-tile-top">
        <span class="pult-tile-icon">
          <Icon name={icon} />
        </span>
        {sensor || thermostat ? (
          <span class="pult-tile-readings">
            <span class="pult-tile-reading" data-pult-reading aria-label="Температура">
              {available ? temperature(item.temperatureC) : '—'}
              <small>°C</small>
            </span>
            {hasHumidity ? (
              <span
                class="pult-tile-reading pult-tile-humidity"
                data-pult-humidity
                aria-label="Влажность"
              >
                {available && humidity !== null
                  ? humidity.toLocaleString('ru-RU', { maximumFractionDigits: 1 })
                  : '—'}
                <small>%</small>
              </span>
            ) : thermostat ? (
              <span class="pult-tile-reading pult-tile-setpoint" data-pult-setpoint>
                <span class="pult-setpoint-label">Задано</span>
                <span>
                  {fresh ? temperature(item.setpointC) : '—'}
                  <small>°C</small>
                </span>
              </span>
            ) : null}
          </span>
        ) : (
          <span class="pult-tile-power" aria-hidden="true">
            <Icon name={pending ? 'refresh' : 'power'} />
          </span>
        )}
      </span>
      <span class="pult-tile-name">{name}</span>
      <span class="pult-tile-state">
        <span
          class="pult-state-dot"
          data-thermostat-state={thermostatState && pending && active ? 'waiting' : thermostatState}
          aria-hidden="true"
        />
        {caption}
      </span>
      {error ? <span class="pult-tile-error">{error}</span> : null}
    </>
  );

  return (
    <article
      class={`pult-tile pult-kind-${kind} pult-state-${tone}${hasHumidity ? ' pult-has-humidity' : ''}`}
      data-pult-tile={entry.key}
      data-device-id={device.id}
      data-controller-kind={kind}
      data-item-id={id}
      data-pult-state={tone}
    >
      {sensor ? (
        <div
          class="pult-tile-face pult-tile-sensor"
          role="group"
          aria-label={`${name}: ${caption}`}
        >
          {contents}
          <MeteoHistoryButton deviceId={device.id} sensorId={id} name={name} />
        </div>
      ) : (
        <button
          type="button"
          class="pult-tile-face"
          disabled={!canCommand}
          data-pult-command
          onClick={() => {
            if (canCommand) void onCommand(device.id, kind, id, !value);
          }}
          aria-label={`${value ? 'Выключить' : 'Включить'} ${name}`}
          aria-pressed={known ? value : 'mixed'}
          aria-busy={pending}
        >
          {contents}
        </button>
      )}
      <button
        class="pult-tile-source"
        type="button"
        aria-label={`Открыть контроллер ${deviceName(device)}`}
        onClick={() => openDevice(device.id)}
      >
        <span>{deviceName(device)}</span>
        <span>
          {pultLabels[kind]} <Icon name="arrow" />
        </span>
      </button>
    </article>
  );
}
