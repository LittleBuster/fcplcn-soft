/** @file Компактная сводка пульта по фактической охране, одному датчику воздуха и связи. */
import { useRef, useState } from 'preact/hooks';
import type { HubSnapshot } from '../../../../shared/types.js';
import type { PultSettingsView } from '../../../../shared/pult.js';
import { Icon } from '../../icons';
import { deviceName, temperature, text } from '../../model';
import { canConfigure } from '../../portal';
import { pultAirReading, type PultEntry } from './model';
import { PultNetworkSummary } from './network-summary';
import { TemperatureSettings } from './temperature-settings';

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
  onPultSettingsSaved,
}: {
  snapshot: HubSnapshot;
  entries: PultEntry[];
  connected: boolean;
  onPultSettingsSaved?: (value: PultSettingsView) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [accepted, setAccepted] = useState<PultSettingsView | null>(null);
  const configureButton = useRef<HTMLButtonElement>(null);
  const security = securitySummary(snapshot, connected);
  const settings =
    snapshot.pult && (!accepted || snapshot.pult.revision >= accepted.revision)
      ? snapshot.pult
      : accepted;
  const source = settings?.temperatureSource;
  const entry = source
    ? entries.find(
        (value) =>
          value.kind === 'meteo' &&
          value.device.id === source.deviceId &&
          text(value.item.id) === source.itemId,
      )
    : undefined;
  const air = pultAirReading(entries, connected, source);
  const sourceLabel = source
    ? `${entry ? deviceName(entry.device) : source.deviceName} · ${entry ? text(entry.item.name, source.itemName) : source.itemName}`
    : 'Выберите датчик';
  const closeSettings = () => {
    setEditing(false);
    configureButton.current?.focus({ preventScroll: true });
  };
  return (
    <>
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
        <section
          class="pult-summary-card pult-summary-climate"
          aria-label="Температура воздуха"
          data-pult-temperature
        >
          {canConfigure ? (
            <button
              ref={configureButton}
              type="button"
              class="pult-summary-icon pult-temperature-configure"
              data-pult-temperature-configure
              aria-label="Выбрать датчик температуры"
              title="Выбрать датчик температуры"
              aria-expanded={editing}
              aria-controls="pult-temperature-settings"
              onClick={() => setEditing(true)}
            >
              <Icon name="thermometer" />
              <span class="pult-temperature-configure-badge">
                <Icon name="settings" />
              </span>
            </button>
          ) : (
            <span class="pult-summary-icon">
              <Icon name="thermometer" />
            </span>
          )}
          <div>
            <span class="pult-summary-label">Температура</span>
            <strong data-pult-temperature-value>
              {air ? `${temperature(air.item.temperatureC)} °C` : '—'}
            </strong>
            <small data-pult-temperature-source>{sourceLabel}</small>
            {source && !air ? (
              <small class="pult-temperature-unavailable" data-pult-temperature-status>
                Нет свежих данных
              </small>
            ) : null}
          </div>
        </section>
        <PultNetworkSummary snapshot={snapshot} connected={connected} />
      </div>
      {editing && canConfigure ? (
        <TemperatureSettings
          entries={entries}
          settings={settings}
          onSaved={(value) => {
            setAccepted(value);
            onPultSettingsSaved?.(value);
          }}
          onClose={closeSettings}
        />
      ) : null}
    </>
  );
}
