/** @file Isolated Telegram transport/runtime regressions; never contact the live Bot API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelegramBot } from '../server/telegram/bot.js';
import { TelegramStore } from '../server/telegram/store.js';
import {
  TelegramAPIError,
  TelegramClient,
  type TelegramReply,
  type TelegramTransport,
} from '../server/telegram/client.js';
import type { TelegramActions } from '../server/telegram/menu.js';
import type { CommandView, SceneRun } from '../shared/types.js';

const token = '123456:abcdefghijklmnopqrstuvwxyz_0123456789';
const stamp = Math.floor(Date.now() / 1000) * 1000;
const message = (id: number, text: string, chatId = 42, date = stamp / 1000) => ({
  update_id: id,
  message: {
    date,
    text,
    chat: { id: chatId, type: 'private' },
    from: {
      id: chatId,
      is_bot: false,
      first_name: 'Сергей',
      last_name: 'Иванов',
      username: 'sergey',
    },
  },
});
const until = async (check: () => boolean) => {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Telegram test condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
class Transport implements TelegramTransport {
  sent: { chatId: string; reply: TelegramReply }[] = [];
  polls: number[] = [];
  bootstrap: unknown[] = [];
  queued: unknown[][] = [];
  waiting: ((value: unknown[]) => void) | null = null;
  identityCalls = 0;
  conflict = false;
  identityError: Error | null = null;
  sendError: Error | null = null;
  async identity() {
    this.identityCalls++;
    if (this.identityError) throw this.identityError;
    return { id: 123456, username: 'FCPLCn_test_bot', name: 'FCPLCn' };
  }
  async webhook() {
    return this.conflict;
  }
  async updates(offset: number, _timeout: number, signal: AbortSignal): Promise<unknown[]> {
    this.polls.push(offset);
    if (offset === -1) return this.bootstrap.splice(0);
    if (this.queued.length) return this.queued.shift()!;
    return new Promise((resolve) => {
      const done = (value: unknown[]) => {
        this.waiting = null;
        signal.removeEventListener('abort', cancel);
        resolve(value);
      };
      const cancel = () => done([]);
      this.waiting = done;
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  push(value: unknown) {
    if (this.waiting) this.waiting([value]);
    else this.queued.push([value]);
  }
  async send(chatId: string, reply: TelegramReply) {
    if (this.sendError) {
      const error = this.sendError;
      this.sendError = null;
      throw error;
    }
    this.sent.push({ chatId, reply });
  }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-telegram-bot-'));
  const store = new TelegramStore(directory);
  store.update({ baseRevision: 1, enabled: true, token, chats: [{ chatId: '42', name: '' }] });
  const transport = new Transport();
  const calls: unknown[][] = [];
  const runs: SceneRun[] = [];
  let commandHook: (() => Promise<void>) | null = null;
  const device = {
    id: 'fcplcn-test',
    name: 'Дом',
    room: '',
    online: true,
    status: 'online' as const,
    bootId: 'boot-1',
    boardId: 'test',
    firmwareVersion: 'test',
    lastSeenAt: null,
    uptimeSec: 100,
    controllers: {
      sockets: {
        kind: 'sockets' as const,
        fresh: true,
        receivedAt: '',
        data: {
          enabled: true,
          items: [
            { id: 'one', name: 'Первая', actual: false, available: true },
            { id: 'two', name: 'Вторая', actual: false, available: true },
          ],
        },
      },
    },
  };
  const actions: TelegramActions = {
    snapshot: () => ({
      broker: { connected: true, error: null },
      commands: [],
      devices: [structuredClone(device)],
    }),
    scenes: () => ({ definitions: [], activeRun: null, runs }),
    async command(deviceId, kind, itemId, value) {
      calls.push([deviceId, kind, itemId, value]);
      if (commandHook) await commandHook();
      return {
        id: 'command',
        deviceId,
        controller: kind,
        itemId,
        value,
        sequence: 1,
        status: 'applied',
        createdAt: '',
        completedAt: '',
        error: null,
      } satisfies CommandView;
    },
    runScene(id) {
      const run: SceneRun = {
        id,
        sceneId: id,
        name: id,
        status: 'completed',
        startedAt: '',
        completedAt: '',
        results: [],
      };
      runs.unshift(run);
      return run;
    },
  };
  const bot = new TelegramBot(store, actions, {
    transportFactory: () => transport,
    now: () => stamp,
    backoffMs: 1,
    settleMs: 0,
  });
  const close = async () => {
    await bot.stop();
    rmSync(directory, { recursive: true, force: true });
  };
  const send = async (id: number, text: string, chat = 42) => {
    const count = transport.sent.length;
    transport.push(message(id, text, chat));
    await until(() => transport.sent.length > count);
    return transport.sent.at(-1)!.reply;
  };
  return {
    store,
    transport,
    calls,
    runs,
    bot,
    close,
    send,
    setHook: (hook: () => Promise<void>) => {
      commandHook = hook;
    },
  };
}

test('disabled configuration performs no network requests; token test never sends a message', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-telegram-disabled-'));
  const store = new TelegramStore(directory),
    transport = new Transport();
  const actions = {
    snapshot: () => ({ broker: { connected: false, error: null }, commands: [], devices: [] }),
    scenes: () => ({ definitions: [], runs: [], activeRun: null }),
    command: async () => {
      throw new Error('unexpected');
    },
    runScene: () => {
      throw new Error('unexpected');
    },
  };
  const bot = new TelegramBot(store, actions, { transportFactory: () => transport });
  try {
    bot.start();
    assert.equal(bot.snapshot().state, 'disabled');
    assert.equal(transport.identityCalls, 0);
    store.update({ baseRevision: 1, enabled: false, token, chats: [] });
    assert.equal((await bot.test()).botUsername, 'FCPLCn_test_bot');
    assert.equal(transport.sent.length, 0);
  } finally {
    await bot.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('private last-contact pairing is visible before authorization; groups and forged people cannot control', async () => {
  const f = fixture();
  try {
    f.bot.start();
    await until(() => f.bot.snapshot().state === 'running');
    const denied = await f.send(1, '/start', 99);
    assert.equal(denied.parse_mode, 'HTML');
    assert.match(denied.text, /<b>Ваш Chat ID:<\/b> <code>99<\/code>/);
    assert.doesNotMatch(denied.text, /Дом|Розетк/);
    assert.equal(denied.reply_markup.remove_keyboard, true);
    assert.equal(f.store.snapshot().lastContact?.chatId, '99');
    assert.equal(f.store.snapshot().lastContact?.username, 'sergey');
    assert.equal(f.store.allowed('99'), false);
    const group = message(2, '🏠 Я дома');
    group.message.chat.type = 'group';
    f.transport.push(group);
    const forged = message(3, '🏠 Я дома');
    forged.message.from.id = 100;
    f.transport.push(forged);
    await until(() => f.store.cursor() === 3);
    assert.equal(f.runs.length, 0);
    assert.equal(f.store.snapshot().lastContact?.chatId, '99');
  } finally {
    await f.close();
  }
});

test('bootstrap drops pending actions, checkpoints precede live action, duplicate and stale updates never replay', async () => {
  const f = fixture();
  try {
    f.transport.bootstrap = [message(10, '🏠 Я дома')];
    f.bot.start();
    await until(() => f.bot.snapshot().state === 'running');
    assert.equal(f.runs.length, 0);
    assert.equal(f.store.cursor(), 10);
    await f.send(11, '/start');
    await f.send(12, '🏠 Я дома');
    assert.equal(f.runs.length, 1);
    assert.equal(f.store.cursor(), 12);
    f.transport.push(message(12, '🏠 Я дома'));
    f.transport.push(message(13, '🏠 Я дома', 42, stamp / 1000 - 31));
    f.transport.push(message(14, '🏠 Я дома', 42, stamp / 1000 + 1));
    await until(() => f.store.cursor() === 14);
    assert.equal(f.runs.length, 1);
    assert.equal(f.transport.sent.length, 2);
  } finally {
    await f.close();
  }
});

test('revoking access during a batch prevents the next channel and suppresses old-generation replies', async () => {
  const f = fixture();
  let release!: () => void;
  try {
    f.bot.start();
    await until(() => f.bot.snapshot().state === 'running');
    const root = await f.send(1, '/start');
    const device = await f.send(
      2,
      root.reply_markup.keyboard!.flat().find((label) => label.startsWith('🏡'))!,
    );
    const sockets = await f.send(
      3,
      device.reply_markup.keyboard!.flat().find((label) => label.includes('Розетки'))!,
    );
    f.setHook(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    f.transport.push(
      message(
        4,
        sockets.reply_markup.keyboard!.flat().find((label) => label.startsWith('🟢 Вкл все'))!,
      ),
    );
    await until(() => f.calls.length === 1);
    assert.equal(f.store.cursor(), 4, 'Durable checkpoint precedes the first physical callback');
    f.store.update({ baseRevision: 2, enabled: true, chats: [] });
    f.bot.reload();
    release();
    await until(() => f.bot.snapshot().state === 'running');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 1);
    assert.equal(f.transport.sent.length, 3);
  } finally {
    if (release) release();
    await f.close();
  }
});

test('webhook and invalid-token conflicts fail stopped rather than competing with another bot process', async () => {
  const f = fixture();
  try {
    f.transport.conflict = true;
    f.bot.start();
    await until(() => f.bot.snapshot().state === 'error');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.transport.identityCalls, 1);
    assert.match(f.bot.snapshot().error!, /вебхук/);
    f.transport.conflict = false;
    f.transport.identityError = new TelegramAPIError('Telegram отклонил токен бота', 401);
    f.bot.reload();
    await until(() => f.bot.snapshot().state === 'error');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.transport.identityCalls, 2);
    assert.equal(f.transport.sent.length, 0);
  } finally {
    await f.close();
  }
});

test('network recovery discards a pending old command and rebases a weekly lower update-id epoch', async () => {
  const f = fixture();
  try {
    f.store.bootstrapCheckpoint(5000);
    f.transport.bootstrap = [message(50, '🏠 Я дома')];
    f.bot.start();
    await until(() => f.bot.snapshot().state === 'running');
    assert.equal(f.store.cursor(), 50);
    assert.equal(f.runs.length, 0);
    await f.send(51, '/start');
    f.transport.sendError = new TelegramAPIError('Нет связи с Telegram');
    f.transport.bootstrap = [message(52, '🏠 Я дома')];
    f.transport.push(message(52, '🏠 Я дома'));
    await until(() => f.transport.polls.filter((offset) => offset === -1).length === 2);
    await until(() => f.bot.snapshot().state === 'running');
    assert.equal(f.runs.length, 1, 'A lost sendMessage reply does not repeat the scene action');
    assert.equal(f.store.cursor(), 52);
    await f.send(53, '/start');
    assert.equal(f.runs.length, 1);
  } finally {
    await f.close();
  }
});

test('HTTPS transport fixes the host, forbids redirects, uses native keyboard and redacts secret-bearing failures', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new TelegramClient(token, (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return new Response(
      JSON.stringify({
        ok: true,
        result: String(url).endsWith('/getMe')
          ? { id: 1, is_bot: true, first_name: 'FCPLCn', username: 'FCPLCn_bot' }
          : { message_id: 1 },
      }),
    );
  }) as typeof fetch);
  const signal = new AbortController().signal;
  await client.identity(signal);
  const html = `<b>${'&amp;'.repeat(1000)}</b>`;
  await client.send(
    '42',
    {
      text: html,
      parse_mode: 'HTML',
      reply_markup: { keyboard: [['🏠 Я дома']], resize_keyboard: true },
    },
    signal,
  );
  assert.ok(requests.every((request) => request.url.startsWith('https://api.telegram.org/bot')));
  assert.ok(requests.every((request) => request.init.redirect === 'error'));
  const message = JSON.parse(requests[1].init.body as string);
  assert.equal(message.text, html);
  assert.equal(message.parse_mode, 'HTML');
  assert.equal(message.reply_markup.keyboard[0][0], '🏠 Я дома');
  assert.deepEqual(message.link_preview_options, { is_disabled: true });
  const photo = Buffer.from([137, 80, 78, 71]);
  const replyMarkup = { keyboard: [['📈 24 часа', '📈 7 дней']], resize_keyboard: true };
  const caption = 'Метео <датчик> за 24 часа';
  await client.send(
    '42',
    { text: html, chart: { photo, caption }, reply_markup: replyMarkup },
    signal,
  );
  const photoRequest = requests[2];
  assert.match(photoRequest.url, /^https:\/\/api.telegram.org\/bot[^/]+\/sendPhoto$/);
  assert.equal(photoRequest.init.redirect, 'error');
  const upload = photoRequest.init.body;
  assert.ok(upload instanceof FormData);
  assert.equal(upload.get('chat_id'), '42');
  assert.equal(upload.get('caption'), caption);
  assert.equal(upload.get('parse_mode'), null);
  assert.deepEqual(JSON.parse(String(upload.get('reply_markup'))), replyMarkup);
  const file = upload.get('photo');
  assert.ok(file instanceof File);
  assert.equal(file.type, 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), photo);
  const failing = new TelegramClient(token, (async () => {
    throw new Error('Failed https://api.telegram.org/bot' + token);
  }) as typeof fetch);
  await assert.rejects(
    failing.identity(signal),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(token) && /Нет связи/.test(error.message),
  );
  const rateLimited = new TelegramClient(
    token,
    (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: token,
          parameters: { retry_after: 999 },
        }),
        { status: 429 },
      )) as typeof fetch,
  );
  await assert.rejects(
    rateLimited.identity(signal),
    (error: unknown) =>
      error instanceof TelegramAPIError &&
      error.retryAfter === 60 &&
      !error.message.includes(token),
  );
});

test('a retired bootstrap cannot overwrite the replacement token replay cursor', async () => {
  const f = fixture();
  const rebase = f.store.bootstrapCheckpoint.bind(f.store);
  const rebases: number[] = [];
  f.store.bootstrapCheckpoint = (id) => {
    rebases.push(id);
    rebase(id);
  };
  const observe = f.store.observeContact.bind(f.store);
  let switched = false;
  f.store.observeContact = (contact) => {
    observe(contact);
    if (switched) return;
    switched = true;
    f.store.update({
      baseRevision: 2,
      enabled: true,
      token: token + 'new',
      chats: [{ chatId: '42', name: '' }],
    });
    f.bot.reload();
  };
  try {
    f.transport.bootstrap = [message(999, '/start')];
    f.bot.start();
    await until(() => switched && f.bot.snapshot().state === 'running');
    assert.equal(
      rebases.includes(999),
      false,
      'The invalidated bootstrap must not persist against a new token',
    );
    assert.equal(f.store.cursor(), 0);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('failed durable checkpoint disables access before any command callback', async () => {
  const f = fixture();
  const directory = join(f.store.path, '..');
  const saved = directory + '-saved';
  let sabotaged = false;
  try {
    f.bot.start();
    await until(() => f.bot.snapshot().state === 'running');
    await f.send(1, '/start');
    renameSync(directory, saved);
    writeFileSync(directory, 'not a directory');
    sabotaged = true;
    f.transport.push(message(2, '🏠 Я дома'));
    await until(() => f.store.error !== null);
    assert.equal(f.bot.snapshot().state, 'error');
    assert.equal(f.store.allowed('42'), false);
    assert.equal(f.runs.length, 0);
  } finally {
    if (sabotaged) {
      unlinkSync(directory);
      renameSync(saved, directory);
    }
    await f.close();
  }
});

test('a token check cannot report success after the administrator replaces its saved credentials', async () => {
  const f = fixture();
  let release!: (value: { id: number; username: string; name: string }) => void;
  f.transport.identity = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  try {
    const checked = f.bot.test();
    f.store.update({
      baseRevision: 2,
      enabled: true,
      token: token + 'new',
      chats: [{ chatId: '42', name: '' }],
    });
    release({ id: 1, username: 'retired_bot', name: 'Retired' });
    await assert.rejects(
      checked,
      (error: unknown) => error instanceof TelegramAPIError && error.code === 409,
    );
    assert.equal(f.transport.sent.length, 0);
  } finally {
    await f.close();
  }
});
