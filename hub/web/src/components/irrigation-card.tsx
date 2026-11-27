/** @file Одна плитка на локальное недельное правило полива. */
import {
  irrigationDays,
  irrigationRuleState,
  remoteTankReference,
} from '../../../shared/irrigation.js';
import type { ControllerView, DeviceView } from '../../../shared/types.js';
import { useId } from 'preact/hooks';
import { Icon } from '../icons';
import { deviceName, rows, text, type Row } from '../model';
import type { CommandAction, ConfigureIrrigation } from './types';
import './irrigation-card.css';

interface IrrigationCardProps {
  device: DeviceView;
  module: ControllerView;
  item: Row;
  pending: boolean;
  connected: boolean;
  controlsBlocked: boolean;
  onCommand: CommandAction;
  configureIrrigation?: ConfigureIrrigation;
  openDevice?: (id: string) => void;
}

export function IrrigationCard({
  device,
  module,
  item,
  pending,
  connected,
  controlsBlocked,
  onCommand,
  openDevice,
  configureIrrigation,
}: IrrigationCardProps) {
  const detailsId = useId();
  const id = text(item.id);
  const name = text(item.name, id);
  const tank = rows(device.controllers.tanks?.data.items).find((row) => row.id === item.tankId);
  const remoteTank = remoteTankReference(item.tankId)
    ? text(item.tankSourceLabel, text(item.tankId))
    : '';
  const fresh = connected && device.online && device.status === 'online' && module.fresh;
  const enabled = item.enabled === true;
  const known = fresh && typeof item.enabled === 'boolean';
  const active = known && module.data.enabled === true && enabled;
  const canCommand = known && module.data.enabled === true && !pending && !controlsBlocked;
  const edit =
    configureIrrigation && device.management?.supported && fresh
      ? () => configureIrrigation(device.id, id)
      : undefined;
  const fault = fresh ? text(item.error) : '';
  const state = !fresh
    ? 'Нет свежих данных'
    : module.data.enabled !== true
      ? 'Модуль выключен'
      : irrigationRuleState(item);
  const tone = !known
    ? 'unknown'
    : active && ((item.tankId !== '' && item.waterAvailable !== true) || fault)
      ? 'error'
      : active
        ? 'on'
        : 'off';
  const schedule = `${irrigationDays(item.days)} · ${text(item.startTime, '—')} · ${item.durationMinutes ?? '—'} мин`;
  const valve =
    !fresh || typeof item.valveActual !== 'boolean'
      ? 'нет данных'
      : item.valveActual
        ? 'открыт'
        : 'закрыт';
  return (
    <article
      class={
        openDevice
          ? `pult-tile pult-kind-irrigation pult-state-${tone}`
          : `equipment-card irrigation-card state-${tone}`
      }
      data-pult-tile={openDevice ? `${device.id}/irrigation/${id}` : undefined}
      data-pult-state={openDevice ? tone : undefined}
      data-controller-kind="irrigation"
      data-item-id={id}
      data-device-id={device.id}
    >
      <button
        type="button"
        class={openDevice ? 'pult-tile-face irrigation-face' : 'irrigation-face'}
        disabled={!canCommand}
        aria-busy={pending}
        aria-pressed={known ? enabled : 'mixed'}
        aria-label={`${enabled ? 'Выключить' : 'Включить'} правило полива «${name}»`}
        aria-describedby={detailsId}
        data-irrigation-enable
        data-pult-command={openDevice ? true : undefined}
        onClick={() => {
          if (canCommand) void onCommand(device.id, 'irrigation', id, !enabled);
        }}
      >
        <span class="irrigation-top">
          <span class={openDevice ? 'pult-tile-icon' : undefined}>
            <Icon name="irrigation" className="irrigation-symbol" />
          </span>
          <span class="irrigation-switch" aria-hidden="true">
            <Icon name={pending ? 'refresh' : 'power'} />
          </span>
        </span>
        <strong class="irrigation-name">{name}</strong>
        <span id={detailsId} class="irrigation-details">
          <span class="irrigation-schedule">{schedule}</span>
          {openDevice && remoteTank ? (
            <span class="irrigation-remote-tank" title={remoteTank}>
              <Icon name="tank" /> {remoteTank}
            </span>
          ) : null}
          <span class="irrigation-state" title={fault || undefined}>
            <span class="irrigation-dot" data-watering={fresh && item.actual === true} />
            {pending ? 'Ожидаем PLC…' : state}
          </span>
        </span>
      </button>
      {openDevice ? (
        <button
          class="pult-tile-source"
          type="button"
          aria-label={
            edit ? `Настроить правило «${name}»` : `Открыть контроллер ${deviceName(device)}`
          }
          onClick={edit ?? (() => openDevice(device.id))}
        >
          <span>{deviceName(device)}</span>
          <span>
            {edit ? 'Настроить' : 'Полив'} <Icon name={edit ? 'settings' : 'arrow'} />
          </span>
        </button>
      ) : (
        <div class="irrigation-ports">
          <span>
            Бак{' '}
            <b>
              {item.tankId === ''
                ? 'Без бака'
                : remoteTank || text(tank?.name, text(item.tankId, '—'))}
            </b>
          </span>
          <span>
            Кран{' '}
            <b>
              {text(item.relayId, '—')} · {valve}
            </b>
          </span>
          {edit ? (
            <button type="button" class="button secondary small" onClick={edit}>
              Настроить правило
            </button>
          ) : null}
          {fault ? <p class="inline-error">{fault}</p> : null}
        </div>
      )}
    </article>
  );
}
