/** @file Atomic, hub-private bot credentials, access grants and before-action update checkpoints. */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  TelegramAllowedChat,
  TelegramConfigPatch,
  TelegramContact,
  TelegramStoreView,
} from '../../shared/telegram.js';

const MAX_CHATS = 64;
const MAX_BYTES = 64 * 1024;
const MAX_CHAT_ID = 2 ** 52 - 1;
const MAX_REVISION = 0xffff_ffff;
export const telegramStorageError =
  'Не удалось прочитать или сохранить настройки Telegram. Бот отключён.';
const UNKNOWN_PERSON = 'Имя появится после первого сообщения';

export interface StoredChat {
  chatId: string;
  label: string;
  name: string;
  username: string;
  lastSeenAt: string | null;
}
export interface StoredTelegram {
  version: 1;
  config: { revision: number; enabled: boolean; token: string | null; chats: StoredChat[] };
  lastContact: TelegramContact | null;
  cursor: { tokenHash: string; updateId: number };
}
/** Server-only settings; never serialize this type into an HTTP response or telemetry. */
export interface TelegramPrivateConfig {
  revision: number;
  enabled: boolean;
  token: string | null;
  chats: TelegramAllowedChat[];
}

export interface HubTelegramStore {
  readonly error: string | null;
  snapshot(): TelegramStoreView;
  config(): TelegramPrivateConfig;
  allowed(chatId: string): boolean;
  cursor(): number;
  update(input: unknown): TelegramStoreView | Promise<TelegramStoreView>;
  observeContact(value: TelegramContact, current?: () => boolean): void | Promise<void>;
  bootstrapCheckpoint(updateId: number, current?: () => boolean): void | Promise<void>;
  checkpoint(updateId: number, current?: () => boolean): boolean | Promise<boolean>;
}

/** A bounded public validation/concurrency/storage refusal without secret-bearing exception text. */
export class TelegramStoreError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'TelegramStoreError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function text(value: unknown, maximum = 96): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function revision(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REVISION;
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}
function tokenHash(token: string | null): string {
  return token ? createHash('sha256').update(token).digest('hex') : '';
}
/** Use decimal strings so people IDs are never truncated to a 32-bit integer. */
export function telegramChatId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number(value) <= MAX_CHAT_ID;
}
/** Accept the Bot API token alphabet without assuming a fixed future token length. */
export function validTelegramToken(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}:[A-Za-z0-9_-]{20,256}$/.test(value);
}
export function defaultTelegramState(): StoredTelegram {
  return {
    version: 1,
    config: { revision: 1, enabled: false, token: null, chats: [] },
    lastContact: null,
    cursor: { tokenHash: '', updateId: 0 },
  };
}
function chatView(chat: StoredChat): TelegramAllowedChat {
  return {
    chatId: chat.chatId,
    name: chat.label || chat.name || UNKNOWN_PERSON,
    username: chat.username,
    lastSeenAt: chat.lastSeenAt,
  };
}
function contact(value: unknown): value is TelegramContact {
  return (
    object(value) &&
    only(value, ['chatId', 'name', 'username', 'receivedAt']) &&
    telegramChatId(value.chatId) &&
    text(value.name) &&
    typeof value.username === 'string' &&
    /^[A-Za-z0-9_]{0,64}$/.test(value.username) &&
    timestamp(value.receivedAt)
  );
}
/** Bound names supplied by Telegram before persisting them or rendering them as plain text. */
function observedName(value: unknown): string {
  if (typeof value !== 'string') return '';
  let result = '';
  for (const character of value.replace(/[\x00-\x1f\x7f]/g, ' ').trim()) {
    if (Buffer.byteLength(result + character) > 96) break;
    result += character;
  }
  return result;
}

