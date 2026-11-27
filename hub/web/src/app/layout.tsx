/** @file Постоянная оболочка панели: меню, верхняя строка и подпись состояния. */
import type { ComponentChildren } from 'preact';
import type { SessionView, HubSnapshot, DeviceView } from '../../../shared/types.js';
import type { View } from './types';
import { Icon } from '../icons';
import { time } from '../model';
import { canConfigure, portal } from '../portal';
import './pult-layout.css';

interface HubLayoutProps {
  session: SessionView;
  snapshot: HubSnapshot | null;
  view: View;
  selected?: DeviceView;
  brokerConnected: boolean;
  navigate: (view: View) => void;
  logout: () => Promise<void>;
  children: ComponentChildren;
}

/** Не пересоздаёт рабочее пространство и вложенный редактор при опросе состояний. */
export function HubLayout({
  session,
  snapshot,
  view,
  selected,
  brokerConnected,
  navigate,
  logout,
  children,
}: HubLayoutProps) {
  const devices = snapshot?.devices || [];
  return (
    <div
      class={`app-shell${portal ? ' cloud-portal-shell' : ''}${view === 'pult' ? ' pult-shell' : ''}`}
    >
      <aside class="sidebar">
        <a
          class="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate('overview');
          }}
        >
          <span class="brand-symbol">
            <Icon name="home" />
          </span>
          <span>
            <strong>{session.product.name}</strong>
            <small>Хаб умного дома</small>
          </span>
        </a>
        <div class="sidebar-divider" />
        <p class="nav-label">Управление домом</p>
        <nav aria-label="Главное меню">
          <button
            class={view === 'pult' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('pult')}
            data-nav="pult"
          >
            <Icon name="tablet" />
            Пульт
          </button>
          <button
            class={view === 'overview' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('overview')}
            data-nav="overview"
          >
            <Icon name="home" />
            Обзор
          </button>
          <button
            class={view === 'devices' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('devices')}
            data-nav="devices"
          >
            <Icon name="plc" />
            Контроллеры<span>{devices.length}</span>
          </button>
          <button
            class={view === 'scenes' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('scenes')}
            data-nav="scenes"
          >
            <Icon name="prepare" />
            Сценарии
          </button>
          <button
            class={view === 'activity' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('activity')}
            data-nav="activity"
          >
            <Icon name="activity" />
            Журнал событий
          </button>
          <button
            class={view === 'telegram' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('telegram')}
            data-nav="telegram"
            hidden={!canConfigure}
          >
            <Icon name="telegram" />
            Telegram
          </button>
          {!portal ? (
            <>
              <button
                class={view === 'cloud' ? 'nav-item active' : 'nav-item'}
                onClick={() => navigate('cloud')}
                data-nav="cloud"
              >
                <Icon name="cloud" />
                Облако
              </button>
              <button
                class={view === 'account' ? 'nav-item active' : 'nav-item'}
                onClick={() => navigate('account')}
                data-nav="account"
              >
                <Icon name="person" />
                Учётная запись
              </button>
            </>
          ) : null}
        </nav>
        <div class="sidebar-bottom">
          <div class="network-orbit">
            <Icon name="link" />
            <i />
            <i />
            <i />
          </div>
          <strong>Всё рядом. Всё под контролем.</strong>
          <p>
            Локальное управление.
            <br />
            Автономная работа каждого PLC.
          </p>
          <span class="local-label">
            <span class="status-dot" />
            Локальная сеть
          </span>
        </div>
        <div class="sidebar-product">{session.product.fullName}</div>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <div class="breadcrumb">
            <Icon name="home" />
            <span>Хаб</span>
            <span class="breadcrumb-slash">/</span>
            <strong>
              {view === 'pult'
                ? 'Пульт'
                : selected
                  ? 'Контроллер'
                  : view === 'activity'
                    ? 'Журнал'
                    : view === 'devices'
                      ? 'Контроллеры'
                      : view === 'scenes'
                        ? 'Сценарии'
                        : view === 'telegram'
                          ? 'Telegram'
                          : view === 'cloud'
                            ? 'Облако'
                            : view === 'account'
                              ? 'Учётная запись'
                              : 'Обзор'}
            </strong>
          </div>
          <div class="topbar-right">
            <span class={`broker-indicator ${brokerConnected ? 'connected' : 'disconnected'}`}>
              <span class="status-dot" />
              {session.mode === 'demo'
                ? 'Демо-сеть'
                : brokerConnected
                  ? 'MQTT подключён'
                  : 'MQTT недоступен'}
            </span>
            {session.requiresLogin && !portal ? (
              <button
                class="icon-button"
                aria-label="Выйти"
                title="Выйти"
                onClick={() => void logout()}
              >
                <Icon name="logout" />
              </button>
            ) : (
              <span class="local-avatar" title="Локальный доступ">
                <Icon name="shield" />
              </span>
            )}
          </div>
        </header>
        <main class="main-content">
          {session.mode === 'demo' ? (
            <div class="demo-banner">
              <span class="demo-label">ДЕМО</span>
              <p>
                Виртуальный дом — можно переключать устройства. Реальное оборудование не
                затрагивается.
              </p>
              <Icon name="plc" />
            </div>
          ) : null}
          {children}
          <footer class="page-footer">
            <span>{session.product.name} · Локальный хаб</span>
            <span>
              <span class="status-dot" />
              {snapshot ? `Обновлено в ${time(snapshot.now)}` : 'Подключение…'}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
