/** @file Заголовок выбранного дома и вкладки с учётом роли пользователя. */
import type { HomeView, HubView } from '../../../shared/api.js';
import type { CloudView } from '../app/types';
import { Icon } from '../icons';
import { roles } from '../lib/presentation';

interface HomeNavigationProps {
  home: HomeView;
  activeHub: HubView | undefined;
  owner: boolean;
  online: boolean;
  view: CloudView;
  setView: (view: CloudView) => void;
}

export function HomeNavigation({
  home,
  activeHub,
  owner,
  online,
  view,
  setView,
}: HomeNavigationProps) {
  return (
    <>
      <section class="home-heading">
        <div>
          <span class="eyebrow">{roles[home.role]} · Защищённый доступ</span>
          <h1>
            {home.name}
            <span>.</span>
          </h1>
          <p>
            {online
              ? 'Хаб на связи. Состояния подтверждаются локальными PLC.'
              : activeHub
                ? 'Нет свежей связи с хабом. Локальная автоматика продолжает работать.'
                : 'Привяжите локальный Linux-хаб, чтобы устройства появились в облаке.'}
          </p>
        </div>
        <span class={'connection-badge ' + (online ? 'online' : 'offline')}>
          <i />
          {online ? 'Дом на связи' : activeHub ? 'Хаб недоступен' : 'Хаб не привязан'}
        </span>
      </section>
      <nav class="home-tabs" aria-label="Разделы дома">
        <button
          data-cloud-nav="control"
          class={view === 'control' ? 'active' : ''}
          onClick={() => setView('control')}
        >
          <Icon name="home" />
          Управление
        </button>
        <button
          data-cloud-nav="connection"
          class={view === 'connection' ? 'active' : ''}
          onClick={() => setView('connection')}
        >
          <Icon name="hub" />
          Подключение
        </button>
        {owner ? (
          <button
            data-cloud-nav="access"
            class={view === 'access' ? 'active' : ''}
            onClick={() => setView('access')}
          >
            <Icon name="users" />
            Пользователи
          </button>
        ) : null}
        {owner ? (
          <button
            data-cloud-nav="firmware"
            class={view === 'firmware' ? 'active' : ''}
            onClick={() => setView('firmware')}
          >
            <Icon name="hub" />
            Прошивка PLC
          </button>
        ) : null}
        <button
          data-cloud-nav="history"
          class={view === 'history' ? 'active' : ''}
          onClick={() => setView('history')}
        >
          <Icon name="clock" />
          Журнал
        </button>
      </nav>
    </>
  );
}
