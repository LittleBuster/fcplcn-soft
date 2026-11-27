import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MeteoHistoryStore } from '../server/meteo-history.js';

test('hourly meteo averages persist, keep sensor identities and gaps, and expire after one week', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-meteo-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hour = Date.parse('2026-05-21T03:00:00.000Z');
  let now = hour + 3_600_000 + 20_000;
  let history = new MeteoHistoryStore(directory, false, () => now);
  t.after(() => history.close());
  const read = () => history.read('fcplcn-garage', 'air', 'day');
  const sample = (
    minutes: number,
    temperatureC: number,
    humidityPct: number | null,
    sampledAtUptimeMs: number,
    overrides: Record<string, unknown> = {},
  ) => {
    history.record(
      'fcplcn-garage',
      {
        enabled: true,
        bootId: 'boot-1',
        items: [
          {
            id: 'air',
            available: true,
            temperatureC,
            humidityPct,
            ageMs: 0,
            sampledAtUptimeMs,
            ...overrides,
          },
        ],
      },
      new Date(hour + minutes * 60_000 + 1000).toISOString(),
    );
  };
  sample(1, 18, 40, 1000);
  sample(1, 90, 100, 2000); // At most one sample per minute.
  sample(2, 22, 0, 3000);
  sample(3, 90, 100, 3000); // Repeated physical sample.
  sample(4, 90, 100, 4000, { ageMs: 60_000 });
  sample(5, 90, 100, 5000, { available: false });
  sample(6, 90, 100, 6000, { id: 'other' });
  sample(60, 26, null, 7000);

  assert.equal(read().length, 24);
  assert.deepEqual(read().slice(-3), [
    { hour: '2026-05-21T02:00:00.000Z', temperatureC: null, humidityPct: null },
    { hour: '2026-05-21T03:00:00.000Z', temperatureC: 20, humidityPct: 20 },
    { hour: '2026-05-21T04:00:00.000Z', temperatureC: 26, humidityPct: null },
  ]);
  history.close();
  history = new MeteoHistoryStore(directory, false, () => now);
  assert.equal(history.read('fcplcn-garage', 'air', 'week').length, 168);
  assert.equal(read().at(-2)?.temperatureC, 20);
  assert.equal(history.read('fcplcn-house', 'air', 'day').at(-2)?.temperatureC, null);
  sample(61, 90, 100, 7000); // Deduplication also survives reopening the database.
  assert.equal(read().at(-1)?.temperatureC, 26);

  history.close();
  now += 7 * 24 * 3_600_000;
  history = new MeteoHistoryStore(directory, false, () => now);
  assert.ok(
    read().every(({ temperatureC, humidityPct }) => temperatureC === null && humidityPct === null),
  );
  const db = new DatabaseSync(join(directory, 'meteo-history.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS total FROM meteo_hourly').get()?.total, 0);
  } finally {
    db.close();
  }
});
