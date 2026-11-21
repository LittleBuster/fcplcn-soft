/** @file Три быстрых сценария на главной странице хаба. */

import type { ScenesSnapshot } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { canConfigure } from '../../portal';
import { scenes } from './labels';
import type { ScenesPanelModel } from './use-scenes-panel';

interface QuickScenesProps extends Pick<
  ScenesPanelModel,
  'starting' | 'blocked' | 'allowed' | 'run' | 'edit' | 'busy' | 'storageError'
> {
  snapshot: ScenesSnapshot;
}

/** Отображает встроенные карточки без отдельного состояния и повторного запуска команд. */
export function QuickScenes({
  snapshot,
  starting,
  blocked,
  allowed,
  run,
  edit,
  busy,
  storageError,
}: QuickScenesProps) {
  return (
    <>
      <div class="section-heading">
        <h2 id="scenes-title">
          <Icon name="home" />
          Сценарии дома
        </h2>
        <span class="section-meta">Одно нажатие — несколько действий</span>
      </div>
      <div class="scene-cards">
        {scenes.map((scene) => {
          const definition = snapshot.definitions.find((entry) => entry.id === scene.id);
          const running = starting === scene.id || snapshot.activeRun?.sceneId === scene.id;
          return (
            <article
              class={`scene-card scene-${scene.id} ${running ? 'scene-running' : ''}`}
              key={scene.id}
              data-scene-id={scene.id}
            >
              <button
                class="scene-run-button"
                data-scene-run={scene.id}
                onClick={() => void run(scene.id)}
                disabled={blocked || !definition || !allowed(scene.id)}
                aria-busy={running}
              >
                <span class="scene-art">
                  <Icon name={scene.icon} />
                </span>
                <span class="scene-card-copy">
                  <strong>{scene.name}</strong>
                  <span>{scene.caption}</span>
                  <span class="scene-start-label">
                    {running ? 'Выполняем…' : 'Запустить сценарий'}
                    <Icon name={running ? 'refresh' : 'arrow'} />
                  </span>
                </span>
              </button>
              <button
                class="scene-settings-button"
                hidden={!canConfigure}
                data-scene-settings={scene.id}
                onClick={() => definition && edit(definition)}
                disabled={busy || !definition || Boolean(storageError)}
                aria-label={`Настроить сценарий ${scene.name}`}
                title={`Настроить ${scene.name}`}
              >
                <Icon name="settings" />
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
