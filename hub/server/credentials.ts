/** @file Durable local hub account; only salted password hashes are written to private storage. */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { HubDatabase } from './database.js';

interface Credentials {
  version: 1;
  username: string;
  salt: string;
  passwordHash: string;
}

export interface HubCredentials {
  readonly path: string;
  readonly revision: number;
  readonly available: boolean;
  snapshot(): { username: string };
  sessionBinding(): string;
  matches(username: string, password: string): boolean;
  update(username: string, password?: string): void | Promise<void>;
}

/** @brief Accept a readable login and an explicitly empty password or the existing password limits. */
export function validUsername(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    /^[\p{L}\p{N}_.@-]{1,64}$/u.test(value) &&
    Buffer.byteLength(value) <= 128
  );
}
export function validPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= 256 &&
    (value.length === 0 || value.length >= 8)
  );
}

function hashed(username: string, password: string): Credentials {
  const salt = randomBytes(16);
  return {
    version: 1,
    username,
    salt: salt.toString('hex'),
    passwordHash: scryptSync(password, salt, 32).toString('hex'),
  };
}

function valid(value: unknown): value is Credentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Credentials;
  return (
    Object.keys(row).sort().join(',') === 'passwordHash,salt,username,version' &&
    row.version === 1 &&
    validUsername(row.username) &&
    typeof row.salt === 'string' &&
    /^[a-f0-9]{32}$/.test(row.salt) &&
    typeof row.passwordHash === 'string' &&
    /^[a-f0-9]{64}$/.test(row.passwordHash)
  );
}

/** Read the existing file without rewriting it, including during the production migration. */
function readCredentials(path: string): Credentials | undefined {
  const information = lstatSync(path, { throwIfNoEntry: false });
  if (!information) return undefined;
  if (!information.isFile() || information.isSymbolicLink() || information.size > 4096)
    throw new Error('Учётная запись хаба должна храниться в обычном файле');
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Повреждён файл учётной записи хаба; данные сохранены без изменений');
  }
  if (!valid(saved))
    throw new Error('Неподдерживаемый формат учётной записи хаба; данные сохранены без изменений');
  return saved;
}

function bootstrap(initialPassword: string): Credentials {
  if (!validPassword(initialPassword)) throw new Error('Некорректный начальный пароль хаба');
  return hashed('admin', initialPassword);
}

function bindingFor(account: Credentials): string {
  return createHash('sha256').update(JSON.stringify(account)).digest('hex');
}

abstract class Account implements HubCredentials {
  private generation = 0;

  protected constructor(
    readonly path: string,
    protected current: Credentials,
    private binding = bindingFor(current),
  ) {}

  abstract update(username: string, password?: string): void | Promise<void>;

  get available(): boolean {
    return true;
  }

  get revision(): number {
    return this.generation;
  }

  /** @brief Return account information without password hashes, salts or credentials. */
  snapshot(): { username: string } {
    return { username: this.current.username };
  }

  /** Bind private durable sessions to the exact saved account without exposing its password hash. */
  sessionBinding(): string {
    return this.binding;
  }

  /** @brief Derive a candidate hash even for an incorrect login to keep comparison timing uniform. */
  matches(username: string, password: string): boolean {
    const candidate = scryptSync(password, Buffer.from(this.current.salt, 'hex'), 32);
    return (
      timingSafeEqual(candidate, Buffer.from(this.current.passwordHash, 'hex')) &&
      username === this.current.username &&
      this.available
    );
  }

  protected next(username: string, password?: string): Credentials {
    if (!validUsername(username) || (password !== undefined && !validPassword(password)))
      throw new Error('Некорректные данные учётной записи хаба');
    return password === undefined ? { ...this.current, username } : hashed(username, password);
  }

  protected publish(value: Credentials, binding = bindingFor(value)): void {
    this.current = value;
    this.binding = binding;
    this.generation++;
  }
}

