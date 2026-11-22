/** @file Private durable hashes for local sessions; no bearer tokens or session TTL are stored. */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

interface SavedSessions {
  version: 1;
  credentialBinding: string;
  tokens: string[];
}

const hashPattern = /^[a-f0-9]{64}$/;
export const maximumSessions = 128;

/** Load only validated hashes bound to the current account, preserving damaged files for recovery. */
export class SessionStore {
  readonly path: string;

  constructor(private readonly directory: string) {
    this.path = join(directory, 'sessions.json');
  }

  load(binding: string): Set<string> {
    const information = lstatSync(this.path, { throwIfNoEntry: false });
    if (!information) return new Set();
    if (!information.isFile() || information.isSymbolicLink() || information.size > 16_384)
      throw new Error('Сессии хаба должны храниться в обычном приватном файле');
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw new Error('Повреждён файл сессий хаба; данные сохранены без изменений');
    }
    if (!this.valid(saved))
      throw new Error('Неподдерживаемый формат сессий хаба; данные сохранены без изменений');
    chmodSync(this.path, 0o600);
    return new Set(saved.credentialBinding === binding ? saved.tokens : []);
  }

  /** Publish memory state at the atomic rename, including a later directory-sync failure. */
  save(binding: string, tokens: Set<string>, committed: () => void): void {
    const information = lstatSync(this.path, { throwIfNoEntry: false });
    if (information && (!information.isFile() || information.isSymbolicLink()))
      throw new Error('Небезопасный файл сессий хаба');
    const temporary = this.path + '.next-' + randomBytes(6).toString('hex');
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      const saved: SavedSessions = { version: 1, credentialBinding: binding, tokens: [...tokens] };
      writeFileSync(fd, JSON.stringify(saved) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      committed();
      const parent = openSync(dirname(this.path), 'r');
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

  private valid(value: unknown): value is SavedSessions {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as SavedSessions;
    return (
      Object.keys(row).sort().join(',') === 'credentialBinding,tokens,version' &&
      row.version === 1 &&
      typeof row.credentialBinding === 'string' &&
      hashPattern.test(row.credentialBinding) &&
      Array.isArray(row.tokens) &&
      row.tokens.length <= maximumSessions &&
      row.tokens.every((token) => typeof token === 'string' && hashPattern.test(token)) &&
      new Set(row.tokens).size === row.tokens.length
    );
  }
}
