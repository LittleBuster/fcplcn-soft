/** @file Confirmed tank monitoring and local automatic outputs, shared by hub and cloud. */
import { useId } from 'preact/hooks';
import type { ControllerView, DeviceView } from '../../../shared/types.js';
import { Icon } from '../icons';
import { deviceName, number, text, type Row } from '../model';
import type { CommandAction } from './types';
import './tank-card.css';

/** Draw a cylindrical vessel; missing measurements never become an empty/full reading. */
export function TankDiagram({
  level,
  levels,
  compact = false,
}: {
  level: number | null;
  levels: unknown[];
  compact?: boolean;
}) {
  const id = useId().replace(/:/g, '-');
  const known = level !== null && level >= 0 && level <= 100;
  const surface = 145 - (known ? (115 * level) / 100 : 0);
  return (
    <svg
      class="tank-cylinder"
      viewBox="0 0 220 180"
      role="img"
      aria-label={known ? `Уровень воды ${level} %` : 'Нет достоверных данных об уровне воды'}
      data-tank-level={known ? level : 'unknown'}
    >
      <defs>
        <linearGradient id={`${id}-shell`} x1="0" x2="1">
          <stop stop-color="#213a4b" />
          <stop offset=".45" stop-color="#29495a" />
          <stop offset="1" stop-color="#172d3c" />
        </linearGradient>
        <linearGradient id={`${id}-water`} x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#80e1ff" />
          <stop offset="1" stop-color="#238ac6" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <path d="M45 30c0-22 130-22 130 0v115c0 22-130 22-130 0Z" />
        </clipPath>
      </defs>
      <path d="M45 30c0-22 130-22 130 0v115c0 22-130 22-130 0Z" fill={`url(#${id}-shell)`} />
      {known && level > 0 ? (
        <g clip-path={`url(#${id}-clip)`} data-tank-water>
          <rect x="45" y={surface} width="130" height={162 - surface} fill={`url(#${id}-water)`} />
          <ellipse cx="110" cy={surface} rx="65" ry="15" fill="#8ae5ff" opacity=".8" />
          <path
            d={`M55 ${surface + 5}q28-8 55 0t55 0`}
            fill="none"
            stroke="#d5f6ff"
            opacity=".6"
            stroke-width="2"
          />
        </g>
      ) : null}
      <path
        d="M45 30c0-22 130-22 130 0v115c0 22-130 22-130 0Z"
        fill="none"
        stroke={known ? '#8dc9df' : '#6e8497'}
        stroke-width="2.5"
      />
      <ellipse cx="110" cy="30" rx="65" ry="16" fill="none" stroke="#8dc9df" stroke-width="2" />
      <path d="M57 45v86" stroke="#d2ecf5" stroke-width="5" opacity=".12" stroke-linecap="round" />
      {!compact ? (
        <text x="110" y="110" text-anchor="middle" class="tank-level-number">
          {known ? `${level} %` : '—'}
        </text>
      ) : null}
      {(compact ? [] : levels).map((wet, index) => (
        <g
          key={index}
          transform={`translate(187 ${levels.length === 1 ? 132 : 132 - (100 * index) / (levels.length - 1)})`}
        >
          <path d="M-10 0H0" stroke="#7f9dad" stroke-width="2" />
          <circle
            r="5"
            fill={known && wet === true ? '#7cdef5' : '#263c4c'}
            stroke="#8db7cc"
            stroke-width="1.5"
          />
        </g>
      ))}
    </svg>
  );
}

