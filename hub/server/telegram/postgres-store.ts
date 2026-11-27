/** @file PostgreSQL-backed Telegram access and before-action checkpoints. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TelegramContact, TelegramStoreView } from '../../shared/telegram.js';
import type { HubDatabase, HubSql } from '../database.js';
import {
  decodeTelegramState,
  defaultTelegramState,
  readTelegramFile,
  TelegramState,
  telegramStorageError,
  TelegramStoreError,
  type HubTelegramStore,
  type StoredChat,
  type StoredTelegram,
} from './store.js';

const schema = `
  CREATE TABLE IF NOT EXISTS hub_telegram_settings (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 4294967295),
    enabled boolean NOT NULL,
    token text CHECK (NOT enabled OR token IS NOT NULL),
    last_contact jsonb,
    token_hash text NOT NULL,
    update_id bigint NOT NULL CHECK (update_id BETWEEN 0 AND 9007199254740991),
    change_id uuid NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hub_telegram_users (
    chat_id text PRIMARY KEY CHECK (chat_id ~ '^[1-9][0-9]{0,15}$'),
    settings_id smallint NOT NULL DEFAULT 1 REFERENCES hub_telegram_settings (id),
    position smallint NOT NULL CHECK (position BETWEEN 0 AND 63),
    label text NOT NULL CHECK (octet_length(label) <= 96),
    name text NOT NULL CHECK (octet_length(name) <= 96),
    username text NOT NULL,
    last_seen_at text
  );
`;

interface SettingsRow {
  revision: string;
  enabled: boolean;
  token: string | null;
  last_contact: unknown;
  token_hash: string;
  update_id: string;
  change_id: string;
}

function settingsValues(state: StoredTelegram, changeId: string): unknown[] {
  return [
    state.config.revision,
    state.config.enabled,
    state.config.token,
    state.lastContact,
    state.cursor.tokenHash,
    state.cursor.updateId,
    changeId,
  ];
}

async function writeUsers(sql: HubSql, chats: StoredChat[]): Promise<void> {
  await sql.query('DELETE FROM hub_telegram_users WHERE NOT (chat_id = ANY($1::text[]))', [
    chats.map(({ chatId }) => chatId),
  ]);
  if (!chats.length) return;
  const changes = chats.map(({ chatId, lastSeenAt, ...chat }, position) => ({
    chat_id: chatId,
    last_seen_at: lastSeenAt,
    position,
    ...chat,
  }));
  await sql.query(
    `INSERT INTO hub_telegram_users AS saved (chat_id, position, label, name, username, last_seen_at)
     SELECT chat_id, position, label, name, username, last_seen_at
       FROM jsonb_to_recordset($1::jsonb) AS next (chat_id text, position smallint,
         label text, name text, username text, last_seen_at text)
     ON CONFLICT (chat_id) DO UPDATE SET position = excluded.position, label = excluded.label,
       name = excluded.name, username = excluded.username, last_seen_at = excluded.last_seen_at
     WHERE (saved.position, saved.label, saved.name, saved.username, saved.last_seen_at)
       IS DISTINCT FROM (excluded.position, excluded.label, excluded.name, excluded.username,
         excluded.last_seen_at)`,
    [JSON.stringify(changes)],
  );
}

export class PostgresTelegramStore extends TelegramState implements HubTelegramStore {
  private pending: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly database: HubDatabase,
    state: StoredTelegram,
    private changeId: string,
  ) {
    super(state);
  }

  static async open(database: HubDatabase, directory: string): Promise<PostgresTelegramStore> {
    try {
      return await this.load(database, directory);
    } catch (error) {
      if (!(error instanceof TelegramStoreError)) throw error;
      // As with the standalone store, malformed records disable Telegram. A rolled-back
      // import leaves both the source file and PostgreSQL untouched for a later recovery.
      const store = new PostgresTelegramStore(database, defaultTelegramState(), randomUUID());
      store.storageError = telegramStorageError;
      return store;
    }
  }

  private static load(database: HubDatabase, directory: string): Promise<PostgresTelegramStore> {
    return database.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(646332)');
      await sql.query(schema);
      const settings = await sql.query<SettingsRow>(
        'SELECT * FROM hub_telegram_settings WHERE id = 1 FOR SHARE',
      );
      const row = settings.rows[0];
      if (row) {
        const users =
          await sql.query<StoredChat>(`SELECT chat_id AS "chatId", label, name, username,
          last_seen_at AS "lastSeenAt" FROM hub_telegram_users ORDER BY position, chat_id`);
        const existing = decodeTelegramState({
          version: 1,
          config: {
            revision: Number(row.revision),
            enabled: row.enabled,
            token: row.token,
            chats: users.rows,
          },
          lastContact: row.last_contact,
          cursor: { tokenHash: row.token_hash, updateId: Number(row.update_id) },
        });
        return new PostgresTelegramStore(database, existing, row.change_id);
      }

      const state = readTelegramFile(join(directory, 'telegram.json')) ?? defaultTelegramState();
      const changeId = randomUUID();
      await sql.query(
        `INSERT INTO hub_telegram_settings
         (revision, enabled, token, last_contact, token_hash, update_id, change_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        settingsValues(state, changeId),
      );
      await writeUsers(sql, state.config.chats);
      return new PostgresTelegramStore(database, state, changeId);
    });
  }

  update(input: unknown): Promise<TelegramStoreView> {
    return this.enqueue(async () => {
      await this.commit(this.nextUpdate(input));
      return this.snapshot();
    });
  }

  observeContact(value: TelegramContact, current?: () => boolean): Promise<void> {
    return this.enqueue(async () => {
      if (current?.() !== false) await this.commit(this.nextContact(value));
    });
  }

  bootstrapCheckpoint(updateId: number, current?: () => boolean): Promise<void> {
    return this.enqueue(async () => {
      if (current?.() === false) return;
      const next = this.nextBootstrapCheckpoint(updateId);
      if (next) await this.commit(next);
    });
  }

  checkpoint(updateId: number, current?: () => boolean): Promise<boolean> {
    return this.enqueue(async () => {
      if (current?.() === false) return false;
      const next = this.nextCheckpoint(updateId);
      if (!next) return false;
      await this.commit(next);
      return true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  private async commit(next: StoredTelegram): Promise<void> {
    this.serialized(next);
    const changeId = randomUUID();
    try {
      await this.database.transaction(async (sql) => {
        const result = await sql.query(
          `UPDATE hub_telegram_settings SET revision = $1, enabled = $2, token = $3,
           last_contact = $4, token_hash = $5, update_id = $6, change_id = $7
           WHERE id = 1 AND change_id = $8`,
          [...settingsValues(next, changeId), this.changeId],
        );
        if (result.rowCount !== 1) throw new Error('Telegram storage changed outside of this hub');
        if (JSON.stringify(next.config.chats) !== JSON.stringify(this.state.config.chats))
          await writeUsers(sql, next.config.chats);
      });
      this.changeId = changeId;
      this.state = next;
    } catch {
      // A failed or unacknowledged transaction must never allow a queued physical action.
      this.storageError = telegramStorageError;
      throw new TelegramStoreError(telegramStorageError, 503);
    }
  }
}
