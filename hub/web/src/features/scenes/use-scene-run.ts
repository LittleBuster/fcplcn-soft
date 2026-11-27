/** @file Ручной запуск и подтверждение сценария в панели хаба и на планшете. */
import { useState } from 'preact/hooks';
import type { SceneId } from '../../../../shared/types.js';
import { canControl, canManageSecurity } from '../../portal';
import type { ScenesPanelProps } from './types';
import { useRunNotice } from './use-run-notice';

export function useSceneRun({
  snapshot,
  unavailable,
  manualBusy,
  onRun,
  clearNoticeToken = 0,
}: Pick<
  ScenesPanelProps,
  'snapshot' | 'unavailable' | 'manualBusy' | 'onRun' | 'clearNoticeToken'
>) {
  const [starting, setStarting] = useState<SceneId | null>(null);
  const [error, setError] = useState('');
  const { current, visibleRunId, setVisibleRunId, setNoticeDetailsOpen, mounted } = useRunNotice(
    snapshot,
    clearNoticeToken,
    () => setError(''),
  );
  const storageError = snapshot.storageError || '';

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
    try {
      await onRun(id);
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : 'Не удалось запустить сценарий');
    } finally {
      if (mounted.current) setStarting(null);
    }
  }

  return {
    starting,
    error,
    setError,
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
  };
}
