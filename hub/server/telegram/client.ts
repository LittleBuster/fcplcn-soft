/** @file Restricted Telegram HTTPS transport with redacted failures and bounded responses. */
import { validTelegramToken } from './store.js';

export interface TelegramPhoto {
  photo: Buffer;
  caption: string;
}

export interface TelegramReply {
  text: string;
  parse_mode?: 'HTML';
  chart?: TelegramPhoto;
  reply_markup: {
    keyboard?: string[][];
    resize_keyboard?: boolean;
    is_persistent?: boolean;
    one_time_keyboard?: boolean;
    remove_keyboard?: boolean;
  };
}

export interface TelegramIdentity {
  id: number;
  username: string;
  name: string;
}

/** @brief A safe public diagnostic; it never includes an API URL, token or response body. */
export class TelegramAPIError extends Error {
  readonly statusCode: number;
  constructor(
    message: string,
    readonly code = 0,
    readonly retryAfter = 0,
  ) {
    super(message);
    this.name = 'TelegramAPIError';
    this.statusCode = code === 401 ? 400 : code === 409 ? 409 : 503;
  }
}

export interface TelegramTransport {
  identity(signal: AbortSignal): Promise<TelegramIdentity>;
  webhook(signal: AbortSignal): Promise<boolean>;
  updates(offset: number, timeout: number, signal: AbortSignal): Promise<unknown[]>;
  send(chatId: string, reply: TelegramReply, signal: AbortSignal): Promise<void>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @brief Contact only the official Bot API; the injectable fetch exists solely for isolated tests. */
export class TelegramClient implements TelegramTransport {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!validTelegramToken(token))
      throw new TelegramAPIError('Неверный формат токена Telegram', 401);
  }

  private async call(
    method: 'getMe' | 'getWebhookInfo' | 'getUpdates' | 'sendMessage' | 'sendPhoto',
    body: Record<string, unknown> | FormData,
    signal: AbortSignal,
    timeout = 12_000,
  ): Promise<unknown> {
    try {
      const multipart = body instanceof FormData;
      const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: multipart ? undefined : { 'Content-Type': 'application/json' },
        body: multipart ? body : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      });
      if (!response.body) throw new TelegramAPIError('Telegram вернул пустой ответ');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 512 * 1024) {
            await reader.cancel();
            throw new TelegramAPIError('Ответ Telegram превышает допустимый размер');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } catch {
        throw new TelegramAPIError('Telegram вернул некорректный ответ');
      }
      if (!object(value) || value.ok !== true || !response.ok) {
        const code =
          object(value) && Number.isInteger(value.error_code)
            ? Number(value.error_code)
            : response.status;
        const parameters = object(value) && object(value.parameters) ? value.parameters : {};
        const retry = Number.isInteger(parameters.retry_after)
          ? Math.min(60, Math.max(1, Number(parameters.retry_after)))
          : 0;
        const message =
          code === 401
            ? 'Telegram отклонил токен бота'
            : code === 403
              ? 'Пользователь запретил сообщения от бота'
              : code === 409
                ? 'Бот уже используется другим подключением или вебхуком'
                : code === 429
                  ? 'Telegram ограничил частоту запросов. Ожидаем разрешённый интервал'
                  : 'Telegram не подтвердил запрос';
        throw new TelegramAPIError(message, code, retry);
      }
      return value.result;
    } catch (error) {
      if (error instanceof TelegramAPIError) throw error;
      // Fetch errors may contain the entire secret-bearing request URL. Never propagate them.
      throw new TelegramAPIError(
        signal.aborted ? 'Запрос Telegram отменён' : 'Нет связи с Telegram',
      );
    }
  }

  async identity(signal: AbortSignal): Promise<TelegramIdentity> {
    const value = await this.call('getMe', {}, signal);
    if (
      !object(value) ||
      !Number.isSafeInteger(value.id) ||
      value.is_bot !== true ||
      typeof value.username !== 'string' ||
      typeof value.first_name !== 'string'
    )
      throw new TelegramAPIError('Telegram не подтвердил учётную запись бота');
    return {
      id: Number(value.id),
      username: value.username.slice(0, 64),
      name: value.first_name.slice(0, 128),
    };
  }

  async webhook(signal: AbortSignal): Promise<boolean> {
    const value = await this.call('getWebhookInfo', {}, signal);
    if (!object(value) || typeof value.url !== 'string')
      throw new TelegramAPIError('Не удалось проверить режим подключения бота');
    return Boolean(value.url);
  }

  async updates(offset: number, timeout: number, signal: AbortSignal): Promise<unknown[]> {
    const value = await this.call(
      'getUpdates',
      {
        offset,
        timeout,
        limit: 20,
        allowed_updates: ['message'],
      },
      signal,
      timeout > 0 ? 35_000 : 12_000,
    );
    if (!Array.isArray(value) || value.length > 100)
      throw new TelegramAPIError('Telegram вернул некорректный список сообщений');
    return value;
  }

  async send(chatId: string, reply: TelegramReply, signal: AbortSignal): Promise<void> {
    if (reply.chart) {
      const upload = new FormData();
      upload.set('chat_id', chatId);
      upload.set(
        'photo',
        new Blob([Uint8Array.from(reply.chart.photo)], { type: 'image/png' }),
        'meteo.png',
      );
      upload.set('caption', reply.chart.caption.slice(0, 1024));
      upload.set('reply_markup', JSON.stringify(reply.reply_markup));
      await this.call('sendPhoto', upload, signal);
      return;
    }
    await this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: reply.parse_mode ? reply.text : reply.text.slice(0, 4096),
        ...(reply.parse_mode && { parse_mode: reply.parse_mode }),
        reply_markup: reply.reply_markup,
        link_preview_options: { is_disabled: true },
      },
      signal,
    );
  }
}
