/** @file Одно уведомление о запуске, таймер успеха и защита от повторного показа истории. */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ScenesSnapshot } from '../../../../shared/types.js';

/** Сохраняет прежний жизненный цикл уведомления при периодическом обновлении снимка. */
export function useRunNotice(
  snapshot: ScenesSnapshot,
  clearNoticeToken: number,
  onClearError: () => void,
) {
  // Одно уведомление о текущем запуске; журнал остаётся отдельной историей.
  const current = snapshot.activeRun || snapshot.runs[0];

  const [visibleRunId, setVisibleRunId] = useState<string | null>(
    () => snapshot.activeRun?.id || null,
  );

  const [noticeDetailsOpen, setNoticeDetailsOpen] = useState(false);

  const lastSeenRun = useRef(current?.id || null);
  const lastClearToken = useRef(clearNoticeToken);
  const mounted = useRef(true);

  /** Новый запуск заменяет уведомление; ранее загруженная история не создаёт новых сообщений. */
  useEffect(() => {
    if (current && (current.id !== lastSeenRun.current || current.status === 'running')) {
      lastSeenRun.current = current.id;
      setVisibleRunId(current.id);
      setNoticeDetailsOpen(false);
    }
  }, [current?.id, current?.status]);

  /** Опрос создаёт новые объекты; таймер зависит только от идентификатора и статуса запуска. */
  useEffect(() => {
    if (
      !current ||
      current.id !== visibleRunId ||
      current.status !== 'completed' ||
      noticeDetailsOpen
    )
      return;
    const id = current.id;
    const timer = window.setTimeout(
      () => setVisibleRunId((visible) => (visible === id ? null : visible)),
      4000,
    );
    return () => window.clearTimeout(timer);
  }, [current?.id, current?.status, visibleRunId, noticeDetailsOpen]);

  useEffect(() => {
    if (lastClearToken.current === clearNoticeToken) return;
    lastClearToken.current = clearNoticeToken;
    setVisibleRunId(null);
    onClearError();
  }, [clearNoticeToken]);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return { current, visibleRunId, setVisibleRunId, setNoticeDetailsOpen, mounted };
}
