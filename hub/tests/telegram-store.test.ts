/** @file Credentials, grants and replay checkpoints stay durable, bounded and private. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramStore, TelegramStoreError } from '../server/telegram/store.js';

const token = '123456789:abcdefghijklmnopqrstuvwxyz_123456789';
const secondToken = '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789';
const receivedAt = '2026-11-20T04:30:00.000Z';
function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-telegram-store-'));
  const store = new TelegramStore(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store };
}
function save(store: TelegramStore, changes: Record<string, unknown> = {}) {
  const { config } = store.snapshot();
  return store.update({
    baseRevision: config.revision,
    enabled: config.enabled,
    chats: config.chats.map(({ chatId, name }) => ({ chatId, name })),
    ...changes,
  });
}
function status(statusCode: number) {
  return (error: unknown) => error instanceof TelegramStoreError && error.statusCode === statusCode;
}

test('Telegram defaults disabled, and private token and durable cursor never appear in the public view', (t) => {
  const { directory, store } = fixture(t);
  assert.deepEqual(store.snapshot(), {
    config: { revision: 1, enabled: false, tokenConfigured: false, chats: [] },
    lastContact: null,
  });
  assert.equal(store.cursor(), 0);
  assert.equal(existsSync(store.path), false);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const view = save(store, {
    token,
    enabled: true,
    chats: [{ chatId: '123456789', name: 'Сергей' }],
  });
  assert.equal(store.allowed('123456789'), true);
  assert.equal(store.allowed('123456788'), false);
  assert.equal(view.config.tokenConfigured, true);
  assert.equal(store.checkpoint(500), true);
  assert.equal(store.checkpoint(500), false);
  assert.equal(store.checkpoint(499), false);
  assert.equal(store.cursor(), 500);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  const publicText = JSON.stringify(store.snapshot());
  assert.equal(publicText.includes(token), false);
  assert.equal(publicText.includes('tokenHash'), false);
  assert.equal(publicText.includes('updateId'), false);
  const restarted = new TelegramStore(directory);
  assert.equal(restarted.config().token, token);
  assert.equal(restarted.cursor(), 500);
  assert.equal(restarted.checkpoint(500), false);
  const copied = restarted.config();
  copied.token = secondToken;
  copied.chats[0].name = 'Changed outside store';
  assert.equal(restarted.config().token, token);
  assert.equal(restarted.snapshot().config.chats[0].name, 'Сергей');
});

test('Token replacement and deletion are explicit, and enabling without a token is refused', (t) => {
  const { store } = fixture(t);
  assert.throws(() => save(store, { enabled: true }), status(400));
  assert.throws(() => save(store, { token: '' }), status(400));
  assert.throws(() => save(store, { token: 'https://api.telegram.org/bot' + token }), status(400));
  save(store, { token, enabled: true });
  save(store, { chats: [{ chatId: '100', name: 'Лена' }] });
  assert.equal(store.config().token, token, 'omitted token keeps the configured credential');
  assert.throws(() => save(store, { token: null }), status(400));
  store.observeContact({ chatId: '100', name: 'Elena', username: 'elena', receivedAt });
  store.checkpoint(1000);
  save(store, { token: secondToken });
  assert.equal(store.cursor(), 0);
  assert.equal(store.snapshot().lastContact, null);
  assert.equal(store.snapshot().config.chats[0].username, '');
  assert.equal(
    store.snapshot().config.chats[0].name,
    'Лена',
    'manual administrator label survives',
  );
  save(store, { enabled: false, token: null });
  assert.equal(store.config().token, null);
  assert.equal(store.snapshot().config.tokenConfigured, false);
  assert.equal(store.allowed('100'), false);
});

test('Config revisions reject concurrent edits and input bounds retain personal, unambiguous grants', (t) => {
  const { store } = fixture(t);
  save(store, { token, enabled: true });
  assert.throws(() => store.update({ baseRevision: 1, enabled: false, chats: [] }), status(409));
  for (const chats of [
    [{ chatId: '-100123456789', name: 'Группа' }],
    [{ chatId: '00123', name: 'Неоднозначный ID' }],
    [{ chatId: '4503599627370496', name: 'Слишком большой ID' }],
    [{ chatId: 123, name: 'Нужна строка' }],
    [{ chatId: '123', name: 'a'.repeat(97) }],
    [{ chatId: '123', name: 'строка\nс переносом' }],
    [
      { chatId: '123', name: 'A' },
      { chatId: '123', name: 'B' },
    ],
    Array.from({ length: 65 }, (_, i) => ({ chatId: String(i + 1), name: 'Person' })),
  ])
    assert.throws(() => save(store, { chats }), status(400));
  assert.throws(() => save(store, { unsupported: token }), status(400));
  save(store, { chats: [{ chatId: '4503599627370495', name: 'Допустимая граница' }] });
  assert.equal(store.allowed('4503599627370495'), true);
});

test('Last unauthorized person is visible without a grant, and observed identities never overwrite administrator labels', (t) => {
  const { store, directory } = fixture(t);
  save(store, { token, enabled: true });
  const before = store.snapshot().config.revision;
  store.observeContact({ chatId: '123', name: 'Сергей Петров', username: 'sergey', receivedAt });
  assert.equal(store.allowed('123'), false);
  assert.equal(
    store.snapshot().config.revision,
    before,
    'incoming metadata does not invalidate an open editor',
  );
  assert.deepEqual(store.snapshot().lastContact, {
    chatId: '123',
    name: 'Сергей Петров',
    username: 'sergey',
    receivedAt,
  });
  save(store, { chats: [{ chatId: '123', name: '' }] });
  assert.equal(store.allowed('123'), true);
  assert.equal(store.snapshot().config.chats[0].name, 'Сергей Петров');
  store.observeContact({
    chatId: '123',
    name: 'Сергей Новое имя',
    username: 'newname',
    receivedAt,
  });
  assert.equal(store.snapshot().config.chats[0].name, 'Сергей Новое имя');
  save(store, { chats: [{ chatId: '123', name: 'Хозяин дома' }] });
  store.observeContact({ chatId: '123', name: 'Other name', username: 'sameperson', receivedAt });
  const person = store.snapshot().config.chats[0];
  assert.equal(person.name, 'Хозяин дома');
  assert.equal(person.username, 'sameperson');
  assert.equal(new TelegramStore(directory).snapshot().config.chats[0].name, 'Хозяин дома');
  save(store, { chats: [] });
  assert.equal(store.allowed('123'), false);
  store.observeContact({ chatId: '123', name: 'Back again', username: 'sameperson', receivedAt });
  assert.equal(store.allowed('123'), false, 'incoming traffic never restores a revoked grant');
  assert.equal(store.snapshot().config.chats.length, 0);
});

test('Observed names are sanitized and bounded; token-scoped checkpoints survive disabling', (t) => {
  const { store } = fixture(t);
  save(store, { token, enabled: true, chats: [{ chatId: '123', name: '' }] });
  store.observeContact({
    chatId: '123',
    name: 'Я'.repeat(100) + '\ntext',
    username: '@invalid',
    receivedAt,
  });
  assert.ok(Buffer.byteLength(store.snapshot().lastContact!.name) <= 96);
  assert.equal(store.snapshot().lastContact!.username, '');
  store.checkpoint(100);
  save(store, { enabled: false });
  assert.equal(store.allowed('123'), false);
  assert.equal(store.cursor(), 100);
  save(store, { enabled: true });
  assert.equal(store.checkpoint(100), false);
  assert.equal(store.checkpoint(101), true);
  assert.throws(() => store.checkpoint(NaN), status(400));
});

test('Malformed, oversized and cursor-mismatched private files disable the bot without overwriting evidence', (t) => {
  const { store, directory } = fixture(t);
  save(store, { token, enabled: true });
  const good = readFileSync(store.path, 'utf8');
  const mismatched = JSON.parse(good);
  mismatched.cursor.tokenHash = '0'.repeat(64);
  for (const bytes of ['{"token":"' + token, 'x'.repeat(65537), JSON.stringify(mismatched)]) {
    writeFileSync(store.path, bytes);
    const broken = new TelegramStore(directory);
    assert.ok(broken.error);
    assert.equal(broken.config().enabled, false);
    assert.equal(broken.config().token, null);
    assert.equal(broken.allowed('123'), false);
    assert.throws(() => save(broken, { token: secondToken }), status(503));
    assert.equal(readFileSync(store.path, 'utf8'), bytes);
    assert.equal(String(broken.error).includes(token), false);
  }
});

test('A failed persistence step immediately revokes runtime access and never leaves temporary credentials behind', (t) => {
  const { store, directory } = fixture(t);
  save(store, { token, enabled: true, chats: [{ chatId: '123', name: 'Person' }] });
  assert.equal(store.allowed('123'), true);
  rmSync(store.path);
  mkdirSync(store.path);
  assert.throws(() => store.checkpoint(100), status(503));
  assert.equal(store.allowed('123'), false);
  assert.equal(store.config().token, null);
  assert.ok(store.error);
  assert.deepEqual(readdirSync(directory), ['telegram.json']);
});

test('Existing symbolic-link configuration paths, including dangling links, fail closed', (t) => {
  const { store, directory } = fixture(t);
  const destination = join(directory, 'missing-private-file');
  symlinkSync(destination, store.path);
  const broken = new TelegramStore(directory);
  assert.ok(broken.error);
  assert.throws(() => save(broken, { token }), status(503));
  assert.equal(existsSync(destination), false);
});

test('A drained startup queue may establish a lower Telegram epoch without changing configuration', (t) => {
  const { store, directory } = fixture(t);
  save(store, { token, enabled: true });
  store.checkpoint(10000);
  const revision = store.snapshot().config.revision;
  store.bootstrapCheckpoint(400);
  assert.equal(store.cursor(), 400);
  assert.equal(store.checkpoint(400), false);
  assert.equal(store.checkpoint(401), true);
  assert.equal(new TelegramStore(directory).cursor(), 401);
  store.bootstrapCheckpoint(0);
  assert.equal(store.checkpoint(1), true);
  assert.equal(store.snapshot().config.revision, revision);
  assert.throws(() => store.bootstrapCheckpoint(-1), status(400));
});
