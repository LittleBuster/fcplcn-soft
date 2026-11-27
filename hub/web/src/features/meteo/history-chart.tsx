import type { MeteoHistoryPeriod, MeteoHistoryPoint } from '../../../../shared/meteo-history.js';

type Metric = 'temperatureC' | 'humidityPct';

const metrics = {
  temperatureC: { name: 'Температура', unit: '°C' },
  humidityPct: { name: 'Влажность', unit: '%' },
};

const tickFormats = {
  day: new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }),
  week: new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }),
};

const hourFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const formatValue = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/** Mark each saved value and join neighboring hours that both have readings. */
export function MeteoHistoryChart({
  points,
  metric,
  period,
}: {
  points: MeteoHistoryPoint[];
  metric: Metric;
  period: MeteoHistoryPeriod;
}) {
  const values = points.flatMap((point) => (point[metric] === null ? [] : [point[metric]]));
  if (!values.length) return null;

  const { name, unit } = metrics[metric];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const scale = Math.max(maximum - minimum, 2);
  const middle = (minimum + maximum) / 2;
  const floor = middle - scale * 0.65;
  const ceiling = middle + scale * 0.65;
  const left = 40;
  const right = 509;
  const top = 14;
  const bottom = 113;
  const x = (index: number) => left + (index / Math.max(points.length - 1, 1)) * (right - left);
  const y = (value: number) => bottom - ((value - floor) / (ceiling - floor)) * (bottom - top);
  const verticalTicks = [ceiling, middle, floor];
  const horizontalTicks = [0, 1, 2, 3, 4].map((step) =>
    Math.round((step * (points.length - 1)) / 4),
  );
  const radius = period === 'day' ? 2.8 : 1.05;
  const trace = points
    .map(({ [metric]: value }, index) => {
      if (value === null) return '';
      const command = points[index - 1]?.[metric] == null ? 'M' : 'L';
      return `${command}${x(index)} ${y(value)}`;
    })
    .filter(Boolean)
    .join(' ');

  return (
    <figure class="meteo-history-series" data-history-series={metric}>
      <figcaption>
        <strong>{name}</strong>
        <span>
          Минимум {formatValue(minimum)} {unit} · максимум {formatValue(maximum)} {unit}
        </span>
      </figcaption>
      <svg viewBox="0 0 530 143" role="img" aria-label={`Почасовой график · ${name}, ${unit}`}>
        {verticalTicks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
            <text x={left - 7} y={y(tick)} text-anchor="end" dominant-baseline="middle">
              {formatValue(tick)}
            </text>
          </g>
        ))}
        {horizontalTicks.map((index, step) => (
          <g key={step}>
            <line x1={x(index)} x2={x(index)} y1={top} y2={bottom} />
            <text x={x(index)} y={137} text-anchor="middle">
              {tickFormats[period].format(new Date(points[index].hour))}
            </text>
          </g>
        ))}
        <path class="meteo-history-trace" d={trace} />
        {points.map(({ hour, [metric]: value }, index) =>
          value === null ? null : (
            <circle key={hour} data-history-hour={hour} cx={x(index)} cy={y(value)} r={radius}>
              <title>
                {hourFormat.format(new Date(hour))} · {formatValue(value)} {unit}
              </title>
            </circle>
          ),
        )}
      </svg>
    </figure>
  );
}
