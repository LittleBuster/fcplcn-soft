/** @file Shared meteo sampling rules and local SQLite storage for the demo. */
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { rows } from '../shared/telegram-controller-status.js';
import type {
  MeteoHistory,
  MeteoHistoryPeriod,
  MeteoHistoryPoint,
} from '../shared/meteo-history.js';
import type { DeviceView } from '../shared/types.js';

const minuteMs = 60_000;
export const hourMs = 60 * minuteMs;
const weekHours = 7 * 24;
const currentHour = (time: number) => Math.floor(time / hourMs) * hourMs;
const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export interface MeteoHistoryBackend {
  record(deviceId: string, data: Record<string, unknown>, receivedAt: string): void | Promise<void>;
  read(
    deviceId: string,
    sensorId: string,
    period: MeteoHistoryPeriod,
  ): MeteoHistoryPoint[] | Promise<MeteoHistoryPoint[]>;
  close(): void | Promise<void>;
}

export type ReadMeteoHistory = (
  deviceId: string,
  sensorId: string,
  period: MeteoHistoryPeriod,
) => Promise<MeteoHistory>;

interface MeteoSample {
  id: string;
  hour: number;
  minute: number;
  bootId: string;
  uptime: number;
  temperatureC: number;
  humidity: number | null;
}

/** Convert one live observation to eligible temperature and optional humidity readings. */
export function meteoSamples(data: Record<string, unknown>, receivedAt: string): MeteoSample[] {
  const receivedMs = Date.parse(receivedAt);
  const bootId = data.bootId;
  const samples: MeteoSample[] = [];
  if (!Number.isFinite(receivedMs) || typeof bootId !== 'string' || data.enabled !== true)
    return samples;
  for (const item of rows(data.items)) {
    const { id, available, temperatureC, humidityPct } = item;
    // Older firmware did not publish the age and monotonic sample timestamp.
    const age = item.ageMs === undefined ? 0 : item.ageMs;
    const uptime = item.sampledAtUptimeMs === undefined ? data.uptimeMs : item.sampledAtUptimeMs;
    if (
      typeof id !== 'string' ||
      available !== true ||
      !inRange(temperatureC, -55, 125) ||
      !inRange(age, 0, 15_000) ||
      !inRange(uptime, 0, Number.MAX_SAFE_INTEGER) ||
      !Number.isSafeInteger(uptime)
    )
      continue;
    const time = receivedMs - age;
    samples.push({
      id,
      hour: currentHour(time),
      minute: Math.floor(time / minuteMs),
      bootId,
      uptime,
      temperatureC,
      humidity: inRange(humidityPct, 0, 100) ? humidityPct : null,
    });
  }
  return samples;
}

export function meteoHistoryRange(period: MeteoHistoryPeriod, now: number) {
  const count = period === 'day' ? 24 : weekHours;
  const end = currentHour(now);
  return { start: end - (count - 1) * hourMs, end, count };
}

type HourlyAverage = { hour: unknown; temperature: unknown; humidity: unknown };

/** Return a point for each requested hour, keeping holes where a sensor has no reading. */
export function meteoHistoryPoints(start: number, count: number, saved: readonly HourlyAverage[]) {
  const averages = new Map(saved.map((row) => [Number(row.hour), row]));
  return Array.from({ length: count }, (_, index) => {
    const time = start + index * hourMs;
    const row = averages.get(time);
    return {
      hour: new Date(time).toISOString(),
      temperatureC: row ? Number(row.temperature) : null,
      humidityPct: row?.humidity != null ? Number(row.humidity) : null,
    };
  });
}

export class MeteoHistoryStore implements MeteoHistoryBackend {
  private readonly db: DatabaseSync;
  private readonly latest: StatementSync;
  private readonly upsert: StatementSync;
  private readonly query: StatementSync;
  private readonly removeOld: StatementSync;
  private readonly cleanup: ReturnType<typeof setInterval>;

