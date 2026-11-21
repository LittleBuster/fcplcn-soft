/** @file Именной список разрешённых чатов и черновик нового пользователя. */
import { Icon } from '../../icons';
import { date } from './model';
import type { TelegramSettings } from './use-telegram-settings';

/** Именной список разрешённых чатов и черновик нового пользователя. */
export function AccessCard({ settings }: { settings: TelegramSettings }) {
  const { chats, busy, view, setChats, changed, newId, newName, setNewId, setNewName, addChat } =
    settings;
  const last = view?.lastContact;
  return (
    <section class="panel telegram-card">
      <div class="telegram-section-title">
        <span class="telegram-card-icon">
          <Icon name="shield" />
        </span>
        <div>
          <h2>Разрешённые пользователи</h2>
          <p>Личные чаты людей, которым можно управлять домом.</p>
        </div>
        <span class="telegram-count">{chats.length} / 64</span>
      </div>
      <div class="telegram-chat-list">
        {chats.length ? (
          chats.map((chat, index) => {
            const observed = view?.config.chats.find((entry) => entry.chatId === chat.chatId);
            const contact = last?.chatId === chat.chatId ? last : null;
            const username = observed?.username || contact?.username;
            return (
              <div class="telegram-chat-row" key={chat.chatId} data-allowed-chat={chat.chatId}>
                <span class="telegram-person-avatar">
                  <Icon name="person" />
                </span>
                <div class="telegram-chat-fields">
                  <label class="telegram-label" for={`telegram-person-${index}`}>
                    Имя пользователя
                  </label>
                  <input
                    id={`telegram-person-${index}`}
                    aria-label={`Имя для ${chat.chatId}`}
                    value={chat.name}
                    maxLength={96}
                    disabled={busy}
                    placeholder="Имя появится после первого сообщения"
                    onInput={(event) => {
                      const name = event.currentTarget.value;
                      setChats((current) =>
                        current.map((entry) =>
                          entry.chatId === chat.chatId ? { ...entry, name } : entry,
                        ),
                      );
                      changed();
                    }}
                  />
                  <div class="telegram-chat-details">
                    <code>{chat.chatId}</code>
                    <span>{username ? `@${username}` : 'Без username'}</span>
                  </div>
                  <small>{date(observed?.lastSeenAt || contact?.receivedAt || null)}</small>
                </div>
                <button
                  class="icon-button telegram-remove-chat"
                  aria-label={`Удалить ${chat.name || chat.chatId}`}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setChats((current) => current.filter((entry) => entry.chatId !== chat.chatId));
                    changed();
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            );
          })
        ) : (
          <div class="telegram-empty-allowlist">
            <Icon name="shield" />
            <span>Доступ пока никому не разрешён.</span>
          </div>
        )}
      </div>
      <form
        class="telegram-add-person"
        onSubmit={(event) => {
          event.preventDefault();
          addChat();
        }}
      >
        <div>
          <label class="telegram-label" for="telegram-new-id">
            Chat ID
          </label>
          <input
            id="telegram-new-id"
            inputMode="numeric"
            autoComplete="off"
            value={newId}
            disabled={!view || busy}
            placeholder="Например, 123456789"
            onInput={(event) => setNewId(event.currentTarget.value)}
          />
        </div>
        <div>
          <label class="telegram-label" for="telegram-new-name">
            Имя
          </label>
          <input
            id="telegram-new-name"
            autoComplete="off"
            value={newName}
            disabled={!view || busy}
            placeholder="Как к нему обращаться"
            onInput={(event) => setNewName(event.currentTarget.value)}
          />
        </div>
        <button class="button secondary" type="submit" disabled={!view || busy}>
          <Icon name="person-add" />
          Добавить
        </button>
      </form>
    </section>
  );
}
