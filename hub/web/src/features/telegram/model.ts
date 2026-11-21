/** @file Типы черновика и проверка полей Telegram. */
import type { TelegramAllowedChat } from '../../../../shared/telegram.js';

export type ChatDraft = Pick<TelegramAllowedChat, 'chatId' | 'name'>;

/** Проверяет положительный Chat ID личного чата в допустимом диапазоне Telegram. */
export const chatIdValid = (value: string) =>
  /^[1-9]\d{0,15}$/.test(value) && BigInt(value) <= (1n << 52n) - 1n;

/** Форматирует время последнего сообщения или подпись для нового собеседника. */
export const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    : 'Ещё не писал';
