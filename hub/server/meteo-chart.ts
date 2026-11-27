/** @file Render Telegram weather charts as PNG on the hub. */
import { readFile } from 'node:fs/promises';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import type { MeteoHistory } from '../shared/meteo-history.js';

const width = 960;
const left = 112;
const right = width - 70;
const panelHeight = 244;
const legend = { ink: '#e7effa', muted: '#aebfd5', grid: '#314662' };
const fontFamily = 'FCPLCn Chart Sans';
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const date = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });
let rendererFont: Promise<Uint8Array> | undefined;

async function prepareRenderer(): Promise<Uint8Array> {
  const [wasm, font] = await Promise.all([
    readFile(new URL(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'))),
    readFile(new URL('./assets/fcplcn-chart-sans.ttf', import.meta.url)),
  ]);
  await initWasm(wasm);
  return font;
}

const escape = (value: string) =>
  value
    .replaceAll(/[\u0000-\u001f\ufffe\uffff]/gu, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

function shorten(value: string, limit: number): string {
  const letters = Array.from(value.trim());
  return letters.length <= limit ? value.trim() : letters.slice(0, limit - 1).join('') + '…';
}

function label(
  value: string,
  x: number,
  y: number,
  size: number,
  color = legend.ink,
  anchor = 'start',
): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${escape(value)}</text>`;
}

function ticks(low: number, high: number, humidity: boolean): number[] {
  const roughStep = Math.max((high - low) / 3, humidity ? 5 : 0.5);
  const factor = 10 ** Math.floor(Math.log10(roughStep));
  const step = factor * ([1, 2, 2.5, 5, 10].find((amount) => amount * factor >= roughStep) ?? 10);
  const first = Math.floor(low / step - 0.5);
  const last = Math.ceil(high / step + 0.5);
  return Array.from({ length: last - first + 1 }, (_, index) => (first + index) * step).filter(
    (value) => !humidity || (value >= 0 && value <= 100),
  );
}

function drawPanel(history: MeteoHistory, y: number, humidity = false): string {
  const metric = humidity ? 'humidityPct' : 'temperatureC';
  const values = history.points.map((point) => point[metric]);
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const unit = humidity ? '%' : '°C';
  const color = humidity ? '#66d7f0' : '#ffcd7d';
  const parts = [
    `<rect x="44" y="${y}" width="${width - 88}" height="${panelHeight}" rx="16" fill="#172536" stroke="#314662"/>`,
    label(humidity ? 'Влажность' : 'Температура', 69, y + 37, 25, color),
  ];
  if (!known.length) {
    parts.push(
      label('За этот период показаний нет', width / 2, y + 130, 25, legend.muted, 'middle'),
    );
    return parts.join('');
  }

  const min = Math.min(...known);
  const max = Math.max(...known);
  const yTicks = ticks(min, max, humidity);
  // Ensure humidity endpoints are included when a round scale step skips either boundary.
  const tickLow = Math.min(min, yTicks[0]);
  const tickHigh = Math.max(max, yTicks[yTicks.length - 1]);
  const top = y + 72;
  const bottom = y + 194;
  const xAt = (index: number) => left + (index / Math.max(values.length - 1, 1)) * (right - left);
  const yAt = (value: number) =>
    bottom - ((value - tickLow) / (tickHigh - tickLow)) * (bottom - top);
  for (const tick of yTicks) {
    const py = yAt(tick);
    parts.push(
      `<path d="M${left} ${py}H${right}" stroke="${legend.grid}"/>`,
      label(number.format(tick), left - 13, py + 6, 18, legend.muted, 'end'),
    );
  }
  const interval = history.period === 'day' ? 4 : 24;
  const xTicks = new Set<number>();
  for (let index = 0; index < values.length - 2; index += interval) xTicks.add(index);
  xTicks.add(values.length - 1);
  const formatX = history.period === 'day' ? clock : date;
  for (const index of xTicks) {
    const px = xAt(index);
    parts.push(
      `<path d="M${px} ${top}V${bottom}" stroke="${legend.grid}" stroke-dasharray="4 5"/>`,
      label(
        formatX.format(new Date(history.points[index].hour)),
        px,
        y + 222,
        19,
        legend.muted,
        'middle',
      ),
    );
  }

  const radius = history.period === 'day' ? 3.5 : 1.65;
  const trace: string[] = [];
  const markers: string[] = [];
  let adjacent = false;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      adjacent = false;
      return;
    }
    const cx = xAt(index).toFixed(2);
    const cy = yAt(value).toFixed(2);
    trace.push(`${adjacent ? 'L' : 'M'}${cx} ${cy}`);
    markers.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"/>`);
    adjacent = true;
  });
  parts.push(
    `<path d="${trace.join(' ')}" fill="none" stroke="${color}" stroke-opacity="0.65" stroke-width="${history.period === 'day' ? 1.8 : 1.1}" stroke-linejoin="round"/>`,
    ...markers,
    label(
      `Мин. ${number.format(min)} · макс. ${number.format(max)} ${unit}`,
      right,
      y + 37,
      19,
      legend.muted,
      'end',
    ),
  );
  return parts.join('');
}

export function meteoChartSvg(history: MeteoHistory): string {
  const panelTop = 147;
  const humidity = history.points.some((point) => point.humidityPct !== null);
  const bottom = panelTop + panelHeight + (humidity ? panelHeight + 18 : 0);
  const height = bottom + 67;
  const firstHour = history.points[0]?.hour;
  const lastHour = history.points.at(-1)?.hour;
  const timeLabel = (hour: string) => {
    const value = new Date(hour);
    return `${date.format(value)} ${clock.format(value)}`;
  };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${fontFamily}">`,
    `<rect width="${width}" height="${height}" fill="#101a2a"/>`,
    label('ПОКАЗАНИЯ ПО ЧАСАМ', 45, 46, 18, '#9fc5fb'),
    label(history.period === 'day' ? '24 ЧАСА' : '7 ДНЕЙ', width - 46, 46, 18, '#9fc5fb', 'end'),
    label(shorten(history.sensorName, 30), 44, 94, 38),
    label(shorten(history.deviceName, 57), 46, 125, 22, legend.muted),
    drawPanel(history, panelTop),
    humidity ? drawPanel(history, panelTop + panelHeight + 18, true) : '',
    firstHour && lastHour
      ? label(`${timeLabel(firstHour)} — ${timeLabel(lastHour)}`, 46, bottom + 40, 18, legend.muted)
      : '',
    label('Одна точка на час с показаниями', width - 46, bottom + 40, 18, legend.muted, 'end'),
    '</svg>',
  ].join('');
}

export async function renderMeteoChart(history: MeteoHistory): Promise<Buffer> {
  const font = await (rendererFont ??= prepareRenderer());
  const renderer = new Resvg(meteoChartSvg(history), {
    font: { fontBuffers: [font], defaultFontFamily: fontFamily },
  });
  try {
    const chart = renderer.render();
    try {
      return Buffer.from(chart.asPng());
    } finally {
      chart.free();
    }
  } finally {
    renderer.free();
  }
}
