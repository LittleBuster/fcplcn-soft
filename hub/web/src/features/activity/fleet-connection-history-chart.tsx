import { useMemo, useState } from 'preact/hooks';
import type { ConnectionFleetHistory, DeviceOutage } from '../../../../shared/activity.js';
import {
  connectionPlotWidth as width,
  connectionTickLabel,
  connectionTicks as ticks,
  plottedOutages,
  type ConnectionInterval,
} from './connection-history-geometry';
import { activityDateTime, outageDuration } from './labels';
import './fleet-connection-history.css';

const height = 54;
const upper = 17;
const lower = 36;

interface FleetRow {
  device: ConnectionFleetHistory['devices'][number];
  intervals: ConnectionInterval[];
}

interface DrawnOutage {
  interval: ConnectionInterval;
  left: number;
  right: number;
}

/** Enlarge short dips for touch without overlapping the next dip's touch target. */
function touchTarget(outages: DrawnOutage[], index: number) {
  const { left, right } = outages[index];
  const previous = outages[index - 1];
  const next = outages[index + 1];
  const percent = (x: number) => (100 * x) / width;
  const lowerBound = previous ? percent((previous.right + left) / 2) : 0;
  const upperBound = next ? percent((right + next.left) / 2) : 100;
  const center = percent((left + right) / 2);
  const span = percent(right - left);
  const hitWidth = `min(${upperBound - lowerBound}%, max(44px, ${span}%))`;
  const centered = `calc(${center}% - max(22px, ${span / 2}%))`;
  const maximumLeft = `calc(${upperBound}% - ${hitWidth})`;
  return {
    left: `clamp(${lowerBound}%, ${centered}, ${maximumLeft})`,
    width: hitWidth,
  };
}

