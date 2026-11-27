/** @file Exercise preservation of hub and Telegram access against a disposable PostgreSQL schema. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sessions } from '../server/auth.js';
import { CredentialStore, PostgresCredentialStore } from '../server/credentials.js';
import { HubDatabase } from '../server/database.js';
import { PostgresTelegramStore } from '../server/telegram/postgres-store.js';
import { TelegramStore, TelegramStoreError } from '../server/telegram/store.js';

const url = process.env.FCPLCN_HUB_TEST_DATABASE_URL;

test(
  'PostgreSQL imports the admin, current session binding, and Telegram grants and cursor once',
  {
    skip: !url,
  },
  async () => {
    if (!url) return;
    const directory = mkdtempSync(join(tmpdir(), 'fcplcn-accounts-postgres-test-'));
    const schema = 'accounts_test_' + randomBytes(8).toString('hex');
    const admin = new HubDatabase(url);
    const database = new HubDatabase(url, { schema });
    const token = '123456:token-abcdefghijklmnopqrstuvwx';
    const nextToken = '123457:token-abcdefghijklmnopqrstuvwx';
    const firstChat = '4503599627370495';
    const secondChat = '12345678';
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const initial = new CredentialStore(directory);
      initial.update('owner', 'legacy-password');
      const raw = JSON.parse(readFileSync(initial.path, 'utf8'));
      writeFileSync(
        initial.path,
        JSON.stringify({
          username: raw.username,
          passwordHash: raw.passwordHash,
          salt: raw.salt,
          version: raw.version,
        }),
      );
      const legacy = new CredentialStore(directory);
      const sessions = new Sessions(legacy);
      let cookie = '';
      const response = {
        setHeader(name: string, value: string) {
          if (name === 'Set-Cookie') cookie = value.split(';')[0];
        },
      } as ServerResponse;
      const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
      assert.equal(sessions.login(request, response, 'owner', 'legacy-password'), 200);
      request.headers.cookie = cookie;

      const legacyTelegram = new TelegramStore(directory);
      legacyTelegram.update({
        baseRevision: 1,
        enabled: true,
        token,
        chats: [
          { chatId: firstChat, name: 'Хозяин' },
          { chatId: secondChat, name: 'Гость' },
        ],
      });
      legacyTelegram.observeContact({
        chatId: firstChat,
        name: 'Дом',
        username: 'owner',
        receivedAt: '2026-05-20T09:23:00.000Z',
      });
      assert.equal(legacyTelegram.checkpoint(121), true);
      const legacyCredentialsBytes = readFileSync(legacy.path);
      const legacyTelegramBytes = readFileSync(legacyTelegram.path);

      const account = await PostgresCredentialStore.open(database, directory, 'unused-bootstrap');
      assert.equal(account.matches('owner', 'legacy-password'), true);
      assert.equal(account.sessionBinding(), legacy.sessionBinding());
      assert.equal(new Sessions(account).authenticated(request), true);
      assert.equal(
        new Sessions(await PostgresCredentialStore.open(database, directory)).authenticated(
          request,
        ),
        true,
      );
      const telegram = await PostgresTelegramStore.open(database, directory);
      assert.deepEqual(telegram.snapshot(), legacyTelegram.snapshot());
      assert.equal(telegram.cursor(), 121);
      assert.equal(telegram.allowed(firstChat), true);
      assert.equal(telegram.allowed(secondChat), true);
      assert.deepEqual(await Promise.all([telegram.checkpoint(122), telegram.checkpoint(122)]), [
        true,
        false,
      ]);

      const previousRevision = telegram.config().revision;
      const edit = telegram.update({
        baseRevision: previousRevision,
        enabled: true,
        token: nextToken,
        chats: [{ chatId: firstChat, name: 'Дом' }],
      });
      const stale = telegram.checkpoint(123, () => telegram.config().revision === previousRevision);
      await edit;
      assert.equal(await stale, false);
      assert.equal(telegram.cursor(), 0);
      assert.equal(telegram.allowed(secondChat), false);
      assert.equal(await telegram.checkpoint(3), true);
      assert.equal(
        await new Sessions(account).change(request, response, {
          username: 'owner',
          currentPassword: 'legacy-password',
          newPassword: 'rotated-password',
        }),
        200,
      );

      const reopenedAccount = await PostgresCredentialStore.open(database, directory);
      assert.equal(reopenedAccount.matches('owner', 'rotated-password'), true);
      assert.equal(new Sessions(reopenedAccount).authenticated(request), false);
      const reopenedTelegram = await PostgresTelegramStore.open(database, directory);
      assert.equal(reopenedTelegram.cursor(), 3);
      assert.deepEqual(reopenedTelegram.snapshot(), telegram.snapshot());
      assert.equal(reopenedTelegram.allowed(secondChat), false);
      assert.equal(JSON.stringify(reopenedTelegram.snapshot()).includes(nextToken), false);
      assert.deepEqual(readFileSync(legacy.path), legacyCredentialsBytes);
      assert.deepEqual(readFileSync(legacyTelegram.path), legacyTelegramBytes);

      await database.query('DROP TABLE hub_telegram_users, hub_telegram_settings, hub_accounts');
      await assert.rejects(
        () => reopenedTelegram.checkpoint(4),
        (error) => error instanceof TelegramStoreError && error.statusCode === 503,
      );
      assert.equal(reopenedTelegram.allowed(firstChat), false);
      await assert.rejects(() => reopenedAccount.update('owner', 'new-password'));
      assert.equal(reopenedAccount.available, false);
      assert.equal(reopenedAccount.matches('owner', 'rotated-password'), false);

      writeFileSync(legacyTelegram.path, '{broken');
      const corrupt = await PostgresTelegramStore.open(database, directory);
      assert.ok(corrupt.error);
      assert.equal(corrupt.allowed(firstChat), false);
      assert.equal(readFileSync(legacyTelegram.path, 'utf8'), '{broken');
      assert.equal(
        (await database.query("SELECT to_regclass('hub_telegram_settings') AS existing_table"))
          .rows[0].existing_table,
        null,
      );
    } finally {
      await database.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
