/** @file Подключение бота и работа с секретным токеном. */
import { Icon } from '../../icons';
import { date } from './model';
import type { TelegramSettings } from './use-telegram-settings';

/** Подключение бота и работа с секретным токеном. */
export function ConnectionCard({ settings }: { settings: TelegramSettings }) {
  const {
    view,
    busy,
    enabled,
    setEnabled,
    changed,
    token,
    setToken,
    removeToken,
    setRemoveToken,
    testing,
    dirty,
    testConnection,
  } = settings;
  return (
    <section class="panel telegram-card">
      <div class="telegram-section-title">
        <span class="telegram-card-icon">
          <Icon name="telegram" />
        </span>
        <div>
          <h2>Подключение бота</h2>
          <p>
            Создайте бота в{' '}
            <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
              @BotFather
            </a>{' '}
            и вставьте его токен.
          </p>
        </div>
      </div>
      <label class="telegram-switch-row">
        <span>
          <strong>Включить Telegram</strong>
          <small>Бот работает на хабе и управляет PLC через локальную сеть.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Включить Telegram"
          checked={enabled}
          disabled={!view || busy}
          onChange={(event) => {
            setEnabled(event.currentTarget.checked);
            changed();
          }}
        />
      </label>
      <label class="telegram-label" for="telegram-token">
        Токен бота (Bot API)
      </label>
      <input
        id="telegram-token"
        type="password"
        autoComplete="new-password"
        spellcheck={false}
        value={token}
        disabled={!view || busy}
        placeholder={
          view?.config.tokenConfigured && !removeToken
            ? 'Токен сохранён · оставьте поле пустым'
            : '123456789:AA…'
        }
        onInput={(event) => {
          setToken(event.currentTarget.value);
          setRemoveToken(false);
          changed();
        }}
      />
      <div class="telegram-token-meta">
        <span>
          {removeToken
            ? 'Токен будет удалён при сохранении'
            : view?.config.tokenConfigured
              ? 'Токен сохранён и скрыт'
              : 'Токен пока не задан'}
        </span>
        {view?.config.tokenConfigured && !removeToken ? (
          <button
            class="telegram-text-danger"
            type="button"
            disabled={busy}
            onClick={() => {
              setRemoveToken(true);
              setToken('');
              setEnabled(false);
              changed();
            }}
          >
            Удалить токен
          </button>
        ) : null}
      </div>
      {view?.status.botUsername ? (
        <a
          class="telegram-bot-link"
          href={`https://t.me/${encodeURIComponent(view.status.botUsername)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="telegram" />@{view.status.botUsername}
          <Icon name="arrow" />
        </a>
      ) : null}
      {view?.status.error ? (
        <p class="telegram-runtime-error" role="status">
          {view.status.error}
        </p>
      ) : null}
      <div class="telegram-connection-bottom">
        <span>Последняя связь: {date(view?.status.lastPollAt || null)}</span>
        <button
          class="button secondary"
          type="button"
          disabled={busy || testing || dirty || !view?.config.tokenConfigured}
          onClick={() => void testConnection()}
        >
          <Icon name="link" />
          {testing ? 'Проверяем…' : 'Проверить соединение'}
        </button>
      </div>
    </section>
  );
}
