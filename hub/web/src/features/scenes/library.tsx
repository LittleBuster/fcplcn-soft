/** @file Библиотека мгновенных сценариев, расписаний и журнал планировщика. */

import type { ScenesSnapshot } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { canConfigure } from '../../portal';
import { scenes, readableError } from './labels';
import type { ScenesPanelModel } from './use-scenes-panel';

interface SceneLibraryProps extends Pick<
  ScenesPanelModel,
  | 'group'
  | 'setGroup'
  | 'create'
  | 'busy'
  | 'storageError'
  | 'grouped'
  | 'edit'
  | 'blocked'
  | 'allowed'
  | 'run'
> {
  snapshot: ScenesSnapshot;
}

/** Разделяет способы запуска, сохраняя ручной запуск запланированных сценариев. */
export function SceneLibrary({
  snapshot,
  group,
  setGroup,
  create,
  busy,
  storageError,
  grouped,
  edit,
  blocked,
  allowed,
  run,
}: SceneLibraryProps) {
  return (
    <section class="scene-library" aria-labelledby="scene-library-title">
      <div class="section-heading">
        <h2 id="scene-library-title">
          <Icon name="settings" />
          Все сценарии
        </h2>
        <button
          class="button small"
          data-scene-create
          hidden={!canConfigure}
          onClick={create}
          disabled={busy || Boolean(storageError) || snapshot.definitions.length >= 32}
        >
          <span>+</span>Создать сценарий
        </button>
      </div>
      <nav class="scene-group-tabs" aria-label="Виды сценариев">
        <button
          class={group === 'instant' ? 'active' : ''}
          data-scenes-group="instant"
          onClick={() => setGroup('instant')}
        >
          <Icon name="power" />
          Мгновенные
          <span>{snapshot.definitions.filter((entry) => !entry.schedule?.enabled).length}</span>
        </button>
        <button
          class={group === 'scheduled' ? 'active' : ''}
          data-scenes-group="scheduled"
          onClick={() => setGroup('scheduled')}
        >
          <Icon name="clock" />
          По расписанию
          <span>{snapshot.definitions.filter((entry) => entry.schedule?.enabled).length}</span>
        </button>
      </nav>
      <p class="scene-library-hint">
        {group === 'instant'
          ? 'Запускаются только по нажатию кнопки.'
          : 'Запускаются хабом в выбранные дни и время. Любой из них можно выполнить прямо сейчас.'}
      </p>
      <div class="scene-library-grid">
        {grouped.map((definition) => {
          const builtin = scenes.some((scene) => scene.id === definition.id);
          return (
            <article
              class="scene-library-card panel"
              key={definition.id}
              data-scene-definition-id={definition.id}
              data-scene-id={builtin ? undefined : definition.id}
            >
              <div class="scene-library-card-heading">
                <span class="scene-library-icon">
                  <Icon name={definition.schedule?.enabled ? 'clock' : 'activity'} />
                </span>
                <div>
                  <h3>{definition.name}</h3>
                  <span>
                    {builtin ? 'Сценарий дома' : 'Свой сценарий'} · {definition.actions.length}{' '}
                    дополнительных действий
                  </span>
                </div>
                <button
                  class="scene-settings-button"
                  hidden={!canConfigure}
                  data-scene-settings={definition.id}
                  data-scene-settings-again={builtin ? definition.id : undefined}
                  onClick={() => edit(definition)}
                  disabled={busy || Boolean(storageError)}
                  aria-label={`Настроить сценарий ${definition.name}`}
                >
                  <Icon name="settings" />
                </button>
              </div>
              {definition.description ? <p>{definition.description}</p> : null}
              {definition.schedule?.enabled ? (
                <div class="scene-schedule-caption">
                  <Icon name="clock" />
                  <div>
                    <strong>
                      {definition.schedule.days
                        .map((day) => ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][day - 1])
                        .join(', ')}{' '}
                      · {definition.schedule.time}
                    </strong>
                    <span>{definition.schedule.timeZone}</span>
                  </div>
                </div>
              ) : null}
              <button
                class="button secondary small"
                data-scene-run={definition.id}
                data-scene-run-again={builtin ? definition.id : undefined}
                disabled={blocked || !allowed(definition.id)}
                onClick={() => void run(definition.id)}
              >
                <Icon name="power" />
                Запустить сейчас
              </button>
            </article>
          );
        })}
      </div>
      {!grouped.length ? (
        <div class="scene-empty-actions">
          <Icon name={group === 'scheduled' ? 'clock' : 'activity'} />
          <p>
            {group === 'scheduled'
              ? 'Сценариев по расписанию пока нет. Создайте сценарий и выберите дни и время.'
              : 'Мгновенных сценариев пока нет.'}
          </p>
        </div>
      ) : null}
      {snapshot.scheduler?.error ? (
        <div class="notice error" role="alert">
          {readableError(snapshot.scheduler.error)}
        </div>
      ) : null}
      {snapshot.scheduler?.events.length ? (
        <details class="scene-history">
          <summary>Журнал расписаний</summary>
          {snapshot.scheduler.events.slice(0, 10).map((event, index) => (
            <div class="scene-schedule-event" key={`${event.sceneId}/${event.dueAt}/${index}`}>
              <strong>{event.name}</strong>
              <span>
                {event.status === 'started'
                  ? 'Запущен'
                  : event.status === 'skipped'
                    ? 'Пропущен'
                    : 'Ошибка'}{' '}
                · {new Date(event.dueAt).toLocaleString('ru-RU')}
              </span>
              {event.reason ? <p>{readableError(event.reason)}</p> : null}
            </div>
          ))}
        </details>
      ) : null}
      <p class="scene-library-hint">
        Пропущенные запуски не догоняются после включения хаба. Доступность каждого PLC проверяется
        перед отправкой действия.
      </p>
    </section>
  );
}
