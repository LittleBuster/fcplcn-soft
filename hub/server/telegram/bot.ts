/** @file Cancellable private-chat polling; checkpoints precede every possible PLC operation. */
import { formatTelegramMessage } from '../../shared/telegram-format.js';
import type { TelegramContact, TelegramRuntimeStatus } from '../../shared/telegram.js';
import { TelegramAPIError, TelegramClient, type TelegramTransport } from './client.js';
import { TelegramMenu, type TelegramActions } from './menu.js';
import { type HubTelegramStore, telegramChatId } from './store.js';
import { withActivity } from '../activity-context.js';
export type { TelegramActions } from './menu.js';

export interface TelegramBotOptions {
  productName?: string;
  /** Test-only transport injection; production always uses the official HTTPS Bot API. */
  transportFactory?: (token: string) => TelegramTransport;
  now?: () => number;
  backoffMs?: number;
  pollingTimeout?: number;
  settleMs?: number;
}
interface Message {
  chatId: string;
  name: string;
  username: string;
  date: number;
  text: string;
}
interface Context {
  generation: number;
  revision: number;
  token: string;
  abort: AbortController;
  transport: TelegramTransport;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const safeText = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';

/** @brief Trust only genuine human private messages; group membership never grants PLC access. */
function privateMessage(update: Record<string, unknown>): Message | null {
  const message = update.message;
  if (
    !object(message) ||
    !object(message.chat) ||
    !object(message.from) ||
    message.chat.type !== 'private' ||
    message.from.is_bot !== false ||
    !Number.isSafeInteger(message.chat.id) ||
    message.chat.id !== message.from.id ||
    !telegramChatId(String(message.chat.id)) ||
    !Number.isSafeInteger(message.date) ||
    Number(message.date) <= 0
  )
    return null;
  const name = [safeText(message.from.first_name, 96), safeText(message.from.last_name, 96)]
    .filter(Boolean)
    .join(' ');
  const username =
    typeof message.from.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(message.from.username)
      ? message.from.username
      : '';
  return {
    chatId: String(message.chat.id),
    name,
    username,
    date: Number(message.date),
    text: typeof message.text === 'string' ? message.text.slice(0, 4096) : '',
  };
}

/** @brief Delay without preventing shutdown or configuration-revocation cancellation. */
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', complete);
      resolve();
    };
    const timer = setTimeout(complete, milliseconds);
    signal.addEventListener('abort', complete, { once: true });
  });
}

/** @brief Own one generation of outgoing polling, with no command outbox or incoming webhook. */
export class TelegramBot {
  private generation = 0;
  private context: Context | null = null;
  private task: Promise<void> | null = null;
  private readonly menu: TelegramMenu;
  private readonly now: () => number;
  private readonly factory: (token: string) => TelegramTransport;
  private readonly denied = new Map<string, number>();
  private status: TelegramRuntimeStatus = {
    state: 'disabled',
    botUsername: '',
    botName: '',
    lastPollAt: null,
    error: null,
  };

  constructor(
    private readonly store: HubTelegramStore,
    actions: TelegramActions,
    private readonly options: TelegramBotOptions = {},
  ) {
    this.menu = new TelegramMenu(actions, options.settleMs, options.productName);
    this.now = options.now || Date.now;
    this.factory = options.transportFactory || ((token) => new TelegramClient(token));
  }

  start(): void {
    this.reload();
  }

  /** @brief Invalidate old menus and queued work immediately when access or credentials change. */
  reload(): void {
    this.context?.abort.abort();
    this.context = null;
    this.generation++;
    this.menu.clear();
    this.denied.clear();
    const config = this.store.config();
    this.status = {
      state: this.store.error ? 'error' : 'disabled',
      botUsername: '',
      botName: '',
      lastPollAt: null,
      error: this.store.error,
    };
    if (!config.enabled || !config.token || this.store.error) return;
    let transport: TelegramTransport;
    try {
      transport = this.factory(config.token);
    } catch {
      this.status = { ...this.status, state: 'error', error: 'Неверный формат токена Telegram' };
      return;
    }
    const context = {
      generation: this.generation,
      revision: config.revision,
      token: config.token,
      abort: new AbortController(),
      transport,
    };
    this.context = context;
    this.status.state = 'connecting';
    this.task = this.loop(context).catch(() => {
      if (this.current(context))
        this.status = {
          ...this.status,
          state: 'error',
          error: this.store.error || 'Бот остановлен из-за ошибки подключения',
        };
    });
  }

  async stop(): Promise<void> {
    this.generation++;
    this.context?.abort.abort();
    this.context = null;
    this.menu.clear();
    this.denied.clear();
    const pending = this.task;
    this.task = null;
    this.status = { ...this.status, state: 'disabled', error: this.store.error };
    // Transport is required to honor its abort signal. The public HTTP transport always does.
    await pending;
  }

  snapshot(): TelegramRuntimeStatus {
    return this.store.error
      ? { ...this.status, state: 'error', error: this.store.error }
      : { ...this.status };
  }

  /** @brief Validate a saved token without sending anybody a message or modifying webhook state. */
  async test(): Promise<{ ok: true; botUsername: string; botName: string }> {
    const config = this.store.config();
    if (this.store.error) throw new TelegramAPIError(this.store.error);
    if (!config.token) throw new TelegramAPIError('Сначала сохраните API-токен бота', 401);
    const abort = new AbortController();
    const transport = this.factory(config.token);
    const unchanged = () => {
      if (this.store.error || this.store.config().token !== config.token)
        throw new TelegramAPIError('Настройки бота изменились. Повторите проверку', 409);
    };
    const identity = await transport.identity(abort.signal);
    unchanged();
    if (await transport.webhook(abort.signal))
      throw new TelegramAPIError(
        'Для бота настроен вебхук. Отключите его перед подключением к хабу',
        409,
      );
    unchanged();
    return { ok: true, botUsername: identity.username, botName: identity.name };
  }

