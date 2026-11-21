/** @file Сборка быстрых сценариев, библиотеки, результата и редактора. */

import type { ScenesPanelProps } from './types';
import { useScenesPanel } from './use-scenes-panel';
import { QuickScenes } from './quick-scenes';
import { SceneLibrary } from './library';
import { SceneHistory } from './history';
import { RunResult } from './run-result';
import { SceneEditor } from './editor';
import { readableError } from './labels';

/** Панель соединяет представления с подтверждённым снимком и состоянием локального черновика. */
export function ScenesPanel(props: ScenesPanelProps) {
  const { snapshot, devices, onSaved, onDeleted, expanded = false, showQuick = true } = props;
  const {
    starting,
    editing,
    setEditing,
    error,
    setError,
    group,
    setGroup,
    current,
    visibleRunId,
    setVisibleRunId,
    setNoticeDetailsOpen,
    mounted,
    storageError,
    busy,
    blocked,
    allowed,
    run,
    edit,
    create,
    grouped,
  } = useScenesPanel(props);
  return (
    <section
      class="scenes-panel"
      aria-labelledby={showQuick ? 'scenes-title' : 'scene-library-title'}
    >
      {showQuick ? (
        <QuickScenes
          snapshot={snapshot}
          starting={starting}
          blocked={blocked}
          allowed={allowed}
          run={run}
          edit={edit}
          busy={busy}
          storageError={storageError}
        />
      ) : null}
      {expanded ? (
        <SceneLibrary
          snapshot={snapshot}
          group={group}
          setGroup={setGroup}
          create={create}
          busy={busy}
          storageError={storageError}
          grouped={grouped}
          edit={edit}
          blocked={blocked}
          allowed={allowed}
          run={run}
        />
      ) : null}
      {storageError ? (
        <div class="notice error" role="alert">
          {readableError(storageError)}
        </div>
      ) : null}
      {error ? (
        <div class="notice error" role="alert">
          {error}
          <button
            type="button"
            class="notice-dismiss"
            aria-label="Закрыть ошибку сценария"
            onClick={() => setError('')}
          >
            ×
          </button>
        </div>
      ) : null}
      {current && current.id === visibleRunId ? (
        <div
          data-scene-current
          role={
            current.status === 'failed' || current.status === 'interrupted' ? 'alert' : 'status'
          }
        >
          <RunResult
            key={current.id}
            run={current}
            collapsible
            onDismiss={() => setVisibleRunId(null)}
            onDetailsChange={setNoticeDetailsOpen}
          />
        </div>
      ) : !snapshot.runs.length ? (
        <p class="scene-first-hint">
          «Я дома» снимает охрану, «Ушел» ставит на охрану. Дополнительные действия можно настроить
          у каждой кнопки.
        </p>
      ) : null}
      {expanded && snapshot.runs.length ? <SceneHistory runs={snapshot.runs} /> : null}
      {editing ? (
        <SceneEditor
          key={editing.id}
          definition={editing}
          devices={devices}
          latestRevision={
            snapshot.definitions.find((entry) => entry.id === editing.id)?.revision ||
            editing.revision
          }
          disabled={busy || Boolean(storageError)}
          onClose={() => setEditing(null)}
          onSaved={(definition) => {
            if (!mounted.current) return;
            onSaved(definition);
            setGroup(definition.schedule?.enabled ? 'scheduled' : 'instant');
            setEditing(null);
          }}
          onDeleted={(id) => {
            if (!mounted.current) return;
            onDeleted(id);
            setEditing(null);
          }}
        />
      ) : null}
    </section>
  );
}