/** Decode only our known format. Broken files are retained and disable the bot. */
export function decodeTelegramState(value: unknown): StoredTelegram {
  if (
    !object(value) ||
    !only(value, ['version', 'config', 'lastContact', 'cursor']) ||
    value.version !== 1 ||
    !object(value.config) ||
    !only(value.config, ['revision', 'enabled', 'token', 'chats']) ||
    !revision(value.config.revision) ||
    typeof value.config.enabled !== 'boolean' ||
    !(value.config.token === null || validTelegramToken(value.config.token)) ||
    (value.config.enabled && !value.config.token) ||
    !Array.isArray(value.config.chats) ||
    value.config.chats.length > MAX_CHATS ||
    !(value.lastContact === null || contact(value.lastContact)) ||
    !object(value.cursor) ||
    !only(value.cursor, ['tokenHash', 'updateId']) ||
    value.cursor.tokenHash !== tokenHash(value.config.token) ||
    !Number.isSafeInteger(value.cursor.updateId) ||
    (value.cursor.updateId as number) < 0
  )
    throw new TelegramStoreError(telegramStorageError, 503);
  const seen = new Set<string>();
  for (const row of value.config.chats) {
    if (
      !object(row) ||
      !only(row, ['chatId', 'label', 'name', 'username', 'lastSeenAt']) ||
      !telegramChatId(row.chatId) ||
      seen.has(row.chatId) ||
      !text(row.label) ||
      !text(row.name) ||
      typeof row.username !== 'string' ||
      !/^[A-Za-z0-9_]{0,64}$/.test(row.username) ||
      !(row.lastSeenAt === null || timestamp(row.lastSeenAt))
    )
      throw new TelegramStoreError(telegramStorageError, 503);
    seen.add(row.chatId);
  }
  return structuredClone(value) as unknown as StoredTelegram;
}

/** Validate a legacy file without rewriting it, including during production migration. */
export function readTelegramFile(path: string): StoredTelegram | undefined {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('format');
    return decodeTelegramState(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    throw new TelegramStoreError(telegramStorageError, 503);
  }
}

/** Both stores keep the same validation and only publish committed views. */
export abstract class TelegramState {
  protected storageError: string | null = null;

  protected constructor(protected state = defaultTelegramState()) {}

  get error(): string | null {
    return this.storageError;
  }

  /** Return a clone of the public form. The token and replay cursor are never included. */
  snapshot(): TelegramStoreView {
    return {
      config: {
        revision: this.state.config.revision,
        enabled: !this.storageError && this.state.config.enabled,
        tokenConfigured: Boolean(this.state.config.token),
        chats: this.state.config.chats.map(chatView),
      },
      lastContact: this.state.lastContact ? { ...this.state.lastContact } : null,
    };
  }

  /** Only the runtime may read credentials; a storage failure immediately fails closed. */
  config(): TelegramPrivateConfig {
    return {
      revision: this.state.config.revision,
      enabled: !this.storageError && this.state.config.enabled,
      token: this.storageError ? null : this.state.config.token,
      chats: this.state.config.chats.map(chatView),
    };
  }

  allowed(chatId: string): boolean {
    return (
      !this.storageError &&
      this.state.config.enabled &&
      this.state.config.chats.some((chat) => chat.chatId === chatId)
    );
  }

  /** Save one explicit administrator revision. Empty token fields are never interpreted as a reset. */
  protected nextUpdate(input: unknown): StoredTelegram {
    this.requireHealthy();
    if (
      !object(input) ||
      !only(input, ['baseRevision', 'enabled', 'token', 'chats']) ||
      !revision(input.baseRevision) ||
      typeof input.enabled !== 'boolean' ||
      !Array.isArray(input.chats) ||
      input.chats.length > MAX_CHATS ||
      ('token' in input && input.token !== null && !validTelegramToken(input.token))
    )
      throw new TelegramStoreError('Укажите состояние бота, корректный токен и список людей');
    if (input.baseRevision !== this.state.config.revision)
      throw new TelegramStoreError(
        'Настройки Telegram изменены. Обновите страницу перед сохранением.',
        409,
      );
    if (this.state.config.revision === MAX_REVISION)
      throw new TelegramStoreError('Исчерпан номер ревизии настроек Telegram', 409);
    const token = 'token' in input ? (input.token as string | null) : this.state.config.token;
    if (input.enabled && !token)
      throw new TelegramStoreError('Перед включением бота сохраните его API-токен');
    const replaced = token !== this.state.config.token;
    const seen = new Set<string>();
    const chats: StoredChat[] = input.chats.map((row: unknown) => {
      if (
        !object(row) ||
        !only(row, ['chatId', 'name']) ||
        !telegramChatId(row.chatId) ||
        seen.has(row.chatId) ||
        !text(row.name)
      )
        throw new TelegramStoreError('Укажите уникальные Chat ID личных чатов и имена до 96 байт');
      seen.add(row.chatId);
      const previous = this.state.config.chats.find((entry) => entry.chatId === row.chatId);
      const observed =
        !replaced && this.state.lastContact?.chatId === row.chatId ? this.state.lastContact : null;
      const label = row.name.trim();
      return {
        chatId: row.chatId,
        label: previous && label === chatView(previous).name ? previous.label : label,
        name: replaced ? '' : previous?.name || observed?.name || '',
        username: replaced ? '' : previous?.username || observed?.username || '',
        lastSeenAt: replaced ? null : previous?.lastSeenAt || observed?.receivedAt || null,
      };
    });
    return {
      ...structuredClone(this.state),
      config: { revision: input.baseRevision + 1, enabled: input.enabled, token, chats },
      ...(replaced
        ? { lastContact: null, cursor: { tokenHash: tokenHash(token), updateId: 0 } }
        : {}),
    };
  }

