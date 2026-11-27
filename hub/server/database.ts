/** @file Private PostgreSQL pool shared by the hub's local repositories. */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export interface HubSql {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

export class HubDatabase implements HubSql {
  private readonly pool: Pool;

  constructor(connectionString: string, options: { schema?: string } = {}) {
    if (options.schema && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(options.schema))
      throw new Error('Некорректная схема PostgreSQL хаба');
    this.pool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
      application_name: 'fcplcn-hub',
      options: options.schema ? `-c search_path=${options.schema}` : undefined,
    });
    // An unused client can disconnect during maintenance. pg replaces it on the next request.
    // The request paths handle their own errors without logging the connection string.
    this.pool.on('error', () => {});
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
