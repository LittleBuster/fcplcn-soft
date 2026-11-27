/** @file Verify packaged WebAssembly chart rendering with and without humidity data. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meteoChartSvg, renderMeteoChart } from '../server/meteo-chart.js';
import type { MeteoHistory, MeteoHistoryPeriod } from '../shared/meteo-history.js';

function history(period: MeteoHistoryPeriod, humidity: boolean): MeteoHistory {
  return {
    period,
    deviceName: 'Гостиная & первый этаж',
    sensorName: 'Датчик <у окна>',
    points: Array.from({ length: period === 'day' ? 24 : 168 }, (_, index) => ({
      hour: new Date(Date.UTC(2026, 10, 21, index)).toISOString(),
      temperatureC: index % 8 === 0 ? null : -4 + Math.cos(index / 10),
      humidityPct: humidity && index % 4 !== 0 ? 51 + Math.sin(index / 8) : null,
    })),
  };
}

test('day and week plots keep every recorded point and connect only neighboring hours', () => {
  for (const period of ['day', 'week'] as const) {
    const data = history(period, true);
    const svg = meteoChartSvg(data);
    for (const [metric, color] of [
      ['temperatureC', '#ffcd7d'],
      ['humidityPct', '#66d7f0'],
    ] as const) {
      const markers = [
        ...svg.matchAll(
          new RegExp(`<circle cx="([^"]+)" cy="([^"]+)" [^>]+ fill="${color}"/>`, 'g'),
        ),
      ];
      assert.equal(markers.length, data.points.filter((point) => point[metric] !== null).length);
      let markerIndex = 0;
      const expected = data.points.flatMap((point, index) => {
        if (point[metric] === null) return [];
        const [, x, y] = markers[markerIndex++];
        return `${data.points[index - 1]?.[metric] == null ? 'M' : 'L'}${x} ${y}`;
      });
      const path = svg.match(new RegExp(`<path d="([^"]+)" fill="none" stroke="${color}"`));
      assert.equal(path?.[1], expected.join(' '));
    }
  }
});

test('hourly meteo charts render valid PNGs on first concurrent requests', async () => {
  const [day, week] = await Promise.all([
    renderMeteoChart(history('day', false)),
    renderMeteoChart(history('week', true)),
  ]);
  for (const png of [day, week]) {
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(png.readUInt32BE(16), 960);
    assert.ok(png.length > 5000);
  }
  assert.ok(week.readUInt32BE(20) > day.readUInt32BE(20));
});