/** Monitoring permission is explicit; draining and filling themselves are always PLC-local. */
export function TankCard({
  device,
  module,
  item,
  pending,
  connected,
  controlsBlocked,
  onCommand,
  openDevice,
}: {
  device: DeviceView;
  module: ControllerView;
  item: Row;
  pending: boolean;
  connected: boolean;
  controlsBlocked: boolean;
  onCommand: CommandAction;
  openDevice?: (id: string) => void;
}) {
  const outputsDescriptionId = useId();
  const fresh = connected && device.online && device.status === 'online' && module.fresh;
  const monitoring = item.enabled === true;
  const active = fresh && module.data.enabled === true && monitoring;
  const rawLevel = number(item.levelPct);
  const level =
    active && item.available === true && rawLevel !== null && rawLevel >= 0 && rawLevel <= 100
      ? rawLevel
      : null;
  const diagnostic = fresh ? text(item.error) : '';
  // PLC telemetry uses the diagnostic field for the normal input confirmation period too.
  const awaitingLevel =
    active &&
    level === null &&
    (!diagnostic || diagnostic === 'Ожидается подтверждение датчиков уровня');
  const error = awaitingLevel ? '' : diagnostic;
  const levels = Array.isArray(item.levelsWet) ? item.levelsWet : [];
  const id = text(item.id),
    name = text(item.name, id);
  const canCommand =
    fresh &&
    module.data.enabled === true &&
    typeof item.enabled === 'boolean' &&
    !pending &&
    !controlsBlocked;
  const caption = !fresh
    ? 'Нет свежих данных'
    : module.data.enabled !== true
      ? 'Модуль выключен'
      : pending
        ? 'Ожидаем PLC…'
        : !monitoring
          ? 'Мониторинг выключен'
          : awaitingLevel
            ? 'Ожидаем датчики…'
            : level === null
              ? 'Нет данных уровня'
              : level === 0
                ? 'Воды нет'
                : level === 100
                  ? 'Бак заполнен'
                  : 'Мониторинг включён';
  const output = (relayId: unknown, value: unknown, on: string, off: string) =>
    !text(relayId)
      ? 'Не назначен'
      : !fresh || typeof value !== 'boolean'
        ? 'Нет данных'
        : value
          ? on
          : off;
  if (openDevice) {
    const fault = active ? error : '';
    const tone = !fresh ? 'unknown' : fault ? 'error' : active ? 'on' : 'off';
    const state = !fresh
      ? 'Нет свежих данных'
      : module.data.enabled !== true
        ? 'Модуль выключен'
        : pending
          ? 'Ожидаем PLC…'
          : monitoring
            ? fault
              ? 'Ошибка бака'
              : awaitingLevel
                ? 'Ожидаем датчики…'
                : 'Мониторинг вкл.'
            : 'Мониторинг выкл.';
    const outputs = [
      {
        key: 'pump',
        label: 'Насос',
        relayId: item.pumpRelayId,
        actual: item.pumpActual,
        on: 'Работает',
        off: 'Выключен',
      },
      {
        key: 'valve',
        label: 'Кран',
        relayId: item.valveRelayId,
        actual: item.valveActual,
        on: 'Открыт',
        off: 'Закрыт',
      },
    ].map(({ key, label, relayId, actual, on, off }) => {
      const known = fresh && Boolean(text(relayId)) && typeof actual === 'boolean';
      return {
        key,
        label,
        state: !known ? 'unknown' : actual ? 'on' : 'off',
        description: `${label}: ${output(relayId, actual, on, off)}`,
      };
    });
    return (
      <article
        class={`pult-tile pult-kind-tanks pult-state-${tone}`}
        data-controller-kind="tanks"
        data-item-id={id}
        data-device-id={device.id}
        data-pult-tile={`${device.id}/tanks/${id}`}
        data-pult-state={tone}
      >
        <button
          type="button"
          class="pult-tile-face pult-tank-face"
          disabled={!canCommand}
          onClick={() => {
            if (canCommand) void onCommand(device.id, 'tanks', id, !monitoring);
          }}
          aria-label={`${monitoring ? 'Выключить' : 'Включить'} мониторинг ${name}`}
          aria-describedby={outputsDescriptionId}
          aria-pressed={fresh ? monitoring : 'mixed'}
          aria-busy={pending}
          data-tank-monitoring
          data-pult-command
        >
          <span class="pult-tile-top pult-tank-top">
            <TankDiagram level={level} levels={levels} compact />
            <span class="pult-tile-reading pult-tank-reading">
              {level === null ? '—' : level}
              <small>%</small>
            </span>
            <span class="pult-tile-power" aria-hidden="true">
              <Icon name={pending ? 'refresh' : 'power'} />
            </span>
          </span>
          <span class="pult-tile-name">{name}</span>
          <span class="pult-tank-statuses">
            <span class="pult-tile-state" title={fault || undefined}>
              <span class="pult-state-dot" />
              {state}
            </span>
            {outputs.map((row) => (
              <span
                key={row.key}
                class="pult-tile-state"
                data-tank-output={row.key}
                data-output-state={row.state}
                title={row.description}
              >
                <span class="pult-state-dot" />
                {row.label}
              </span>
            ))}
          </span>
          <span hidden id={outputsDescriptionId}>
            {outputs.map((row) => row.description).join('. ')}
          </span>
        </button>
        <button
          type="button"
          class="pult-tile-source"
          aria-label={`Открыть контроллер ${deviceName(device)}`}
          onClick={() => openDevice(device.id)}
        >
          <span>{deviceName(device)}</span>
          <span>
            Баки <Icon name="arrow" />
          </span>
        </button>
      </article>
    );
  }
  const labels =
    levels.length === 3
      ? ['Нижний', 'Средний', 'Верхний']
      : levels.length === 2
        ? ['Нижний', 'Верхний']
        : ['Уровень'];
  return (
    <article
      class={`tank-card equipment-card ${level === null ? 'tank-unknown' : ''}`}
      data-controller-kind="tanks"
      data-item-id={id}
      data-device-id={device.id}
    >
      <button
        type="button"
        class="tank-control"
        disabled={!canCommand}
        onClick={() => {
          if (canCommand) void onCommand(device.id, 'tanks', id, !monitoring);
        }}
        aria-label={`${monitoring ? 'Выключить' : 'Включить'} мониторинг ${name}`}
        aria-pressed={fresh ? monitoring : 'mixed'}
        aria-busy={pending}
        data-tank-monitoring
      >
        <TankDiagram level={level} levels={levels} />
        <span class="tank-copy">
          <strong>{name}</strong>
          <span class="tank-monitoring-status">
            <Icon name={pending ? 'refresh' : 'power'} />
            {caption}
          </span>
          <span class="tank-output">
            <span>Насос откачки</span>
            <b>{output(item.pumpRelayId, item.pumpActual, 'Работает', 'Выключен')}</b>
          </span>
          <span class="tank-output">
            <span>Кран наполнения</span>
            <b>{output(item.valveRelayId, item.valveActual, 'Открыт', 'Закрыт')}</b>
          </span>
        </span>
      </button>
      <div class="tank-levels" aria-label="Датчики уровня">
        {levels.map((wet, index) => (
          <span key={index} class={active && wet === true ? 'wet' : ''}>
            {labels[index]}
            <b>{!active || wet === null ? '—' : wet ? 'Вода' : 'Сухо'}</b>
          </span>
        ))}
      </div>
      {error ? (
        <p class="tank-error" role="status">
          {error}
        </p>
      ) : null}
      <p class="tank-estimate">Уровень — оценка по датчикам.</p>
    </article>
  );
}
