/** @file Страница Telegram: подключение, доступ, состояние и пример меню. */
import type { HubSnapshot } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { useTelegramSettings } from './use-telegram-settings';
import { MenuPreview } from './menu-preview';
import { ConnectionCard } from './connection-card';
import { LastContactCard } from './last-contact-card';
import { AccessCard } from './access-card';
import '../../telegram.css';

/** Соединяет формы и живые статусы; состояние черновика принадлежит общему хуку страницы. */
export function TelegramPanel({ snapshot }: { snapshot: HubSnapshot | null }) {
  const settings = useTelegramSettings();
  const {
    view,
    revision,
    loadError,
    notice,
    setNotice,
    conflict,
    dirty,
    busy,
    initialLoading,
    load,
    save,
  } = settings;
  const state = view?.status.state || 'disabled';
  const stateText = {
    disabled: 'Бот выключен',
    connecting: 'Подключается',
    running: 'На связи',
    error: 'Нет связи',
  }[state];
  const knownRevisionChanged = dirty && Boolean(view && view.config.revision !== revision);

  return (
    <section class="telegram-page" data-telegram-settings>
      <div class="telegram-intro panel">
        <div class="telegram-orbit">
          <Icon name="telegram" />
          <span>
            <Icon name="home" />
          </span>
        </div>
        <div>
          <p class="eyebrow">Дом в сообщениях</p>
          <h2>Управление через Telegram</h2>
          <p>
            Сценарии, устройства и их состояния — в одном боте. Доступ получают только добавленные
            вами люди.
          </p>
        </div>
        <span class={`telegram-state state-${state}`}>
          <span class="status-dot" />
          {stateText}
        </span>
      </div>
      {loadError ? (
        <div class="notice error" role="alert">
          <Icon name="link" />
          <span>{loadError}</span>
        </div>
      ) : null}
      {notice ? (
        <div class={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={notice.kind === 'error' ? 'alarm' : 'check'} />
          <span>{notice.text}</span>
          <button
            class="notice-dismiss"
            type="button"
            aria-label="Закрыть уведомление Telegram"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}
      {conflict || knownRevisionChanged ? (
        <div class="notice warning" role="status">
          <Icon name="refresh" />
          <span>
            Настройки изменились в другом окне. Загрузите сохранённую версию перед новой правкой.
          </span>
          <button
            class="button secondary"
            type="button"
            disabled={busy}
            onClick={() => void load(true)}
          >
            Загрузить настройки
          </button>
        </div>
      ) : null}
      <div class="telegram-layout">
        <div class="telegram-forms">
          <ConnectionCard settings={settings} />
          <LastContactCard settings={settings} />
          <AccessCard settings={settings} />
          <div class="telegram-save-bar">
            <span>{dirty ? 'Есть несохранённые изменения' : 'Настройки хранятся на хабе'}</span>
            <button
              class="button secondary"
              type="button"
              disabled={busy || initialLoading}
              onClick={() => void load(true)}
            >
              <Icon name="refresh" />
              Загрузить настройки
            </button>
            <button
              class="button"
              type="button"
              disabled={!view || busy || !dirty || conflict || knownRevisionChanged}
              onClick={() => void save()}
            >
              <Icon name="check" />
              {busy ? 'Сохраняем…' : 'Сохранить Telegram'}
            </button>
          </div>
        </div>
        <MenuPreview snapshot={snapshot} />
      </div>
    </section>
  );
}
