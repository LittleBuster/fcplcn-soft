/** @file Применение подтверждённых изменений сценариев к текущему снимку хаба. */
import { useRef } from 'preact/hooks';
import { api, jsonBody } from '../api';
import type { HubSession } from './use-hub-session';
import type { SceneRun, SceneDefinition } from '../../../shared/types.js';
import type { HubSnapshotState } from './use-hub-snapshot';

/** Отделяет локальное подтверждение сценария от более старого ответа периодического опроса. */
export function useHubScenes(
  data: HubSnapshotState,
  { sessionVersion }: HubSession,
  onStarting: (starting: boolean) => void,
) {
  const runVersion = useRef<number | null>(null);
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

  /** Блокировка действует до ответа хаба, в том числе после перехода на другую вкладку. */
  async function runScene(id: string) {
    const version = sessionVersion.current;
    if (runVersion.current === version) return;
    runVersion.current = version;
    onStarting(true);
    try {
      const run = await api<SceneRun>(`/scenes/${encodeURIComponent(id)}/run`, {
        method: 'POST',
        ...jsonBody({}),
      });
      if (sessionVersion.current === version) acceptSceneRun(run);
    } finally {
      if (runVersion.current === version) runVersion.current = null;
      if (sessionVersion.current === version) onStarting(false);
    }
  }

  async function setScheduleEnabled(scene: SceneDefinition, enabled: boolean) {
    const version = sessionVersion.current;
    try {
      const confirmed = await api<SceneDefinition>(
        `/scenes/${encodeURIComponent(scene.id)}/schedule`,
        {
          method: 'PUT',
          ...jsonBody({ baseRevision: scene.revision, enabled }),
        },
      );
      if (sessionVersion.current === version) acceptSceneDefinition(confirmed);
    } catch (error) {
      if (sessionVersion.current === version) void refresh();
      throw error;
    }
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

  return { runScene, setScheduleEnabled, acceptSceneDefinition, deleteSceneDefinition };
}