function FleetTrack({
  row,
  x,
  selected,
  selectOutage,
}: {
  row: FleetRow;
  x: (timestamp: number) => number;
  selected?: ConnectionInterval;
  selectOutage: (id: string) => void;
}) {
  const { device, intervals } = row;
  const outages = intervals.map((interval) => ({
    interval,
    left: x(interval.from),
    right: x(interval.to),
  }));
  const trace: string[] = [];
  let cursor = 0;
  for (const { left, right } of outages) {
    if (left > cursor) trace.push(`M${cursor} ${upper} H${left}`);
    cursor = right;
  }
  if (cursor < width) trace.push(`M${cursor} ${upper} H${width}`);

  const status = device.online === null ? 'unknown' : device.online ? 'online' : 'offline';
  const label = { unknown: 'Нет данных', online: 'На связи', offline: 'Офлайн' }[status];
  return (
    <div class="fleet-connection-row" data-fleet-device={device.id}>
      <div class="fleet-connection-device">
        <strong>{device.name}</strong>
        <span class="fleet-connection-status" data-status={status}>
          {label}
        </span>
      </div>
      <div class="fleet-connection-track">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          {selected && (
            <rect
              class="fleet-connection-selected-band"
              x={x(selected.from)}
              y="0"
              width={x(selected.to) - x(selected.from)}
              height={height}
            />
          )}
          {ticks.map((tick) => (
            <line
              key={tick}
              class="fleet-connection-gridline"
              x1={tick * width}
              x2={tick * width}
              y1="0"
              y2={height}
            />
          ))}
          <path
            class="fleet-connection-baseline"
            data-unknown={status === 'unknown' || undefined}
            d={trace.join(' ')}
          />
          {outages.map(({ interval, left, right }) => {
            const start = left === 0 ? `M0 ${lower}` : `M${left} ${upper} V${lower}`;
            const recovery = right < width ? ` V${upper}` : '';
            const dip = `${start} H${right}${recovery}`;
            return (
              <g key={interval.id}>
                <rect
                  class="fleet-connection-outage-fill"
                  x={left}
                  width={right - left}
                  y={upper}
                  height={lower - upper}
                />
                <path class="fleet-connection-dip" d={dip} data-fleet-outage-path={interval.id} />
              </g>
            );
          })}
        </svg>
        {outages.map(({ interval }, index) => {
          const start = activityDateTime(interval.offlineAt);
          const end = interval.onlineAt ? activityDateTime(interval.onlineAt) : 'ещё офлайн';
          const outageLabel = `${device.name} · ${start} — ${end}`;
          return (
            <button
              key={interval.id}
              type="button"
              class="fleet-connection-hit"
              data-fleet-outage={interval.id}
              data-from={new Date(interval.from).toISOString()}
              data-to={new Date(interval.to).toISOString()}
              aria-label={outageLabel}
              aria-pressed={selected?.id === interval.id}
              title={outageLabel}
              style={touchTarget(outages, index)}
              onClick={() => selectOutage(interval.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

export function FleetConnectionHistoryChart({ history }: { history: ConnectionFleetHistory }) {
  const [selectedId, setSelectedId] = useState<string>();
  const from = Date.parse(history.from);
  const to = Date.parse(history.to);
  const span = to - from;
  const x = (timestamp: number) => (width * (timestamp - from)) / span;
  const rows = useMemo(() => {
    const byDevice = new Map<string, DeviceOutage[]>();
    for (const outage of history.outages) {
      const existing = byDevice.get(outage.deviceId);
      if (existing) existing.push(outage);
      else byDevice.set(outage.deviceId, [outage]);
    }
    return history.devices.map((device) => ({
      device,
      intervals: plottedOutages(byDevice.get(device.id) ?? [], from, to),
    }));
  }, [history.devices, history.outages, from, to]);
  const selectable = rows.flatMap(({ device, intervals }) =>
    intervals.map((interval) => ({ device, interval })),
  );
  const latest = selectable.reduce<(typeof selectable)[number] | undefined>(
    (last, entry) =>
      !last || Date.parse(entry.interval.offlineAt) > Date.parse(last.interval.offlineAt)
        ? entry
        : last,
    undefined,
  );
  const selected = selectable.find(({ interval }) => interval.id === selectedId) ?? latest;

  return (
    <figure
      class="fleet-connection-history"
      aria-label="Общая шкала связи PLC"
      data-from={history.from}
      data-to={history.to}
    >
      <figcaption class="fleet-connection-range">
        <time dateTime={history.from}>{activityDateTime(history.from)}</time> —{' '}
        <time dateTime={history.to}>{activityDateTime(history.to)}</time>
      </figcaption>
      <div class="fleet-connection-scroll">
        <div class="fleet-connection-axis" aria-hidden="true">
          <span>Контроллер</span>
          <div class="fleet-connection-ticks">
            {ticks.map((tick) => (
              <span key={tick}>{connectionTickLabel(history.period, from + span * tick)}</span>
            ))}
          </div>
        </div>
        {rows.map((row) => (
          <FleetTrack
            key={row.device.id}
            row={row}
            x={x}
            selected={selected?.interval}
            selectOutage={setSelectedId}
          />
        ))}
      </div>
      <div class="fleet-connection-legend" aria-label="Обозначения">
        <span data-status="online">На связи</span>
        <span data-status="offline">Офлайн</span>
        {rows.some(({ device }) => device.online === null) && (
          <span data-status="unknown">Нет данных</span>
        )}
      </div>
      {selected ? (
        <section
          class="fleet-connection-details"
          data-fleet-details
          aria-label="Подробности отключения"
          aria-live="polite"
        >
          <h3>{selected.device.name} · отключение</h3>
          <dl>
            <div>
              <dt>Связь потеряна</dt>
              <dd>
                <time dateTime={selected.interval.offlineAt}>
                  {activityDateTime(selected.interval.offlineAt)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Связь восстановлена</dt>
              <dd>
                {selected.interval.onlineAt ? (
                  <time dateTime={selected.interval.onlineAt}>
                    {activityDateTime(selected.interval.onlineAt)}
                  </time>
                ) : (
                  'Ожидается'
                )}
              </dd>
            </div>
            <div>
              <dt>Время офлайн</dt>
              <dd>
                {outageDuration(
                  selected.interval.offlineAt,
                  selected.interval.onlineAt ?? history.to,
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : (
        <p class="fleet-connection-empty">За этот период офлайн не зафиксирован.</p>
      )}
    </figure>
  );
}
