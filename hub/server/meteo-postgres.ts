/** @file PostgreSQL history for live PLCs and a transactional import of the previous SQLite file. */
import { copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MeteoHistoryPeriod } from '../shared/meteo-history.js';
import type { HubDatabase, HubSql } from './database.js';
import {
  hourMs,
  meteoHistoryPoints,
  meteoHistoryRange,
  meteoSamples,
  type MeteoHistoryBackend,
} from './meteo-history.js';

const migration = 'meteo-history-sqlite-v1';
const maxPendingFrames = 128;
const schema = `
  CREATE TABLE IF NOT EXISTS hub_meteo_hourly (
    device_id TEXT NOT NULL,
    sensor_id TEXT NOT NULL,
    hour BIGINT NOT NULL,
    last_minute BIGINT NOT NULL,
    boot_id TEXT NOT NULL,
    sample_uptime BIGINT NOT NULL,
    temperature_sum DOUBLE PRECISION NOT NULL,
    temperature_count INTEGER NOT NULL CHECK (temperature_count > 0),
    humidity_sum DOUBLE PRECISION NOT NULL,
    humidity_count INTEGER NOT NULL CHECK (humidity_count BETWEEN 0 AND temperature_count),
    PRIMARY KEY (device_id, sensor_id, hour)
  );
  CREATE INDEX IF NOT EXISTS hub_meteo_hourly_retention ON hub_meteo_hourly(hour);
  CREATE TABLE IF NOT EXISTS hub_meteo_migrations (
    name TEXT PRIMARY KEY,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const legacyRows = `
  SELECT device_id, sensor_id, hour, last_minute, boot_id, sample_uptime, temperature_sum,
    temperature_count, humidity_sum, humidity_count
  FROM meteo_hourly WHERE hour >= ?
`;
const importRows = `
  INSERT INTO hub_meteo_hourly (
    device_id, sensor_id, hour, last_minute, boot_id, sample_uptime, temperature_sum,
    temperature_count, humidity_sum, humidity_count
  )
  SELECT device_id, sensor_id, hour, last_minute, boot_id, sample_uptime, temperature_sum,
    temperature_count, humidity_sum, humidity_count
  FROM jsonb_to_recordset($1::jsonb) AS sample (
    device_id TEXT, sensor_id TEXT, hour BIGINT, last_minute BIGINT, boot_id TEXT,
    sample_uptime BIGINT, temperature_sum DOUBLE PRECISION, temperature_count INTEGER,
    humidity_sum DOUBLE PRECISION, humidity_count INTEGER
  )
  ON CONFLICT (device_id, sensor_id, hour) DO NOTHING
`;

/** Recheck the newest sample while holding the controller's transaction lock. */
const addSample = `
  INSERT INTO hub_meteo_hourly (
    device_id, sensor_id, hour, last_minute, boot_id, sample_uptime, temperature_sum,
    temperature_count, humidity_sum, humidity_count
  )
  SELECT $1, $2, $3, $4, $5, $6, $7, 1, coalesce($8::double precision, 0),
    CASE WHEN $8 IS NULL THEN 0 ELSE 1 END
  WHERE NOT EXISTS (
    SELECT 1 FROM (
      SELECT last_minute, boot_id, sample_uptime
      FROM hub_meteo_hourly
      WHERE device_id = $1 AND sensor_id = $2
      ORDER BY hour DESC LIMIT 1
    ) AS latest
    WHERE latest.last_minute >= $4 OR (latest.boot_id = $5 AND latest.sample_uptime >= $6)
  )
  ON CONFLICT (device_id, sensor_id, hour) DO UPDATE SET
    last_minute = excluded.last_minute,
    boot_id = excluded.boot_id,
    sample_uptime = excluded.sample_uptime,
    temperature_sum = hub_meteo_hourly.temperature_sum + excluded.temperature_sum,
    temperature_count = hub_meteo_hourly.temperature_count + excluded.temperature_count,
    humidity_sum = hub_meteo_hourly.humidity_sum + excluded.humidity_sum,
    humidity_count = hub_meteo_hourly.humidity_count + excluded.humidity_count
  WHERE excluded.last_minute > hub_meteo_hourly.last_minute
