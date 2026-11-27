/** @file Durable local administrator sessions without a server expiry, plus login throttling. */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { type HubCredentials, validPassword, validUsername } from './credentials.js';
import { maximumSessions, SessionStore } from './session-store.js';

const cookieName = 'fcplcn_hub_session';
// Browsers cap cookie lifetimes; active panels renew daily without expiring the server session.
const cookieLifetimeSeconds = 400 * 24 * 60 * 60;
const cookieRenewalMs = 24 * 60 * 60 * 1000;
export class Sessions {
  private sessions: Set<string>;
  private readonly store: SessionStore;
  private binding: string;
  private readonly renewAfter = new Map<string, number>();
  private readonly failures = new Map<string, { until: number; attempts: number }>();
  constructor(private readonly credentials: HubCredentials) {
    this.store = new SessionStore(dirname(credentials.path));
    this.binding = credentials.sessionBinding();
    this.sessions = this.store.load(this.binding);
  }
  get required(): boolean {
    return true;
  }

  private token(request: IncomingMessage): string {
    const raw = request.headers.cookie
      ?.split(';')
      .find((part) => part.trim().startsWith(`${cookieName}=`));
    const token = raw ? raw.trim().slice(cookieName.length + 1) : '';
    return /^[a-f0-9]{64}$/.test(token) ? token : '';
  }
  private key(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  authenticated(request: IncomingMessage, response?: ServerResponse): boolean {
    if (!this.credentials.available) return false;
    this.syncCredentials();
    const token = this.token(request);
    if (!token) return false;
    const key = this.key(token);
    if (!this.sessions.has(key)) return false;
    if (response && Date.now() >= (this.renewAfter.get(key) || 0)) this.cookie(response, token);
    return true;
  }

  /** A committed account update revokes all prior hashes even if session-file cleanup fails. */
  private syncCredentials(): void {
    const binding = this.credentials.sessionBinding();
    if (binding === this.binding) return;
    this.binding = binding;
    this.sessions.clear();
    this.renewAfter.clear();
    this.store.save(binding, this.sessions, () => {});
  }

  private cookie(response: ServerResponse, token: string): void {
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${cookieLifetimeSeconds}`,
    );
    this.renewAfter.set(this.key(token), Date.now() + cookieRenewalMs);
  }

  /** Return 429 before an expensive password derivation after repeated failures. */
  login(
    request: IncomingMessage,
    response: ServerResponse,
    username: unknown,
    password: unknown,
  ): number {
    if (!this.credentials.available) return 503;
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
    this.syncCredentials();
    const next = new Set(this.sessions);
    if (next.size >= maximumSessions) next.delete(next.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    next.add(this.key(token));
    this.store.save(this.binding, next, () => {
      this.sessions = next;
      for (const key of this.renewAfter.keys()) if (!next.has(key)) this.renewAfter.delete(key);
    });
    this.cookie(response, token);
    return 200;
  }

  /** @brief Read the current login; private password material never leaves the store. */
  account(): { username: string } {
    return this.credentials.snapshot();
  }

  /** @brief Require the old password and revoke every existing web session after an atomic save. */
  async change(
    request: IncomingMessage,
    response: ServerResponse,
    data: Record<string, unknown>,
  ): Promise<number> {
    if (!this.credentials.available) return 503;
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
      // Even saving the unchanged login explicitly signs out existing panels. A fresh salt
      // makes that revocation durable without changing the credential file format.
      const password =
        data.newPassword === undefined && data.username === this.credentials.snapshot().username
          ? data.currentPassword
          : (data.newPassword as string | undefined);
      await this.credentials.update(data.username, password);
    } finally {
      if (!this.credentials.available) this.clearCookie(response);
      else if (this.credentials.revision !== revision) {
        try {
          this.syncCredentials();
        } finally {
          this.clearCookie(response);
        }
      }
    }
    this.failures.delete(address);
    return 200;
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    const key = this.key(this.token(request));
    const next = new Set(this.sessions);
    next.delete(key);
    this.store.save(this.binding, next, () => {
      this.sessions = next;
      this.renewAfter.delete(key);
    });
    this.clearCookie(response);
  }

  private clearCookie(response: ServerResponse): void {
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
  }
}
