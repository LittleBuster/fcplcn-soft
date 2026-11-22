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

interface Credentials {
  version: 1;
  username: string;
  salt: string;
  passwordHash: string;
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

export class CredentialStore {
  readonly path: string;
  private current: Credentials;
  private generation = 0;

  get revision(): number {
    return this.generation;
  }

  /** @brief Bootstrap admin once; an environment password never replaces a saved account. */
  constructor(
    private readonly directory: string,
    initialPassword = '',
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, 'credentials.json');
    const information = lstatSync(this.path, { throwIfNoEntry: false });
    if (!information) {
      if (!validPassword(initialPassword)) throw new Error('Некорректный начальный пароль хаба');
      this.current = this.hashed('admin', initialPassword);
      this.persist(this.current);
    } else {
      if (!information.isFile() || information.isSymbolicLink() || information.size > 4096)
        throw new Error('Учётная запись хаба должна храниться в обычном файле');
      let saved: unknown;
      try {
        saved = JSON.parse(readFileSync(this.path, 'utf8'));
      } catch {
        throw new Error('Повреждён файл учётной записи хаба; данные сохранены без изменений');
      }
      if (!this.valid(saved))
        throw new Error(
          'Неподдерживаемый формат учётной записи хаба; данные сохранены без изменений',
        );
      this.current = saved;
      chmodSync(this.path, 0o600);
    }
  }

  /** @brief Return account information without password hashes, salts or credentials. */
  snapshot(): { username: string } {
    return { username: this.current.username };
  }

  /** Bind private durable sessions to the exact saved account without exposing its password hash. */
  sessionBinding(): string {
    return createHash('sha256').update(JSON.stringify(this.current)).digest('hex');
  }

  /** @brief Derive a candidate hash even for an incorrect login to keep comparison timing uniform. */
  matches(username: string, password: string): boolean {
    const candidate = scryptSync(password, Buffer.from(this.current.salt, 'hex'), 32);
    return (
      timingSafeEqual(candidate, Buffer.from(this.current.passwordHash, 'hex')) &&
      username === this.current.username
    );
  }

  /** @brief Persist first, then publish the new account; omitted passwords preserve the existing hash. */
  update(username: string, password?: string): void {
    if (!validUsername(username) || (password !== undefined && !validPassword(password)))
      throw new Error('Некорректные данные учётной записи хаба');
    const next =
      password === undefined ? { ...this.current, username } : this.hashed(username, password);
    this.persist(next, () => {
      this.current = next;
      this.generation++;
    });
  }

  private hashed(username: string, password: string): Credentials {
    const salt = randomBytes(16);
    return {
      version: 1,
      username,
      salt: salt.toString('hex'),
      passwordHash: scryptSync(password, salt, 32).toString('hex'),
    };
  }

  private valid(value: unknown): value is Credentials {
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
