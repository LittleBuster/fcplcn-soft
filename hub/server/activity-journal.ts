/** @file Durable results of PLC commands and observed connection losses. */
import { readFile } from 'node:fs/promises';
import type { DeviceOutage } from '../shared/activity.js';
import type { CommandView } from '../shared/types.js';
import type { HubDatabase } from './database.js';

const recent = 100;
const retryMs = 2000;
const maxQueued = 1024;
export class ActivityJournal {
  private readonly queued = new Map<string, DeviceOutage>();
  private readonly pendingResults = new Map<string, CommandView>();
  private readonly retry: ReturnType<typeof setInterval>;
  private draining: Promise<void> | undefined;
  private outageError = false;
  private commandError = false;

  private constructor(
    private readonly database: HubDatabase,
    readonly commands: CommandView[],
    readonly outages: DeviceOutage[],
  ) {
    this.retry = setInterval(() => void this.flush(), retryMs).unref();
  }

  static async open(database: HubDatabase): Promise<ActivityJournal> {
    const schema = await readFile(
      new URL('./migrations/002_activity.sql', import.meta.url),
      'utf8',
    );
    const { commands, outages } = await database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(884071)');
      await client.query(schema);
      // A pending row is evidence of intent, never evidence of a physical result.
      await client.query(
        `UPDATE hub_command_journal SET entry = entry || jsonb_build_object(
            'status', 'unknown', 'completedAt', $1::text, 'error', $2::text
          ) WHERE entry->>'status' = 'pending'`,
        [new Date().toISOString(), 'Хаб был перезапущен до сохранения подтверждения PLC'],
      );
      const commands = await client.query<{ entry: CommandView }>(
        'SELECT entry FROM hub_command_journal ORDER BY created_at DESC, id DESC LIMIT $1',
        [recent],
      );
      const outages = await client.query<{ entry: DeviceOutage }>(
        `SELECT entry FROM (
           (SELECT id, offline_at, entry FROM hub_device_outages WHERE online_at IS NOT NULL
             ORDER BY offline_at DESC, id DESC LIMIT $1)
           UNION ALL
           (SELECT id, offline_at, entry FROM hub_device_outages WHERE online_at IS NULL)
         ) AS observed ORDER BY offline_at DESC, id DESC`,
        [recent],
      );
      return {
        commands: commands.rows.map(({ entry }) => entry),
        outages: outages.rows.map(({ entry }) => entry),
      };
    });
    return new ActivityJournal(database, commands, outages);
  }

  async commandStarted(command: CommandView): Promise<void> {
    await this.database.query(
      'INSERT INTO hub_command_journal (id, created_at, entry) VALUES ($1, $2, $3)',
      [command.id, command.createdAt, command],
    );
  }

  async commandFinished(command: CommandView): Promise<void> {
    try {
      await this.saveResults([command]);
    } catch {
      if (!this.commandError) console.error('Не удалось сохранить подтверждение команды PLC.');
      this.commandError = true;
      if (this.pendingResults.size >= maxQueued)
        this.pendingResults.delete(this.pendingResults.keys().next().value!);
      this.pendingResults.set(command.id, command);
    }
  }

  private async saveResults(commands: CommandView[]): Promise<void> {
    await this.database.query(
      `INSERT INTO hub_command_journal (id, created_at, entry)
       SELECT (entry->>'id')::uuid, (entry->>'createdAt')::timestamptz, entry
       FROM jsonb_array_elements($1::jsonb) AS results(entry)
       ON CONFLICT (id) DO UPDATE SET entry = excluded.entry
       WHERE hub_command_journal.entry->>'status' = 'pending'`,
      [JSON.stringify(commands)],
    );
  }

  outageChanged(outage: DeviceOutage): void {
    if (!this.queued.has(outage.id) && this.queued.size >= maxQueued) {
      const oldestClosed = [...this.queued].find(([, entry]) => entry.onlineAt)?.[0];
      if (!oldestClosed) return;
      this.queued.delete(oldestClosed);
    }
    this.queued.set(outage.id, { ...outage });
    void this.flush();
  }

  async readConnectionOutages(
    deviceId: string | null,
    from: string,
    to: string,
  ): Promise<DeviceOutage[]> {
    const buffered = () =>
      [...this.queued.values()].filter(
        (outage) => deviceId === null || outage.deviceId === deviceId,
      );
    // The write queue can drain or change while the query is in flight.
    const beforeRead = buffered();
    const { rows } = await this.database.query<{ entry: DeviceOutage }>(
      `SELECT entry FROM hub_device_outages
        WHERE ($1::text IS NULL OR entry->>'deviceId' = $1) AND offline_at <= $3::timestamptz
          AND (online_at IS NULL OR online_at > $2::timestamptz)`,
      [deviceId, from, to],
    );
    return [...rows.map(({ entry }) => entry), ...beforeRead, ...buffered()];
  }

  private flush(): Promise<void> {
    if (!this.queued.size && !this.pendingResults.size) return Promise.resolve();
    this.draining ??= Promise.all([this.saveOutages(), this.retryResults()])
      .then(() => {})
      .finally(() => {
        this.draining = undefined;
      });
    return this.draining;
  }

  private async retryResults(): Promise<void> {
    while (this.pendingResults.size) {
      const frame = [...this.pendingResults.values()].slice(0, recent);
      try {
        await this.saveResults(frame);
        this.commandError = false;
      } catch {
        return;
      }
      for (const entry of frame) {
        if (this.pendingResults.get(entry.id) === entry) this.pendingResults.delete(entry.id);
      }
    }
  }

  private async saveOutages(): Promise<void> {
    // A recovery can arrive while its opening row is being written. Keep the newer snapshot.
    while (this.queued.size) {
      const frame = [...this.queued.values()].slice(0, recent);
      try {
        await this.database.query(
          `INSERT INTO hub_device_outages (id, offline_at, online_at, entry)
             SELECT (entry->>'id')::uuid, (entry->>'offlineAt')::timestamptz,
               (entry->>'onlineAt')::timestamptz, entry
             FROM jsonb_array_elements($1::jsonb) AS changes(entry)
           ON CONFLICT (id) DO UPDATE SET online_at = excluded.online_at, entry = excluded.entry
             WHERE hub_device_outages.online_at IS NULL`,
          [JSON.stringify(frame)],
        );
        this.outageError = false;
      } catch {
        if (!this.outageError) console.error('Не удалось сохранить журнал связи с PLC.');
        this.outageError = true;
        return;
      }
      for (const entry of frame) {
        if (this.queued.get(entry.id) === entry) this.queued.delete(entry.id);
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.retry);
    await this.draining;
    await this.flush();
  }
}