  constructor(
    directory: string,
    private readonly demo = false,
    private readonly now = Date.now,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, demo ? 'meteo-history.demo.sqlite' : 'meteo-history.sqlite');
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS meteo_hourly (
          device_id TEXT NOT NULL,
          sensor_id TEXT NOT NULL,
          hour INTEGER NOT NULL,
          last_minute INTEGER NOT NULL,
          boot_id TEXT NOT NULL,
          sample_uptime INTEGER NOT NULL,
          temperature_sum REAL NOT NULL,
          temperature_count INTEGER NOT NULL,
          humidity_sum REAL NOT NULL,
          humidity_count INTEGER NOT NULL,
          PRIMARY KEY (device_id, sensor_id, hour)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS meteo_hourly_retention ON meteo_hourly(hour);
      `);
      this.latest = this.db.prepare(`
        SELECT last_minute, boot_id, sample_uptime FROM meteo_hourly
        WHERE device_id = ? AND sensor_id = ? ORDER BY hour DESC LIMIT 1
      `);
      this.upsert = this.db.prepare(`
        INSERT INTO meteo_hourly VALUES (?, ?, ?, ?, ?, ?, ?, 1, coalesce(?, 0), ?)
        ON CONFLICT (device_id, sensor_id, hour) DO UPDATE SET
          last_minute = excluded.last_minute,
          boot_id = excluded.boot_id,
          sample_uptime = excluded.sample_uptime,
          temperature_sum = meteo_hourly.temperature_sum + excluded.temperature_sum,
          temperature_count = meteo_hourly.temperature_count + 1,
          humidity_sum = meteo_hourly.humidity_sum + excluded.humidity_sum,
          humidity_count = meteo_hourly.humidity_count + excluded.humidity_count
        WHERE excluded.last_minute > meteo_hourly.last_minute
      `);
      this.query = this.db.prepare(`
        SELECT hour, temperature_sum / temperature_count AS temperature,
          humidity_sum / nullif(humidity_count, 0) AS humidity
        FROM meteo_hourly WHERE device_id = ? AND sensor_id = ? AND hour BETWEEN ? AND ?
        ORDER BY hour
      `);
      this.removeOld = this.db.prepare('DELETE FROM meteo_hourly WHERE hour < ?');
      this.prune();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.cleanup = setInterval(() => {
      try {
        this.prune();
      } catch {
        console.error('Не удалось очистить историю метеодатчиков.');
      }
    }, hourMs).unref();
  }

  private prune(): void {
    this.removeOld.run(meteoHistoryRange('week', this.now()).start);
  }

  close(): void {
    clearInterval(this.cleanup);
    this.db.close();
  }

  /** Sample at most once per minute per sensor. Retained frames never reach this method. */
  record(deviceId: string, data: Record<string, unknown>, receivedAt: string): void {
    for (const { id, hour, minute, bootId, uptime, temperatureC, humidity } of meteoSamples(
      data,
      receivedAt,
    )) {
      const last = this.latest.get(deviceId, id);
      if (
        last &&
        (minute <= Number(last.last_minute) ||
          (last.boot_id === bootId && uptime <= Number(last.sample_uptime)))
      )
        continue;
      this.upsert.run(
        deviceId,
        id,
        hour,
        minute,
        bootId,
        uptime,
        temperatureC,
        humidity,
        humidity === null ? 0 : 1,
      );
    }
  }

  read(deviceId: string, sensorId: string, period: MeteoHistoryPeriod): MeteoHistoryPoint[] {
    const { start, end, count } = meteoHistoryRange(period, this.now());
    const records = this.query
      .all(deviceId, sensorId, start, end)
      .map(({ hour, temperature, humidity }) => ({ hour, temperature, humidity }));
    return meteoHistoryPoints(start, count, records);
  }

  /** Seed earlier hours for a new demo sensor. Its samples live in a separate SQLite file. */
  seedDemo(devices: readonly DeviceView[]): void {
    if (!this.demo) return;
    const hour = currentHour(this.now());
    this.db.exec('BEGIN');
    try {
      for (const device of devices) {
        for (const item of rows(device.controllers.meteo?.data.items)) {
          if (typeof item.id !== 'string' || !inRange(item.temperatureC, -55, 125)) continue;
          if (this.query.get(device.id, item.id, hour - (weekHours - 1) * hourMs, hour - hourMs))
            continue;
          for (let offset = weekHours - 1; offset > 0; offset--) {
            const time = hour - offset * hourMs;
            const cycle = Math.sin(((time / hourMs) * Math.PI) / 12);
            const humidity = inRange(item.humidityPct, 0, 100)
              ? Math.max(0, Math.min(100, item.humidityPct - cycle * 7))
              : null;
            this.upsert.run(
              device.id,
              item.id,
              time,
              time / minuteMs,
              'demo-seed',
              0,
              item.temperatureC + cycle * 2 + Math.cos(offset / 19),
              humidity,
              humidity === null ? 0 : 1,
            );
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
