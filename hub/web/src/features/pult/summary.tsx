/** @file Компактная сводка пульта по фактической охране, одному датчику воздуха и связи. */
import type { HubSnapshot } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { deviceName, temperature, text } from '../../model';
import { pultAirReading, type PultEntry } from './model';

/** Приоритет тревоги выше отсутствующей связи; неподтверждённые модули не выглядят снятыми. */
function securitySummary(snapshot: HubSnapshot, connected: boolean) {
  const modules = snapshot.devices.flatMap((device) => {
    const module = device.controllers.security;
    return module && module.data.enabled === true ? [{ device, module }] : [];
  });
  const fresh = modules.filter(
    ({ device, module }) =>
      connected && device.online && device.status === 'online' && module.fresh,
  );
  const alarms = fresh.filter(
    ({ module }) => module.data.triggered === true || module.data.phase === 'alarm',
  );
  const entering = fresh.some(({ module }) => module.data.phase === 'entry_delay');
  const exiting = fresh.some(({ module }) => module.data.phase === 'exit_delay');
  const armed = fresh.filter(({ module }) => module.data.armed === true);
  const disarmed = fresh.filter(({ module }) => module.data.armed === false);
  const label = alarms.length
    ? 'Тревога'
    : !modules.length
      ? 'Не настроена'
      : fresh.length !== modules.length
        ? 'Нет свежих данных'
        : entering
          ? 'Время на снятие'
          : exiting
            ? 'Постановка'
            : armed.length === modules.length
              ? 'Под охраной'
              : disarmed.length === modules.length
                ? 'Охрана снята'
                : 'Разные режимы';
  const detail = alarms.length
    ? alarms.map(({ device }) => deviceName(device)).join(', ')
    : !modules.length
      ? 'Нет включённых модулей'
      : `${fresh.length} из ${modules.length} PLC на связи`;
  return { label, detail, alarm: alarms.length > 0 };
}

/** Показывает сводку без команд постановки и без запуска домашних сценариев. */
export function PultSummary({
  snapshot,
  entries,
  connected,
}: {
  snapshot: HubSnapshot;
  entries: PultEntry[];
  connected: boolean;
}) {
  const security = securitySummary(snapshot, connected);
  const air = pultAirReading(entries, connected);
  const online = connected
    ? snapshot.devices.filter((device) => device.online && device.status === 'online').length
    : 0;
  return (
    <div class="pult-summary">
      <section
        class={`pult-summary-card pult-summary-security${security.alarm ? ' pult-summary-alarm' : ''}`}
        data-pult-security
        aria-label="Состояние охраны"
      >
        <span class="pult-summary-icon">
          <Icon name={security.alarm ? 'alarm' : 'shield'} />
        </span>
        <div>
          <span class="pult-summary-label">Охрана дома</span>
          <strong>{security.label}</strong>
          <small>{security.detail}</small>
        </div>
      </section>
      <section class="pult-summary-card pult-summary-climate" aria-label="Температура воздуха">
        <span class="pult-summary-icon">
          <Icon name="thermometer" />
        </span>
        <div>
          <span class="pult-summary-label">Температура</span>
          <strong>{air ? `${temperature(air.item.temperatureC)} °C` : '—'}</strong>
          <small>
            {air
              ? `${deviceName(air.device)} · ${text(air.item.name, 'Датчик температуры')}`
              : 'Ждём свежие показания'}
          </small>
        </div>
      </section>
      <section class="pult-summary-card pult-summary-network" aria-label="Связь с устройствами">
        <span class="pult-summary-icon">
          <Icon name="wifi" />
        </span>
        <div>
          <span class="pult-summary-label">Устройства</span>
          <strong>
            {online}
            <span class="pult-summary-total"> / {snapshot.devices.length}</span>
          </strong>
          <small>
            {!connected
              ? 'Управление недоступно'
              : online === snapshot.devices.length && online > 0
                ? 'Все устройства на связи'
                : 'На связи с хабом'}
          </small>
        </div>
      </section>
    </div>
  );
}
