import { useId } from 'preact/hooks';
import type { ConnectionHistory } from '../../../../shared/activity.js';
import { activityDateTime, formatOutageDuration } from './labels';
import {
  connectionPlotWidth as width,
  connectionTickLabel,
  connectionTicks as ticks,
  plottedOutages,
} from './connection-history-geometry';

const normal = 25;
const offline = 77;

export function ConnectionHistoryChart({ history }: { history: ConnectionHistory }) {
  const description = useId();
  const from = Date.parse(history.from);
  const to = Date.parse(history.to);
  const span = to - from;
  const x = (time: number) => ((time - from) / span) * width;
  const intervals = plottedOutages(history.outages, from, to);
  const duration = intervals.reduce((total, interval) => total + interval.to - interval.from, 0);
  const normalTrace: string[] = [];
  let retainedThrough = from;
  for (const outage of intervals) {
    if (outage.from > retainedThrough)
      normalTrace.push(`M${x(retainedThrough)} ${normal} H${x(outage.from)}`);
    retainedThrough = outage.to;
  }
  if (retainedThrough < to) normalTrace.push(`M${x(retainedThrough)} ${normal} H${width}`);
  return (
    <figure class="connection-history-series">
      <figcaption class="connection-history-summary">
        <span>
          <time dateTime={history.from}>{activityDateTime(history.from)}</time> —{' '}
          <time dateTime={history.to}>{activityDateTime(history.to)}</time>
        </span>
        {intervals.length > 0 && (
          <strong>
            Время офлайн · {duration < 1000 ? 'меньше 1 с' : formatOutageDuration(duration)}
          </strong>
        )}
      </figcaption>
      <div class="connection-history-legend" aria-hidden="true">
        <span>Офлайн не зафиксирован</span>
        <span>Офлайн</span>
      </div>
      <svg
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label="График связи с PLC"
        aria-describedby={description}
        data-connection-chart
        data-from={history.from}
        data-to={history.to}
      >
        <desc id={description}>Красные просадки показывают периоды офлайна из журнала хаба.</desc>
        <line x1="0" x2={width} y1={normal} y2={normal} />
        <line x1="0" x2={width} y1={offline} y2={offline} />
        {ticks.map((tick) => (
          <line key={tick} x1={tick * width} x2={tick * width} y1="0" y2="100" />
        ))}
        <path class="connection-history-base" d={normalTrace.join(' ')} />
        {intervals.map((interval) => {
          const start = x(interval.from);
          const end = x(interval.to);
          const startTime = new Date(interval.from).toISOString();
          const endTime = new Date(interval.to).toISOString();
          const dip =
            (interval.from > from ? `M${start} ${normal} V${offline}` : `M${start} ${offline}`) +
            ` H${end}` +
            (interval.to < to ? ` V${normal}` : '');
          return (
            <g key={interval.id}>
              <title>
                Потеря связи · {activityDateTime(interval.offlineAt)}
                {'\n'}
                {interval.onlineAt
                  ? `Связь восстановлена · ${activityDateTime(interval.onlineAt)}`
                  : 'Восстановление связи не зафиксировано'}
              </title>
              <rect x={start} y="0" width={end - start} height="100" />
              <path
                class="connection-history-outage"
                d={dip}
                data-connection-outage={interval.id}
                data-from={startTime}
                data-to={endTime}
              />
            </g>
          );
        })}
      </svg>
      <div class="connection-history-ticks" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick}>{connectionTickLabel(history.period, from + span * tick)}</span>
        ))}
      </div>
      {intervals.length === 0 && (
        <p class="connection-history-message">За этот период офлайн не зафиксирован.</p>
      )}
    </figure>
  );
}