  /** Remember the last human who wrote privately, without granting access or changing form revision. */
  protected nextContact(value: TelegramContact): StoredTelegram {
    this.requireHealthy();
    const clean: TelegramContact = {
      chatId: value.chatId,
      name: observedName(value.name),
      username:
        typeof value.username === 'string' && /^[A-Za-z0-9_]{0,64}$/.test(value.username)
          ? value.username
          : '',
      receivedAt: value.receivedAt,
    };
    if (!contact(clean)) throw new TelegramStoreError('Некорректные данные собеседника Telegram');
    const next = structuredClone(this.state);
    next.lastContact = clean;
    const row = next.config.chats.find((entry) => entry.chatId === clean.chatId);
    if (row) {
      row.name = clean.name;
      row.username = clean.username;
      row.lastSeenAt = clean.receivedAt;
    }
    return next;
  }

  cursor(): number {
    return this.storageError ? 0 : this.state.cursor.updateId;
  }

  /**
   * Rebase only after a successful getUpdates(offset=-1) drain, whose contents are never executed.
   * Telegram may choose a lower random update ID after a week without traffic. An empty drain
   * therefore resets the local cursor to zero; ordinary delivery still uses strict checkpoint().
   */
  protected nextBootstrapCheckpoint(updateId: number): StoredTelegram | undefined {
    this.requireHealthy();
    if (!Number.isSafeInteger(updateId) || updateId < 0)
      throw new TelegramStoreError('Некорректный номер начального сообщения Telegram');
    if (updateId === this.state.cursor.updateId) return;
    const next = structuredClone(this.state);
    next.cursor.updateId = updateId;
    return next;
  }

  /** Persist acknowledgement before executing any command, ensuring retries cannot actuate twice. */
  protected nextCheckpoint(updateId: number): StoredTelegram | undefined {
    this.requireHealthy();
    if (!Number.isSafeInteger(updateId) || updateId < 1)
      throw new TelegramStoreError('Некорректный номер сообщения Telegram');
    if (updateId <= this.state.cursor.updateId) return;
    const next = structuredClone(this.state);
    next.cursor.updateId = updateId;
    return next;
  }

  private requireHealthy(): void {
    if (this.storageError) throw new TelegramStoreError(this.storageError, 503);
  }

  protected serialized(next: StoredTelegram): string {
    const bytes = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES)
      throw new TelegramStoreError('Слишком большой файл настроек Telegram', 413);
    return bytes;
  }
}

/** Local Telegram storage for standalone demo and test instances. */
export class TelegramStore extends TelegramState implements HubTelegramStore {
  readonly path: string;

  constructor(private readonly directory: string) {
    super();
    this.path = join(directory, 'telegram.json');
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const saved = readTelegramFile(this.path);
      if (saved) {
        this.state = saved;
        chmodSync(this.path, 0o600);
      }
    } catch {
      this.storageError = telegramStorageError;
    }
  }

  update(input: unknown): TelegramStoreView {
    this.commit(this.nextUpdate(input));
    return this.snapshot();
  }

  observeContact(value: TelegramContact, current?: () => boolean): void {
    if (current?.() !== false) this.commit(this.nextContact(value));
  }

  bootstrapCheckpoint(updateId: number, current?: () => boolean): void {
    if (current?.() === false) return;
    const next = this.nextBootstrapCheckpoint(updateId);
    if (next) this.commit(next);
  }

  checkpoint(updateId: number, current?: () => boolean): boolean {
    if (current?.() === false) return false;
    const next = this.nextCheckpoint(updateId);
    if (!next) return false;
    this.commit(next);
    return true;
  }

  /** Atomically commit bounded secrets and fsync both the file and its containing directory. */
  private commit(next: StoredTelegram): void {
    const bytes = this.serialized(next);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
      descriptor = openSync(this.directory, 'r');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.state = next;
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          /* Preserve the original storage refusal. */
        }
      }
      try {
        unlinkSync(temporary);
      } catch {
        /* A successful rename leaves no temporary file. */
      }
      this.storageError = telegramStorageError;
      throw new TelegramStoreError(telegramStorageError, 503);
    }
  }
}
