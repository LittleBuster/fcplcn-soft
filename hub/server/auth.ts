/** @file Bounded local administrator sessions and login throttling. */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CredentialStore, validPassword, validUsername } from './credentials.js';

const cookieName = 'fcplcn_hub_session';
const lifetimeMs = 12 * 60 * 60 * 1000;
export class Sessions {
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, { until: number; attempts: number }>();
  constructor(private readonly credentials: CredentialStore) {}
  get required(): boolean {
    return true;
  }

  private token(request: IncomingMessage): string {
    const raw = request.headers.cookie
      ?.split(';')
      .find((part) => part.trim().startsWith(`${cookieName}=`));
    return raw ? raw.trim().slice(cookieName.length + 1) : '';
  }
  private key(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  authenticated(request: IncomingMessage): boolean {
    const key = this.key(this.token(request));
    const expires = this.sessions.get(key);
    if (!expires) return false;
    if (expires <= Date.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  /** Return 429 before an expensive password derivation after repeated failures. */
  login(
    request: IncomingMessage,
    response: ServerResponse,
    username: unknown,
    password: unknown,
  ): number {
    const now = Date.now(),
      address = request.socket.remoteAddress || 'unknown';
    for (const [key, value] of this.failures) if (value.until <= now) this.failures.delete(key);
    const failed = this.failures.get(address);
    if (failed && failed.attempts >= 5) return 429;
    if (
      typeof password !== 'string' ||
      Buffer.byteLength(password) > 256 ||
      typeof username !== 'string'
    )
      return 400;
    if (!this.credentials.matches(username, password)) {
      if (this.failures.size >= 256 && !failed)
        this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(address, {
        attempts: (failed?.attempts || 0) + 1,
        until: failed?.until || now + 60_000,
      });
      return 401;
    }
    this.failures.delete(address);
    for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key);
    if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(this.key(token), now + lifetimeMs);
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetimeMs / 1000}`,
    );
    return 200;
  }

  /** @brief Read the current login; private password material never leaves the store. */
  account(): { username: string } {
    return this.credentials.snapshot();
  }

  /** @brief Require the old password and revoke every existing web session after an atomic save. */
  change(
    request: IncomingMessage,
    response: ServerResponse,
    data: Record<string, unknown>,
  ): number {
    const now = Date.now(),
      address = request.socket.remoteAddress || 'unknown';
    for (const [key, value] of this.failures) if (value.until <= now) this.failures.delete(key);
    const failed = this.failures.get(address);
    if (failed && failed.attempts >= 5) return 429;
    if (
      Object.keys(data).some(
        (key) => !['username', 'currentPassword', 'newPassword'].includes(key),
      ) ||
      !validUsername(data.username) ||
      typeof data.currentPassword !== 'string' ||
      Buffer.byteLength(data.currentPassword) > 256 ||
      ('newPassword' in data && !validPassword(data.newPassword))
    )
      return 400;
    if (!this.credentials.matches(this.credentials.snapshot().username, data.currentPassword)) {
      if (this.failures.size >= 256 && !failed)
        this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(address, {
        attempts: (failed?.attempts || 0) + 1,
        until: failed?.until || now + 60000,
      });
      return 403;
    }
    const revision = this.credentials.revision;
    try {
      this.credentials.update(data.username, data.newPassword as string | undefined);
    } finally {
      if (this.credentials.revision !== revision) {
        this.sessions.clear();
        this.logout(request, response);
      }
    }
    this.failures.delete(address);
    return 200;
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    this.sessions.delete(this.key(this.token(request)));
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
  }
}
