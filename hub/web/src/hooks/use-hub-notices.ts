/** @file Одно текущее уведомление без накопления строк при периодическом опросе. */
import { useState, useEffect } from 'preact/hooks';
import type { Notice } from '../app/types';

/** Гасит успешные уведомления по таймеру и очищает их при новом запуске сценария. */
export function useHubNotices(latestRunId?: string) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [clearSceneNoticeToken, setClearSceneNoticeToken] = useState(0);

  /** Успешное уведомление исчезает по таймеру; обновления телеметрии не продлевают его жизнь. */
  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = window.setTimeout(
      () => setNotice((current) => (current === notice ? null : current)),
      4000,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    setNotice(null);
  }, [latestRunId]);

  return { notice, setNotice, clearSceneNoticeToken, setClearSceneNoticeToken };
}

export type HubNotices = ReturnType<typeof useHubNotices>;
