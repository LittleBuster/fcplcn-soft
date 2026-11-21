/** @file Верхняя панель: переход между домами, профиль и выход из облака. */
import type { CloudSession, HomeView } from '../../../shared/api.js';
import type { CloudView } from '../app/types';
import { Icon } from '../icons';

interface CloudTopbarProps {
  session: CloudSession;
  homes: HomeView[];
  selected: string;
  view: CloudView;
  setView: (view: CloudView) => void;
  onSelectHome: (id: string) => void;
  onCreateHome: () => void;
  onLogout: () => Promise<void>;
}

export function CloudTopbar({
  session,
  homes,
  selected,
  view,
  setView,
  onSelectHome,
  onCreateHome,
  onLogout,
}: CloudTopbarProps) {
  return (
    <header class="cloud-topbar">
      <a
        class="brand"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          setView('control');
        }}
      >
        <span class="brand-symbol">
          <Icon name="home" />
        </span>
        <span>
          <strong>{session.product.name}</strong>
          <small>Ваш дом в облаке</small>
        </span>
      </a>
      <div class="home-select">
        <Icon name="home" />
        <label class="sr-only" for="selected-home">
          Выбрать дом
        </label>
        <select
          id="selected-home"
          value={selected}
          onChange={(event) => onSelectHome(event.currentTarget.value)}
        >
          {homes.length ? (
            homes.map((entry) => (
              <option value={entry.id} key={entry.id}>
                {entry.name}
              </option>
            ))
          ) : (
            <option value="">Нет домов</option>
          )}
        </select>
        <button class="icon-button" aria-label="Добавить дом" onClick={onCreateHome}>
          <Icon name="plus" />
        </button>
      </div>
      <div class="account-actions">
        <button
          class={view === 'account' ? 'account-button active' : 'account-button'}
          onClick={() => setView('account')}
        >
          <span class="avatar">{session.user?.name.slice(0, 1).toLocaleUpperCase('ru')}</span>
          <span>{session.user?.name}</span>
        </button>
        <button class="icon-button" aria-label="Выйти из облака" onClick={onLogout}>
          <Icon name="logout" />
        </button>
      </div>
    </header>
  );
}
