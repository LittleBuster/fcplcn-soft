/** @file Крупная touch-карточка канала: подтверждённое состояние, явная команда и переход к PLC. */
import { Icon, type IconName } from '../../icons';
import { deviceName, number, temperature, text } from '../../model';
import type { CommandAction } from '../../components/types';
import { pultFresh, pultLabels, type PultEntry } from './model';

interface PultControlTileProps {
  entry: PultEntry;
  pending: boolean;
  connected: boolean;
  controlsBlocked: boolean;
  onCommand: CommandAction;
  openDevice: (id: string) => void;
}

/** Показывает переключение только после ответа PLC; устаревшие данные блокируют команду. */
export function PultControlTile({
  entry,
  pending,
  connected,
  controlsBlocked,
  onCommand,
  openDevice,
}: PultControlTileProps) {
  const { device, module, item, kind } = entry;
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
  const error = fresh ? text(item.error) : '';
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
            : thermostat
              ? !value
                ? 'Выключен'
                : !available || typeof item.actual !== 'boolean'
                  ? 'Ожидаем датчик'
                  : item.actual
                    ? item.mode === 'cooling'
                      ? 'Охлаждение'
                      : 'Нагрев'
                    : 'Поддержание'
              : value
                ? 'Включено'
                : 'Выключено';
  const tone =
    !fresh || !known
      ? 'unknown'
      : error
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
              <span class="pult-tile-reading" data-pult-humidity aria-label="Влажность">
                {available && humidity !== null
                  ? humidity.toLocaleString('ru-RU', { maximumFractionDigits: 1 })
                  : '—'}
                <small>%</small>
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
        <span class="pult-state-dot" />
        {caption}
      </span>
      {thermostat ? (
        <span class="pult-tile-extra">Задано {fresh ? temperature(item.setpointC) : '—'} °C</span>
      ) : null}
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