`;

function isRegularFile(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile()) throw new Error('История метеодатчиков должна храниться в обычном файле');
  return true;
}

/**
 * The old hub is stopped during upgrade. Read a temporary copy, including any uncheckpointed
 * WAL, so SQLite can rebuild its shared memory without touching the original files.
 */
async function importLegacyHistory(client: HubSql, directory: string, cutoff: number) {
  const filename = 'meteo-history.sqlite';
  const source = join(directory, filename);
  if (!isRegularFile(source)) return;

  const temporary = mkdtempSync(join(tmpdir(), 'fcplcn-meteo-import-'));
  try {
    const snapshot = join(temporary, filename);
    copyFileSync(source, snapshot);
    if (isRegularFile(source + '-wal')) copyFileSync(source + '-wal', snapshot + '-wal');
    const sqlite = new DatabaseSync(snapshot, { readOnly: true });
    try {
      let batch = [];
      for (const row of sqlite.prepare(legacyRows).iterate(cutoff)) {
        batch.push(row);
        if (batch.length === 256) {
          await client.query(importRows, [JSON.stringify(batch)]);
          batch = [];
        }
      }
      if (batch.length) await client.query(importRows, [JSON.stringify(batch)]);
    } finally {
      sqlite.close();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

type MeteoDatabase = Pick<HubDatabase, 'query' | 'transaction'>;
type Sample = ReturnType<typeof meteoSamples>[number];

export class PostgresMeteoHistoryStore implements MeteoHistoryBackend {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly cleanup: ReturnType<typeof setInterval>;
  private pruning: Promise<unknown> | undefined;
  private queuedFrames = 0;
  private closed = false;

  private constructor(
    private readonly database: MeteoDatabase,
    private readonly now: () => number,
  ) {
    this.cleanup = setInterval(() => {
      if (this.pruning) return;
      this.pruning = this.database
        .query('DELETE FROM hub_meteo_hourly WHERE hour < $1', [
          meteoHistoryRange('week', this.now()).start,
        ])
        .catch(() => console.error('Не удалось очистить историю метеодатчиков.'))
        .finally(() => {
          this.pruning = undefined;
        });
    }, hourMs).unref();
  }

  static async open(database: MeteoDatabase, directory: string, now = Date.now) {
    const cutoff = meteoHistoryRange('week', now()).start;
    await database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(884061)');
      await client.query(schema);
      const migrated = await client.query('SELECT 1 FROM hub_meteo_migrations WHERE name = $1', [
        migration,
      ]);
      if (!migrated.rowCount) {
        await importLegacyHistory(client, directory, cutoff);
        await client.query('INSERT INTO hub_meteo_migrations(name) VALUES ($1)', [migration]);
      }
      await client.query('DELETE FROM hub_meteo_hourly WHERE hour < $1', [cutoff]);
    });
    return new PostgresMeteoHistoryStore(database, now);
  }

  async record(deviceId: string, data: Record<string, unknown>, receivedAt: string): Promise<void> {
    if (this.closed) return;
    const cutoff = meteoHistoryRange('week', this.now()).start;
    const samples = meteoSamples(data, receivedAt).filter((sample) => sample.hour >= cutoff);
    if (samples.length === 0) return;
    if (this.queuedFrames >= maxPendingFrames)
      throw new Error('Очередь записи метеодатчиков заполнена');

    // Bound retained frames during database outages on low-memory hubs.
    // Keep arrival order per PLC. The SQL lock also covers other writers.
    this.queuedFrames++;
    const previous = this.pending.get(deviceId);
    const write = this.write(deviceId, samples, previous);
    this.pending.set(deviceId, write);
    try {
      await write;
    } finally {
      this.queuedFrames--;
      if (this.pending.get(deviceId) === write) this.pending.delete(deviceId);
    }
  }

  private async write(deviceId: string, samples: readonly Sample[], previous?: Promise<void>) {
    await previous?.catch(() => {});
    await this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(884062, hashtext($1))', [deviceId]);
      for (const { id, hour, minute, bootId, uptime, temperatureC, humidity } of samples) {
        await client.query(addSample, [
          deviceId,
          id,
          hour,
          minute,
          bootId,
          uptime,
          temperatureC,
          humidity,
        ]);
      }
    });
  }

  async read(deviceId: string, sensorId: string, period: MeteoHistoryPeriod) {
    const { start, end, count } = meteoHistoryRange(period, this.now());
    const { rows } = await this.database.query<{
      hour: string;
      temperature: number;
      humidity: number | null;
    }>(
      `SELECT hour, temperature_sum / temperature_count AS temperature,
          humidity_sum / nullif(humidity_count, 0) AS humidity
        FROM hub_meteo_hourly WHERE device_id = $1 AND sensor_id = $2 AND hour BETWEEN $3 AND $4
        ORDER BY hour`,
      [deviceId, sensorId, start, end],
    );
    return meteoHistoryPoints(start, count, rows);
  }

  async close() {
    this.closed = true;
    clearInterval(this.cleanup);
    await Promise.allSettled([...this.pending.values(), this.pruning]);
  }
}
