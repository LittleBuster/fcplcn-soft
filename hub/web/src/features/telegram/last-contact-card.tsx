/** @file Последний собеседник и явное добавление доступа. */
import { Icon } from '../../icons';
import { date } from './model';
import type { TelegramSettings } from './use-telegram-settings';

/** Последний собеседник и явное добавление доступа. */
export function LastContactCard({ settings }: { settings: TelegramSettings }) {
  const { busy, view, chats, addChat, setNotice, initialLoading } = settings;
  const last = view?.lastContact;
  return (
    <section class="panel telegram-card telegram-contact-card">
      <div class="telegram-section-title">
        <span class="telegram-card-icon green">
          <Icon name="person" />
        </span>
        <div>
          <h2>Последний написавший</h2>
          <p>
            Напишите боту <code>/start</code> — здесь появятся имя и Chat ID.
          </p>
        </div>
      </div>
      {last ? (
        <div class="telegram-last-contact">
          <span class="telegram-person-avatar">
            <Icon name="person" />
          </span>
          <div class="telegram-person-info">
            <strong>{last.name || 'Пользователь Telegram'}</strong>
            <span>{last.username ? `@${last.username}` : 'Без имени пользователя'}</span>
            <code data-last-chat-id>{last.chatId}</code>
            <small>{date(last.receivedAt)}</small>
          </div>
          <div class="telegram-contact-actions">
            <button
              class="icon-button"
              aria-label="Скопировать Chat ID"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(last.chatId);
                  setNotice({ kind: 'success', text: 'Chat ID скопирован.' });
                } catch {
                  setNotice({
                    kind: 'warning',
                    text: 'Скопируйте Chat ID из карточки вручную.',
                  });
                }
              }}
            >
              <Icon name="copy" />
            </button>
            <button
              class="button secondary"
              type="button"
              disabled={busy || !view || chats.some((entry) => entry.chatId === last.chatId)}
              onClick={() => addChat(last.chatId, last.name)}
            >
              <Icon name="person-add" />
              {chats.some((entry) => entry.chatId === last.chatId)
                ? 'Уже в списке'
                : 'Разрешить доступ'}
            </button>
          </div>
        </div>
      ) : (
        <div class="telegram-contact-empty">
          <Icon name="chat" />
          <span>
            {initialLoading ? 'Загружаем данные…' : 'Здесь пока никого нет'}
            <small>После подключения бота новое сообщение появится автоматически.</small>
          </span>
        </div>
      )}
      <p class="telegram-hint">
        Новый собеседник не получает доступ автоматически. Добавьте его и сохраните настройки.
      </p>
    </section>
  );
}
