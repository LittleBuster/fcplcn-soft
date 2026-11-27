/** @file Диалог редактирования сценария: поля, действия, расписание и подтверждение сохранения. */

import type { SceneEditorProps } from './types';
import { useSceneEditor } from './use-scene-editor';
import { EditorOverview } from './editor-overview';
import { EditorActions } from './editor-actions';
import { EditorSchedule } from './editor-schedule';

/** Собирает представления вокруг одного черновика; закрытие не пересоздаёт форму при опросе. */
export function SceneEditor(props: SceneEditorProps) {
  const { definition, devices, latestRevision, disabled, onClose } = props;
  const {
    dialog,
    isNew,
    builtin,
    actions,
    setActions,
    name,
    setName,
    description,
    setDescription,
    schedule,
    setSchedule,
    saving,
    error,
    actionKinds,
    selectable,
    targets,
    defaultTarget,
    change,
    reorder,
    save,
    remove,
  } = useSceneEditor(props);
  return (
    <dialog
      ref={dialog}
      class="scene-editor"
      data-scene-editor={definition.id || 'new'}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      aria-labelledby="scene-editor-title"
    >
      <form onSubmit={save}>
        <EditorOverview
          definition={definition}
          latestRevision={latestRevision}
          disabled={disabled}
          onClose={onClose}
          isNew={isNew}
          builtin={builtin}
          actions={actions}
          name={name}
          setName={setName}
          description={description}
          setDescription={setDescription}
          saving={saving}
        />
        <EditorActions
          definition={definition}
          devices={devices}
          disabled={disabled}
          actions={actions}
          setActions={setActions}
          saving={saving}
          actionKinds={actionKinds}
          selectable={selectable}
          targets={targets}
          defaultTarget={defaultTarget}
          change={change}
          reorder={reorder}
        />
        <EditorSchedule
          disabled={disabled}
          paused={Boolean(definition.schedule?.paused)}
          schedule={schedule}
          setSchedule={setSchedule}
          saving={saving}
        />
        {error ? (
          <div class="notice error" role="alert">
            {error}
          </div>
        ) : null}
        <div class="scene-editor-footer">
          {!builtin && !isNew ? (
            <button
              type="button"
              class="text-button scene-delete-button"
              data-scene-delete
              onClick={() => void remove()}
              disabled={disabled || saving}
            >
              Удалить сценарий
            </button>
          ) : null}
          <button type="button" class="button secondary" onClick={onClose} disabled={saving}>
            Отмена
          </button>
          <button type="submit" class="button" data-scene-save disabled={disabled || saving}>
            {saving ? 'Сохраняем…' : 'Сохранить сценарий'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
