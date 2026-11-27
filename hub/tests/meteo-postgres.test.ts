import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HubDatabase } from '../server/database.js';
import { MeteoHistoryStore } from '../server/meteo-history.js';
import { PostgresMeteoHistoryStore } from '../server/meteo-postgres.js';

const url = process.env.FCPLCN_HUB_TEST_DATABASE_URL;

test(
  'PostgreSQL imports SQLite and preserves history, deduplication and retention across restarts',
  { skip: !url },
  async () => {
    if (!url) return;
    const directory = mkdtempSync(join(tmpdir(), 'fcplcn-meteo-postgres-test-'));
    const filename = join(directory, 'meteo-history.sqlite');
    const schema = 'meteo_test_' + randomBytes(8).toString('hex');
    const admin = new HubDatabase(url);
    const database = new HubDatabase(url, { schema });
    const hour = Date.parse('2026-05-21T03:00:00.000Z');
    let now = hour + 3_600_000 + 120_000;
    const device = 'fcplcn-garage';
    const sample = (
      minute: number,
      temperatureC: number,
      humidityPct: number | null,
      sampledAtUptimeMs: number,
      bootId = 'boot-1',
    ) =>
      [
        device,
        {
          enabled: true,
          bootId,
          items: [
            { id: 'air', available: true, temperatureC, humidityPct, ageMs: 0, sampledAtUptimeMs },
          ],
        },
        new Date(hour + minute * 60_000 + 1000).toISOString(),
      ] as const;
    let legacy: MeteoHistoryStore | undefined;
    let history: PostgresMeteoHistoryStore | undefined;

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      writeFileSync(filename, 'broken legacy database');
      await assert.rejects(PostgresMeteoHistoryStore.open(database, directory, () => now));
      assert.equal(
        (await database.query("SELECT to_regclass('hub_meteo_migrations') AS migrations")).rows[0]
          .migrations,
        null,
      );
      assert.equal(readFileSync(filename, 'utf8'), 'broken legacy database');
      rmSync(filename);

      legacy = new MeteoHistoryStore(directory, false, () => now);
      legacy.record(...sample(1, 18, 40, 1000));
      legacy.record(...sample(2, 22, 0, 3000));
      // Keep a stable, uncheckpointed WAL beside the database during the import.
      const data = readFileSync(filename);
      const wal = readFileSync(filename + '-wal');
      const shm = readFileSync(filename + '-shm');

      history = await PostgresMeteoHistoryStore.open(database, directory, () => now);
      assert.deepEqual(readFileSync(filename), data);
      assert.deepEqual(readFileSync(filename + '-wal'), wal);
      assert.deepEqual(readFileSync(filename + '-shm'), shm);
      const read = () => history!.read(device, 'air', 'day');
      assert.deepEqual((await read()).slice(-3), [
        { hour: '2026-05-21T02:00:00.000Z', temperatureC: null, humidityPct: null },
        { hour: '2026-05-21T03:00:00.000Z', temperatureC: 20, humidityPct: 20 },
        { hour: '2026-05-21T04:00:00.000Z', temperatureC: null, humidityPct: null },
      ]);

      // Concurrent arrivals preserve their order. The imported boot and uptime still deduplicate
      // a physical reading at the next hour boundary, while the reboot accepts a lower uptime.
      await Promise.all([
        history.record(...sample(60, 99, 100, 3000)),
        history.record(...sample(60, 26, null, 4000)),
        history.record(...sample(60, 99, 100, 5000)),
        history.record(...sample(61, 30, 60, 100, 'boot-2')),
      ]);
      assert.deepEqual((await read()).at(-1), {
        hour: '2026-05-21T04:00:00.000Z',
        temperatureC: 28,
        humidityPct: 60,
      });

      legacy.record(...sample(60, 90, 100, 9000));
      legacy.close();
      legacy = undefined;
      await history.close();
      history = await PostgresMeteoHistoryStore.open(database, directory, () => now);
      assert.equal((await history.read(device, 'air', 'week')).length, 168);
      assert.equal((await read()).at(-1)?.temperatureC, 28);
      assert.equal((await history.read('fcplcn-house', 'air', 'day')).at(-1)?.temperatureC, null);
      await history.record(...sample(62, 99, 100, 100, 'boot-2'));
      assert.equal((await read()).at(-1)?.temperatureC, 28);

      await history.close();
      now += 7 * 24 * 3_600_000;
      history = await PostgresMeteoHistoryStore.open(database, directory, () => now);
      assert.ok((await read()).every((point) => point.temperatureC === null));
      assert.equal(
        (await database.query('SELECT count(*) AS count FROM hub_meteo_hourly')).rows[0].count,
        '0',
      );
    } finally {
      legacy?.close();
      await history?.close();
      await database.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
