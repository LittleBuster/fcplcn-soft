/** @file Durable local sessions outlive wall-clock time, while explicit revocation remains authoritative. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Sessions } from '../server/auth.js';
import { CredentialStore } from '../server/credentials.js';
import { maximumSessions, SessionStore } from '../server/session-store.js';

function request(cookie = '', address = '127.0.0.1'): IncomingMessage {
  return { headers: { cookie }, socket: { remoteAddress: address } } as unknown as IncomingMessage;
}
function response() {
  const headers = new Map<string, string>();
  const message = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
  } as unknown as ServerResponse;
  return { message, headers, cookie: () => headers.get('set-cookie')?.split(';')[0] || '' };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-durable-sessions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = new CredentialStore(directory);
  const sessions = new Sessions(credentials);
  const store = new SessionStore(directory);
  function login() {
    const reply = response();
    assert.equal(sessions.login(request(), reply.message, 'admin', ''), 200);
    return reply;
  }
  return { directory, credentials, sessions, store, login };
}

test('a local login has no 12-hour server expiry and survives a hub restart with only token hashes on disk', (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const signed = f.login();
  const cookie = signed.cookie();
  const token = cookie.split('=')[1];
  const saved = readFileSync(f.store.path, 'utf8');
  assert.equal(saved.includes(token), false);
  assert.equal(saved.includes(createHash('sha256').update(token).digest('hex')), true);
  assert.equal(statSync(f.store.path).mode & 0o777, 0o600);
  assert.match(
    signed.headers.get('set-cookie')!,
    /HttpOnly; SameSite=Strict; Path=\/; Max-Age=34560000/,
  );
  assert.equal(new Sessions(new CredentialStore(f.directory)).authenticated(request(cookie)), true);
  now += 500 * 24 * 60 * 60 * 1000;
  const renewed = response();
  assert.equal(f.sessions.authenticated(request(cookie), renewed.message), true);
  assert.equal(renewed.cookie(), cookie);
  const immediatelyAgain = response();
  assert.equal(f.sessions.authenticated(request(cookie), immediatelyAgain.message), true);
  assert.equal(
    immediatelyAgain.headers.has('set-cookie'),
    false,
    'Polling does not rewrite the cookie every two seconds',
  );
  assert.equal(new Sessions(new CredentialStore(f.directory)).authenticated(request(cookie)), true);
  assert.equal(f.sessions.authenticated(request('fcplcn_hub_session=' + '0'.repeat(64))), false);
  assert.equal(f.sessions.authenticated(request('fcplcn_hub_session=invalid')), false);
});

test('logout revokes just its own durable session, including after restart', (t) => {
  const f = fixture(t);
  const first = f.login().cookie();
  const second = f.login().cookie();
  const signedOut = response();
  f.sessions.logout(request(first), signedOut.message);
  assert.match(signedOut.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(f.sessions.authenticated(request(first)), false);
  assert.equal(f.sessions.authenticated(request(second)), true);
  const restarted = new Sessions(new CredentialStore(f.directory));
  assert.equal(restarted.authenticated(request(first)), false);
  assert.equal(restarted.authenticated(request(second)), true);
});

test('a pre-commit logout I/O failure preserves its session and cookie until a durable retry succeeds', (t) => {
  const f = fixture(t);
  const cookie = f.login().cookie();
  const before = readFileSync(f.store.path, 'utf8');
  const store = Reflect.get(f.sessions, 'store') as SessionStore;
  const failure = t.mock.method(store, 'save', () => {
    throw Object.assign(new Error('Read-only session filesystem'), { code: 'EROFS' });
  });
  const unsuccessful = response();
  assert.throws(() => f.sessions.logout(request(cookie), unsuccessful.message), /Read-only/);
  assert.equal(
    unsuccessful.headers.has('set-cookie'),
    false,
    'An uncommitted logout does not erase its browser credential',
  );
  assert.equal(f.sessions.authenticated(request(cookie)), true);
  assert.equal(readFileSync(f.store.path, 'utf8'), before);
  assert.equal(new Sessions(new CredentialStore(f.directory)).authenticated(request(cookie)), true);
  failure.mock.restore();

  const retried = response();
  f.sessions.logout(request(cookie), retried.message);
  assert.match(retried.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(f.sessions.authenticated(request(cookie)), false);
  assert.equal(
    new Sessions(new CredentialStore(f.directory)).authenticated(request(cookie)),
    false,
  );
});

test('a logout failure reported after the file commit cannot restore its revoked session', (t) => {
  const f = fixture(t);
  const cookie = f.login().cookie();
  const store = Reflect.get(f.sessions, 'store') as SessionStore;
  const save = store.save.bind(store);
  t.mock.method(store, 'save', (binding: string, tokens: Set<string>, committed: () => void) => {
    save(binding, tokens, committed);
    throw Object.assign(new Error('Directory sync failed after commit'), { code: 'EIO' });
  });
  assert.throws(() => f.sessions.logout(request(cookie), response().message), /after commit/);
  assert.equal(f.sessions.authenticated(request(cookie)), false);
  assert.equal(
    new Sessions(new CredentialStore(f.directory)).authenticated(request(cookie)),
    false,
  );
});

test('saving an unchanged account still revokes all sessions durably; the credential schema stays compatible', async (t) => {
  const f = fixture(t);
  const first = f.login().cookie();
  const second = f.login().cookie();
  const before = readFileSync(f.credentials.path, 'utf8');
  const changed = response();
  assert.equal(
    await f.sessions.change(request(first), changed.message, {
      username: 'admin',
      currentPassword: '',
    }),
    200,
  );
  assert.match(changed.headers.get('set-cookie')!, /Max-Age=0/);
  assert.notEqual(readFileSync(f.credentials.path, 'utf8'), before);
  assert.equal(f.credentials.matches('admin', ''), true);
  assert.equal(f.sessions.authenticated(request(first)), false);
  assert.equal(f.sessions.authenticated(request(second)), false);
  const restarted = new Sessions(new CredentialStore(f.directory));
  assert.equal(restarted.authenticated(request(first)), false);
  assert.equal(restarted.authenticated(request(second)), false);
});

test('a committed credential replacement invalidates a stale session file even when cleanup cannot be saved', async (t) => {
  const f = fixture(t);
  const cookie = f.login().cookie();
  const oldSessions = readFileSync(f.store.path, 'utf8');
  rmSync(f.store.path);
  mkdirSync(f.store.path);
  const changed = response();
  await assert.rejects(
    () =>
      f.sessions.change(request(cookie), changed.message, {
        username: 'owner',
        currentPassword: '',
        newPassword: 'updated-password',
      }),
    /файл сессий/,
  );
  assert.match(changed.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(f.sessions.authenticated(request(cookie)), false);
  rmSync(f.store.path, { recursive: true });
  writeFileSync(f.store.path, oldSessions);
  const credentials = new CredentialStore(f.directory);
  assert.equal(credentials.matches('owner', 'updated-password'), true);
  assert.equal(new Sessions(credentials).authenticated(request(cookie)), false);
});

test('corrupt, oversized, linked and malformed session files fail closed without erasing evidence', (t) => {
  const f = fixture(t);
  f.login();
  const valid = JSON.parse(readFileSync(f.store.path, 'utf8')) as { tokens: string[] };
  for (const invalid of [
    '{broken',
    'x'.repeat(16_385),
    JSON.stringify({ ...valid, tokens: ['not-a-hash'] }),
    JSON.stringify({ ...valid, tokens: [valid.tokens[0], valid.tokens[0]] }),
    JSON.stringify({ ...valid, unexpected: true }),
  ]) {
    writeFileSync(f.store.path, invalid);
    assert.throws(() => new Sessions(new CredentialStore(f.directory)), /сессий|Сессии/);
    assert.equal(readFileSync(f.store.path, 'utf8'), invalid);
  }
  rmSync(f.store.path);
  symlinkSync(join(f.directory, 'missing'), f.store.path);
  assert.throws(() => new Sessions(new CredentialStore(f.directory)), /обычном/);
});

test('a failed durable login never issues a bearer cookie and the bounded store evicts only the oldest session', (t) => {
  const f = fixture(t);
  mkdirSync(f.store.path);
  const failed = response();
  assert.throws(() => f.sessions.login(request(), failed.message, 'admin', ''), /файл сессий/);
  assert.equal(failed.headers.has('set-cookie'), false);
  rmSync(f.store.path, { recursive: true });
  const tokens = Array.from({ length: maximumSessions }, (_, index) =>
    index.toString(16).padStart(64, '0'),
  );
  writeFileSync(
    f.store.path,
    JSON.stringify({
      version: 1,
      credentialBinding: f.credentials.sessionBinding(),
      tokens: tokens.map((token) => createHash('sha256').update(token).digest('hex')),
    }),
  );
  const sessions = new Sessions(new CredentialStore(f.directory));
  const reply = response();
  assert.equal(sessions.login(request(), reply.message, 'admin', ''), 200);
  assert.equal(sessions.authenticated(request('fcplcn_hub_session=' + tokens[0])), false);
  assert.equal(sessions.authenticated(request('fcplcn_hub_session=' + tokens.at(-1))), true);
  assert.equal(sessions.authenticated(request(reply.cookie())), true);
  assert.equal(
    (JSON.parse(readFileSync(f.store.path, 'utf8')) as { tokens: string[] }).tokens.length,
    maximumSessions,
  );
});

test('removing the local session lifetime preserves password throttling and its minute-long recovery', (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  for (let index = 0; index < 5; index++)
    assert.equal(f.sessions.login(request(), response().message, 'admin', 'wrong'), 401);
  assert.equal(f.sessions.login(request(), response().message, 'admin', ''), 429);
  now += 60_001;
  assert.equal(f.sessions.login(request(), response().message, 'admin', ''), 200);
});
