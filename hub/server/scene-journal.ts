/** @file Durable run snapshots with ordered commits for parallel scene actions. */
import { readFile } from 'node:fs/promises';
import type { CommandView, SceneRun } from '../shared/types.js';
import type { HubDatabase, HubSql } from './database.js';

const importId = 'scenes-json-runs-v1';
export type RecordedSceneCommand = CommandView & {
  sceneRunId: string;
  status: 'applied' | 'rejected';
};

async function insert(sql: HubSql, run: SceneRun): Promise<void> {
  await sql.query(
    'INSERT INTO hub_scene_runs (id, started_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [run.id, run.startedAt, run],
  );
}

export class PostgresSceneJournal {
  private tail = Promise.resolve();

  constructor(private readonly database: HubDatabase) {}

  async open(legacy: readonly SceneRun[], limit: number): Promise<unknown[]> {
    const schema = await readFile(
      new URL('./migrations/003_scene_journal.sql', import.meta.url),
      'utf8',
    );
    return this.database.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(646333)');
      await sql.query(schema);
      const imported = await sql.query(
        'INSERT INTO hub_scene_journal_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [importId],
      );
      if (imported.rowCount) for (const run of legacy) await insert(sql, run);

      const { rows } = await sql.query<{ data: unknown }>(
        `SELECT data FROM (
           (SELECT id, started_at, data FROM hub_scene_runs ORDER BY started_at DESC, id DESC LIMIT $1)
           UNION
           (SELECT id, started_at, data FROM hub_scene_runs WHERE data->>'status' = 'running')
         ) AS observed ORDER BY started_at DESC, id DESC`,
        [limit],
      );
      return rows.map(({ data }) => data);
    });
  }

  /** A process can stop between committing the PLC acknowledgement and copying it to the run. */
  async commandResults(runIds: string[]): Promise<Map<string, RecordedSceneCommand[]>> {
    const byRun = new Map<string, RecordedSceneCommand[]>();
    if (!runIds.length) return byRun;
    const catalog = await this.database.query<{ available: boolean }>(
      "SELECT to_regclass('hub_command_journal') IS NOT NULL AS available",
    );
    if (!catalog.rows[0]?.available) return byRun;
    const { rows } = await this.database.query<{ entry: RecordedSceneCommand }>(
      `SELECT entry FROM hub_command_journal
       WHERE entry->>'sceneRunId' IS NOT NULL AND entry->>'sceneRunId' = ANY($1::text[])
         AND entry->>'status' IN ('applied', 'rejected') AND entry->>'completedAt' IS NOT NULL
       ORDER BY created_at DESC, id DESC`,
      [runIds],
    );
    for (const { entry } of rows) {
      const results = byRun.get(entry.sceneRunId);
      if (results) results.push(entry);
      else byRun.set(entry.sceneRunId, [entry]);
    }
    return byRun;
  }

  /** Snapshot before awaiting, so previous writes cannot observe later mutations. */
  save(run: SceneRun, starting: boolean): Promise<void> {
    const { id, startedAt } = run;
    const snapshot = JSON.stringify(run);
    const write = this.tail.then(async () => {
      if (starting) {
        await this.database.query(
          'INSERT INTO hub_scene_runs (id, started_at, data) VALUES ($1, $2, $3)',
          [id, startedAt, snapshot],
        );
        return;
      }
      const result = await this.database.query(
        'UPDATE hub_scene_runs SET data = $2 WHERE id = $1',
        [id, snapshot],
      );
      if (result.rowCount !== 1)
        throw new Error('Запуск сценария отсутствует в журнале PostgreSQL');
    });
    this.tail = write.catch(() => {});
    return write;
  }

  flush(): Promise<void> {
    return this.tail;
  }
}
