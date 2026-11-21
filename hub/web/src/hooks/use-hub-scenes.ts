/** @file Применение подтверждённых изменений сценариев к текущему снимку хаба. */
import type { SceneRun, SceneDefinition } from '../../../shared/types.js';
import type { HubSnapshotState } from './use-hub-snapshot';

/** Отделяет локальное подтверждение сценария от более старого ответа периодического опроса. */
export function useHubScenes(data: HubSnapshotState) {
  const { setSnapshot, sceneVersion, refresh } = data;

  /** Сразу показывает принятый запуск, не дожидаясь следующего опроса. */
  function acceptSceneRun(run: SceneRun) {
    sceneVersion.current++;
    setSnapshot((current) =>
      current
        ? {
            ...current,
            scenes: {
              ...current.scenes,
              activeRun: run.status === 'running' ? run : null,
              runs: [run, ...current.scenes.runs.filter((entry) => entry.id !== run.id)].slice(
                0,
                20,
              ),
            },
          }
        : current,
    );
    void refresh();
  }

  /** Применяет подтверждённую редакцию сценария. */
  function acceptSceneDefinition(definition: SceneDefinition) {
    sceneVersion.current++;
    setSnapshot((current) =>
      current
        ? {
            ...current,
            scenes: {
              ...current.scenes,
              definitions: current.scenes.definitions.some((entry) => entry.id === definition.id)
                ? current.scenes.definitions.map((entry) =>
                    entry.id === definition.id ? definition : entry,
                  )
                : [...current.scenes.definitions, definition],
            },
          }
        : current,
    );
    void refresh();
  }

  /** Удаляет подтверждённый сценарий из текущей библиотеки. */
  function deleteSceneDefinition(id: string) {
    sceneVersion.current++;
    setSnapshot((current) =>
      current
        ? {
            ...current,
            scenes: {
              ...current.scenes,
              definitions: current.scenes.definitions.filter((entry) => entry.id !== id),
            },
          }
        : current,
    );
    void refresh();
  }

  return { acceptSceneRun, acceptSceneDefinition, deleteSceneDefinition };
}
