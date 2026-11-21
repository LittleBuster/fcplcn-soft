/** @file Telegram configuration contracts; the bot token stays exclusively on the hub. */

export interface TelegramAllowedChat {
  chatId: string;
  /** Administrator label, or the last observed Telegram display name. */
  name: string;
  /** Telegram username without @, empty until this person contacts the bot. */
  username: string;
  lastSeenAt: string | null;
}

export interface TelegramContact {
  chatId: string;
  name: string;
  username: string;
  receivedAt: string;
}

export interface TelegramPublicConfig {
  revision: number;
  enabled: boolean;
  tokenConfigured: boolean;
  chats: TelegramAllowedChat[];
}

export interface TelegramConfigPatch {
  baseRevision: number;
  enabled: boolean;
  /** Omit to retain the token; null deliberately removes it. */
  token?: string | null;
  chats: { chatId: string; name: string }[];
}

export interface TelegramRuntimeStatus {
  state: 'disabled' | 'connecting' | 'running' | 'error';
  botUsername: string;
  botName: string;
  lastPollAt: string | null;
  error: string | null;
}

export interface TelegramStoreView {
  config: TelegramPublicConfig;
  lastContact: TelegramContact | null;
}

export interface TelegramView extends TelegramStoreView {
  status: TelegramRuntimeStatus;
}
