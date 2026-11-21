/** @file Запуск, права доступа и открытие черновика редактора сценария. */

import { useState } from 'preact/hooks';
import type { SceneDefinition, SceneId, SceneRun } from '../../../../shared/types.js';
import { api, jsonBody } from '../../api';
import { canConfigure, canControl, canManageSecurity } from '../../portal';
import type { ScenesPanelProps } from './types';
import { useRunNotice } from './use-run-notice';

/** Хранит состояние панели; сетевые ответы не применяются после её закрытия. */
export function useScenesPanel({
  snapshot,
  unavailable,
  manualBusy,
  onRunAccepted,
  onStarting,
  clearNoticeToken = 0,
}: Pick<
  ScenesPanelProps,
  'snapshot' | 'unavailable' | 'manualBusy' | 'onRunAccepted' | 'onStarting' | 'clearNoticeToken'
>) {
  // Черновик редактора и выбранная группа библиотеки.
  const [starting, setStarting] = useState<SceneId | null>(null);
  const [editing, setEditing] = useState<SceneDefinition | null>(null);
  const [error, setError] = useState('');
  const [group, setGroup] = useState<'instant' | 'scheduled'>('instant');
  const { current, visibleRunId, setVisibleRunId, setNoticeDetailsOpen, mounted } = useRunNotice(
    snapshot,
    clearNoticeToken,
    () => setError(''),
  );
  const storageError =
    'storageError' in snapshot && typeof snapshot.storageError === 'string'
      ? snapshot.storageError
      : '';

  const busy = Boolean(starting || snapshot.activeRun);

  const blocked = !canControl || busy || unavailable || manualBusy || Boolean(storageError);

  /** Проверяет право управления охраной для встроенных и пользовательских сценариев. */
  const allowed = (id: string) =>
    canManageSecurity ||
    (!['home', 'away'].includes(id) &&
      !snapshot.definitions
        .find((entry) => entry.id === id)
        ?.actions.some((entry) => entry.controller === 'security'));

  /** Запускает один разрешённый сценарий и принимает результат только пока панель открыта. */
  async function run(id: SceneId) {
    if (blocked || !allowed(id)) return;
    setStarting(id);
    setError('');
    setVisibleRunId(null);
    onStarting(true);
    try {
      const result = await api<SceneRun>(`/scenes/${encodeURIComponent(id)}/run`, {
        method: 'POST',
        ...jsonBody({}),
      });
      if (mounted.current) onRunAccepted(result);
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : 'Не удалось запустить сценарий');
    } finally {
      if (mounted.current) {
        setStarting(null);
        onStarting(false);
      }
    }
  }

  /** Открывает редактор с отдельными копиями действий и дней расписания текущего сценария. */
  function edit(definition: SceneDefinition) {
    if (!canConfigure) return;
    setEditing({
      ...definition,
      actions: definition.actions.map((action) => ({ ...action })),
      schedule: definition.schedule
        ? { ...definition.schedule, days: [...definition.schedule.days] }
        : null,
    });
  }

  /** Открывает пустой пользовательский сценарий с расписанием, соответствующим выбранной группе. */
  function create() {
    if (!canConfigure) return;
    setEditing({
      id: '',
      name: '',
      description: '',
      revision: 1,
      actions: [],
      schedule: {
        enabled: group === 'scheduled',
        days: [1, 2, 3, 4, 5],
        time: '08:00',
        timeZone: 'Asia/Novosibirsk',
      },
    });
  }

  const grouped = snapshot.definitions.filter(
    (definition) => Boolean(definition.schedule?.enabled) === (group === 'scheduled'),
  );
  return {
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
  };
}

/** Данные и действия панели для компонентов представления. */
export type ScenesPanelModel = ReturnType<typeof useScenesPanel>;
