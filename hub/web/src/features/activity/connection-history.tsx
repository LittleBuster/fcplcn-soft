import { useEffect, useId, useState } from 'preact/hooks';
import type {
  ConnectionFleetHistory,
  ConnectionHistory,
  ConnectionHistoryPeriod,
  DeviceOutage,
} from '../../../../shared/activity.js';
import type { DeviceView } from '../../../../shared/types.js';
import { api, ApiError } from '../../api';
import { Icon } from '../../icons';
import { ConnectionHistoryChart } from './connection-history-chart';
import { FleetConnectionHistoryChart } from './fleet-connection-history-chart';
import './connection-history.css';

const allDevices = 'all';
const periods = { day: '24 часа', week: '7 дней' } as const;
const choices = ['day', 'week'] as const;

type HistoryResult = {
  key: string;
  deviceHistory?: ConnectionHistory;
  fleetHistory?: ConnectionFleetHistory;
  error?: string;
};

export function DeviceConnectionHistory({
  devices,
  outages,
  now,
  titleId,
}: {
  devices: DeviceView[];
  outages: DeviceOutage[];
  now: string;
  titleId?: string;
}) {
  const heading = useId();
  const deviceField = useId();
  const [deviceId, setDeviceId] = useState(allDevices);
  const [period, setPeriod] = useState<ConnectionHistoryPeriod>('day');
  const [result, setResult] = useState<HistoryResult>({ key: '' });

  const deviceNames = new Map(devices.map(({ id, name }) => [id, name || id]));
  for (const outage of outages) {
    if (!deviceNames.has(outage.deviceId))
      deviceNames.set(outage.deviceId, outage.deviceName || outage.deviceId);
  }
  const archived = deviceId !== allDevices && !deviceNames.has(deviceId);
  for (const { id, name } of result.fleetHistory?.devices ?? []) {
    if (!deviceNames.has(id)) deviceNames.set(id, name || id);
  }
  const selected = deviceNames.has(deviceId) ? deviceId : allDevices;
  const allSelected = selected === allDevices;
  const key = `${selected}:${period}`;
  const newestOutage = allSelected
    ? outages[0]
    : outages.find((outage) => outage.deviceId === selected);
  const newestEvent = newestOutage ? `${newestOutage.id}:${newestOutage.onlineAt ?? ''}` : '';
  const fleetStatus = allSelected
    ? devices.map(({ id, name, status }) => `${id}:${name}:${status}`).join('\n')
    : '';
  const minute = Math.floor(Date.parse(now) / 60_000);

  useEffect(() => {
    if (selected !== deviceId) setDeviceId(selected);
  }, [deviceId, selected]);

  useEffect(() => {
    const abort = new AbortController();
    const path = allSelected ? '/devices' : `/devices/${encodeURIComponent(selected)}`;
    const route = `${path}/connection-history?period=${period}`;
    void api<ConnectionHistory | ConnectionFleetHistory>(route, { signal: abort.signal })
      .then((history) => {
        if (abort.signal.aborted) return;
        setResult((previous) =>
          'devices' in history
            ? { key, fleetHistory: history }
            : { key, deviceHistory: history, fleetHistory: previous.fleetHistory },
        );
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const message =
          !allSelected && archived && error instanceof ApiError && error.status === 404
            ? 'За этот период нет записей о связи с выбранным контроллером.'
            : error instanceof Error
              ? error.message
              : 'Не удалось загрузить график.';
        setResult((previous) => ({ key, error: message, fleetHistory: previous.fleetHistory }));
      });
    return () => abort.abort();
  }, [allSelected, archived, selected, period, key, newestEvent, fleetStatus, minute]);

  const current = result.key === key ? result : undefined;
  const fleet = allSelected ? result.fleetHistory : undefined;
  const options = Array.from(deviceNames).sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  return (
    <section class="panel connection-history" aria-labelledby={titleId ?? heading}>
      <header class="connection-history-header">
        {!titleId && (
          <h2 id={heading}>
            <Icon name="activity" />
            График связи
          </h2>
        )}
        <div class="connection-history-device">
          <label htmlFor={deviceField}>Контроллер</label>
          <select
            id={deviceField}
            value={selected}
            onChange={(event) => setDeviceId(event.currentTarget.value)}
          >
            <option value={allDevices}>Все контроллеры</option>
            {options.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div class="connection-history-period" role="group" aria-label="Период графика">
          {choices.map((choice) => (
            <button
              type="button"
              key={choice}
              class={`button small${choice === period ? '' : ' secondary'}`}
              aria-pressed={choice === period}
              onClick={() => setPeriod(choice)}
            >
              {periods[choice]}
            </button>
          ))}
        </div>
      </header>
      {!current && !fleet && (
        <p class="connection-history-message" role="status">
          Загружаем график связи…
        </p>
      )}
      {current?.error && (
        <p class="connection-history-message inline-error" role="alert">
          {current.error}
        </p>
      )}
      {fleet && (
        <div aria-busy={!current}>
          {fleet.devices.length ? (
            <FleetConnectionHistoryChart history={fleet} />
          ) : (
            <p class="connection-history-message">За этот период нет данных о связи с PLC.</p>
          )}
        </div>
      )}
      {!allSelected && current?.deviceHistory && (
        <ConnectionHistoryChart history={current.deviceHistory} />
      )}
    </section>
  );
}
