/** @file Локальный черновик сценария, выбор целей и сохранение с проверкой ревизии. */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { SceneAction, SceneDefinition, SceneSchedule } from '../../../../shared/types.js';
import { api, jsonBody } from '../../api';
import { createEditorTargets } from './editor-targets';
import { builtinIds, standardKinds } from './editor-options';
import type { SceneEditorProps } from './types';

/** Удерживает исходную ревизию и поля формы до явного успешного сохранения. */
export function useSceneEditor({
  definition,
  devices,
  disabled,
  onSaved,
  onDeleted,
}: Pick<SceneEditorProps, 'definition' | 'devices' | 'disabled' | 'onSaved' | 'onDeleted'>) {
  const dialog = useRef<HTMLDialogElement>(null);

  const isNew = !definition.id;

  const builtin = builtinIds.includes(definition.id);

  // Все поля редактируются локально до подтверждённого сохранения исходной ревизии.
  const [actions, setActions] = useState<SceneAction[]>(() =>
    definition.actions.map((action) => ({ ...action })),
  );

  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description);
  const [schedule, setSchedule] = useState<SceneSchedule>(() => ({
    enabled: definition.schedule?.enabled ?? false,
    days: [...(definition.schedule?.days || [1, 2, 3, 4, 5])],
    time: definition.schedule?.time || '08:00',
    timeZone: definition.schedule?.timeZone || 'Asia/Novosibirsk',
  }));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const actionKinds: SceneAction['controller'][] =
    definition.id === 'home' || definition.id === 'away'
      ? standardKinds
      : [...standardKinds, 'security'];

  const { selectable, targets, defaultTarget } = createEditorTargets(devices, actionKinds);

  /** Обновляет только выбранную строку черновика действий. */
  function change(id: string, patch: Partial<SceneAction>) {
    setActions((values) =>
      values.map((action) => (action.id === id ? { ...action, ...patch } : action)),
    );
  }

  /** Перемещает действие внутри черновика, не выходя за границы списка. */
  function reorder(index: number, direction: number) {
    setActions((values) => {
      const result = [...values];
      const target = index + direction;
      if (target < 0 || target >= result.length) return values;
      [result[index], result[target]] = [result[target], result[index]];
      return result;
    });
  }

  /** Отправляет действия и расписание с исходной ревизией; конфликт сохраняет открытый черновик. */
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (disabled || saving) return;
    setSaving(true);
    setError('');
    try {
      const editable = {
        actions,
        schedule: { ...schedule, days: [...schedule.days].sort((a, b) => a - b) },
        ...(!builtin ? { name: name.trim(), description: description.trim() } : {}),
      };
      onSaved(
        await api<SceneDefinition>(
          isNew ? '/scenes' : `/scenes/${encodeURIComponent(definition.id)}`,
          {
            method: isNew ? 'POST' : 'PUT',
            ...jsonBody(isNew ? editable : { baseRevision: definition.revision, ...editable }),
          },
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось сохранить сценарий');
    } finally {
      setSaving(false);
    }
  }

  /** Удаляет пользовательский сценарий с проверкой ревизии; встроенные сценарии защищены. */
  async function remove() {
    if (builtin || isNew || saving || disabled) return;
    setSaving(true);
    setError('');
    try {
      await api(`/scenes/${encodeURIComponent(definition.id)}`, {
        method: 'DELETE',
        ...jsonBody({ baseRevision: definition.revision }),
      });
      onDeleted(definition.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось удалить сценарий');
    } finally {
      setSaving(false);
    }
  }
  return {
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
  };
}

/** Контракт черновика для простых компонентов полей редактора. */
export type SceneEditorModel = ReturnType<typeof useSceneEditor>;