/** Local account storage for the standalone demo. */
export class CredentialStore extends Account {
  constructor(
    private readonly directory: string,
    initialPassword = '',
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, 'credentials.json');
    const saved = readCredentials(path);
    super(path, saved ?? bootstrap(initialPassword));
    if (saved) chmodSync(path, 0o600);
    else this.persist(this.current);
  }

  /** Persist first, then publish the new account; omitted passwords preserve the existing hash. */
  update(username: string, password?: string): void {
    const next = this.next(username, password);
    this.persist(next, () => this.publish(next));
  }

  /** @brief Publish at the atomic rename; a later directory-sync failure still revokes old sessions. */
  private persist(value: Credentials, committed?: () => void): void {
    const information = lstatSync(this.path, { throwIfNoEntry: false });
    if (information && (!information.isFile() || information.isSymbolicLink()))
      throw new Error('Небезопасный файл учётной записи хаба');
    const temporary = this.path + '.next-' + randomBytes(6).toString('hex');
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(value) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      committed?.();
      const parent = openSync(this.directory, 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}

const credentialUnavailable = 'Хранилище учётной записи хаба недоступно';

/** PostgreSQL-backed single administrator, with the existing durable session binding. */
export class PostgresCredentialStore extends Account {
  private updating = false;
  private usable = true;

  private constructor(
    private readonly database: HubDatabase,
    path: string,
    account: Credentials,
    binding: string,
  ) {
    super(path, account, binding);
  }

  static async open(
    database: HubDatabase,
    directory: string,
    initialPassword = '',
  ): Promise<PostgresCredentialStore> {
    const path = join(directory, 'credentials.json');
    const { account, binding } = await database.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(646331)');
      await sql.query(`CREATE TABLE IF NOT EXISTS hub_accounts (
        id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        username text NOT NULL,
        salt text NOT NULL CHECK (salt ~ '^[a-f0-9]{32}$'),
        password_hash text NOT NULL CHECK (password_hash ~ '^[a-f0-9]{64}$'),
        session_binding text NOT NULL CHECK (session_binding ~ '^[a-f0-9]{64}$')
      )`);
      const found = await sql.query<{
        username: string;
        salt: string;
        password_hash: string;
        session_binding: string;
      }>('SELECT username, salt, password_hash, session_binding FROM hub_accounts WHERE id = 1');
      const row = found.rows[0];
      if (row) {
        const saved = {
          version: 1,
          username: row.username,
          salt: row.salt,
          passwordHash: row.password_hash,
        };
        if (!valid(saved) || !/^[a-f0-9]{64}$/.test(row.session_binding))
          throw new Error('Повреждена учётная запись хаба в PostgreSQL');
        return { account: saved, binding: row.session_binding };
      }
      const saved = readCredentials(path) ?? bootstrap(initialPassword);
      // The legacy hash depends on the original order of keys in credentials.json. Capture
      // it before converting the account to columns so sessions also survive later restarts.
      const legacyBinding = bindingFor(saved);
      await sql.query(
        `INSERT INTO hub_accounts (username, salt, password_hash, session_binding)
         VALUES ($1, $2, $3, $4)`,
        [saved.username, saved.salt, saved.passwordHash, legacyBinding],
      );
      return { account: saved, binding: legacyBinding };
    });
    return new PostgresCredentialStore(database, path, account, binding);
  }

  override get available(): boolean {
    return this.usable;
  }

  async update(username: string, password?: string): Promise<void> {
    if (!this.usable) throw Object.assign(new Error(credentialUnavailable), { statusCode: 503 });
    if (this.updating)
      throw Object.assign(new Error('Учётная запись уже сохраняется. Повторите запрос.'), {
        statusCode: 409,
      });
    const next = this.next(username, password);
    const nextBinding = bindingFor(next);
    const { username: previousName, salt, passwordHash } = this.current;
    this.updating = true;
    try {
      const result = await this.database.query(
        `UPDATE hub_accounts SET username = $1, salt = $2, password_hash = $3, session_binding = $4
         WHERE id = 1 AND username = $5 AND salt = $6 AND password_hash = $7 AND session_binding = $8`,
        [
          next.username,
          next.salt,
          next.passwordHash,
          nextBinding,
          previousName,
          salt,
          passwordHash,
          this.sessionBinding(),
        ],
      );
      if (result.rowCount !== 1) throw new Error('Credential changed outside of this hub');
      this.publish(next, nextBinding);
    } catch {
      // A failed acknowledgement can hide a committed change. Do not accept cached credentials
      // or sessions until startup has read the authoritative row again.
      this.usable = false;
      throw Object.assign(new Error(credentialUnavailable), { statusCode: 503 });
    } finally {
      this.updating = false;
    }
  }
}