  private current(context: Context): boolean {
    const config = this.store.config();
    return (
      this.context === context &&
      this.generation === context.generation &&
      !context.abort.signal.aborted &&
      config.enabled &&
      config.revision === context.revision &&
      config.token === context.token &&
      !this.store.error
    );
  }

  private contact(message: Message): TelegramContact {
    return {
      chatId: message.chatId,
      name: message.name,
      username: message.username,
      receivedAt: new Date(this.now()).toISOString(),
    };
  }

  private fresh(message: Message): boolean {
    const age = this.now() - message.date * 1000;
    return age >= 0 && age <= 30_000;
  }

  private async consume(
    context: Context,
    value: unknown,
    execute: boolean,
  ): Promise<number | null> {
    if (
      !object(value) ||
      !Number.isSafeInteger(value.update_id) ||
      Number(value.update_id) < 1 ||
      !this.current(context)
    )
      return null;
    const id = Number(value.update_id);
    const current = () => this.current(context);
    if (execute && !(await this.store.checkpoint(id, current))) return id;
    const message = privateMessage(value);
    if (!message || !current()) return id;
    await this.store.observeContact(this.contact(message), current);
    if (!execute || !current()) return id;
    const permitted = () => current() && this.store.allowed(message.chatId) && this.fresh(message);
    if (!this.fresh(message)) return id;
    if (!this.store.allowed(message.chatId)) {
      const now = this.now();
      const last = this.denied.get(message.chatId);
      if (last === undefined || now - last >= 60_000) {
        if (this.denied.size >= 128) this.denied.delete(this.denied.keys().next().value!);
        this.denied.set(message.chatId, now);
        await context.transport.send(
          message.chatId,
          {
            text: formatTelegramMessage([
              '🔒 Доступ к управлению не разрешён.',
              `Ваш Chat ID: ${message.chatId}`,
              'Попросите администратора добавить его в настройках хаба.',
            ]),
            parse_mode: 'HTML',
            reply_markup: { remove_keyboard: true },
          },
          context.abort.signal,
        );
      }
      return id;
    }
    const account = this.store.config().chats.find((chat) => chat.chatId === message.chatId);
    const name =
      account?.name ||
      message.name ||
      (message.username && `@${message.username}`) ||
      message.chatId;
    const reply = await withActivity(
      { actor: { source: 'telegram', name, id: message.chatId } },
      () => this.menu.handle(message.chatId, message.text, permitted, context.abort.signal),
    );
    if (permitted()) await context.transport.send(message.chatId, reply, context.abort.signal);
    return id;
  }

  private async loop(context: Context): Promise<void> {
    let failures = 0;
    let offset = this.store.cursor() + 1;
    let bootstrap = true;
    while (this.current(context)) {
      try {
        if (bootstrap) {
          this.status = { ...this.status, state: 'connecting', error: null };
          const identity = await context.transport.identity(context.abort.signal);
          if (!this.current(context)) return;
          if (await context.transport.webhook(context.abort.signal))
            throw new TelegramAPIError(
              'Для бота настроен вебхук. Отключите его перед подключением к хабу',
              409,
            );
          if (!this.current(context)) return;
          this.status.botName = identity.name;
          this.status.botUsername = identity.username;
          const pending = await context.transport.updates(-1, 0, context.abort.signal);
          if (!this.current(context)) return;
          let latest = 0;
          // Negative offset discards the backlog. Its last contact helps pairing, but never actuates.
          for (const update of pending) {
            if (!this.current(context)) return;
            const id = await this.consume(context, update, false);
            if (id !== null) latest = id;
          }
          if (!this.current(context)) return;
          await this.store.bootstrapCheckpoint(latest, () => this.current(context));
          if (!this.current(context)) return;
          offset = latest + 1;
          bootstrap = false;
          this.status = {
            ...this.status,
            state: 'running',
            lastPollAt: new Date(this.now()).toISOString(),
            error: null,
          };
        }
        const updates = await context.transport.updates(
          offset,
          this.options.pollingTimeout ?? 30,
          context.abort.signal,
        );
        if (!this.current(context)) return;
        this.status = {
          ...this.status,
          state: 'running',
          lastPollAt: new Date(this.now()).toISOString(),
          error: null,
        };
        failures = 0;
        for (const update of updates) {
          if (!this.current(context)) return;
          const id = await this.consume(context, update, true);
          if (id !== null) offset = Math.max(offset, id + 1);
        }
        if (!updates.length && (this.options.pollingTimeout ?? 30) === 0)
          await delay(10, context.abort.signal);
      } catch (error) {
        if (!this.current(context)) return;
        const safe =
          error instanceof TelegramAPIError
            ? error.message
            : this.store.error || 'Бот не подтвердил обработку сообщения';
        this.status = { ...this.status, state: 'error', error: safe };
        if (this.store.error) return;
        if (error instanceof TelegramAPIError && [401, 409].includes(error.code)) return;
        bootstrap = true;
        const seconds = error instanceof TelegramAPIError ? error.retryAfter : 0;
        const backoff = seconds
          ? seconds * 1000
          : Math.min(30_000, (this.options.backoffMs ?? 1000) * 2 ** Math.min(failures++, 5));
        await delay(backoff, context.abort.signal);
      }
    }
  }
}
