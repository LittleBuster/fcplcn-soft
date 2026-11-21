/** @file Parameterized PostgreSQL storage and transactional migrations for isolated homes. */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';

export interface SQL {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}
export class CloudDatabase {
  readonly pool: Pool;
  constructor(connectionString: string, options: { schema?: string } = {}) {
    if (options.schema && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(options.schema))
      throw new Error('Invalid database schema');
    this.pool = new Pool({
      connectionString,
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      options: options.schema ? `-c search_path=${options.schema}` : undefined,
    });
    this.pool.on('error', () => {}); // Request callers receive errors; never log secret-bearing URLs.
  }
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, values);
  }
  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async migrate(sql?: string): Promise<void> {
    const source =
      sql || (await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'));
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(646321)');
      await client.query(source);
    });
  }
  close(): Promise<void> {
    return this.pool.end();
  }
}
