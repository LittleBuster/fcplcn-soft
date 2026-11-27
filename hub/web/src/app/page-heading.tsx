/** @file Заголовок текущего раздела и ручное обновление снимка хаба. */
import type { HubSnapshot, DeviceView } from '../../../shared/types.js';
import type { HubNavigation } from '../hooks/use-hub-navigation';
import { Icon } from '../icons';
import { deviceName } from '../model';
import { PultHeading } from './pult-heading';

interface PageHeadingProps {
  snapshot: HubSnapshot | null;
  selected?: DeviceView;
  navigation: HubNavigation;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/** Отражает выбранный PLC или раздел, не меняя навигацию при периодическом опросе. */
export function PageHeading({
  snapshot,
  selected,
  navigation,
  refreshing,
  refresh,
}: PageHeadingProps) {
  const { view, configuringId, setSelectedId, setConfiguringId } = navigation;
  if (view === 'pult')
    return (
      <PultHeading
        snapshot={snapshot}
        refreshing={refreshing}
        refresh={refresh}
        onBack={() => navigation.navigate('overview')}
      />
    );
  const title = configuringId
    ? 'Настройка PLC'
    : selected
      ? deviceName(selected)
      : view === 'activity'
        ? 'Журнал событий'
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
                  : 'Мой дом';
  const date = snapshot
    ? new Date(snapshot.now).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        weekday: 'long',
      })
    : '';

  return (
    <div class="page-heading">
      <div>
        {selected ? (
          <button
            class="back-link"
            onClick={() => {
              setSelectedId(null);
              setConfiguringId(null);
            }}
          >
            <Icon name="back" />
            Все контроллеры
          </button>
        ) : (
          <p class="eyebrow">{date || 'Локальная сеть'}</p>
        )}
        <h1>
          {title}
          <span class="heading-dot">.</span>
        </h1>
        <p>
          {configuringId
            ? 'Полная настройка PLC через локальный хаб.'
            : selected
              ? 'Состояния и управление устройствами этого PLC.'
              : view === 'activity'
                ? 'Команды, запуски сценариев и история связи с контроллерами.'
                : view === 'devices'
                  ? 'Все PLC вашего дома в одном месте.'
                  : view === 'scenes'
                    ? 'Мгновенные действия и запуск по выбранным дням и времени.'
                    : view === 'telegram'
                      ? 'Бот, доступ пользователей и управление домом в сообщениях.'
                      : view === 'cloud'
                        ? 'Связь с вашей облачной панелью FCPLCn.'
                        : view === 'account'
                          ? 'Логин и пароль для локального доступа к хабу.'
                          : 'Ваш дом на связи. Управляйте привычными вещами.'}
        </p>
      </div>
      {view !== 'telegram' && view !== 'cloud' && view !== 'account' ? (
        <button
          class={`button secondary refresh-button ${refreshing ? 'refreshing' : ''}`}
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <Icon name="refresh" />
          Обновить
        </button>
      ) : null}
    </div>
  );
}
