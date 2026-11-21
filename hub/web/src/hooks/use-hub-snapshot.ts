/** @file Последний снимок хаба и отменяемый опрос без параллельных запросов. */
import { useState, useRef, useEffect } from 'preact/hooks';
import type { HubSnapshot } from '../../../shared/types.js';
import { api, ApiError } from '../api';
import type { HubSession } from './use-hub-session';

/** Не позволяет старому опросу перезаписать новую сессию или принятые изменения сценариев. */
export function useHubSnapshot(auth: HubSession, onUnauthorized: () => void) {
  const { session, sessionRef, sessionVersion, setSession } = auth;
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const sceneVersion = useRef(0);

  /** Применяет только ответ текущей сессии; отмена не становится сетевой ошибкой. */
  async function refresh(signal?: AbortSignal) {
    if (refreshingRef.current || !sessionRef.current?.authenticated) return;
    const version = sessionVersion.current;
    const sceneGeneration = sceneVersion.current;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const result = await api<HubSnapshot>('/overview', { signal });
      if (version !== sessionVersion.current || signal?.aborted) return;
      setSnapshot((current) =>
        sceneGeneration === sceneVersion.current
          ? result
          : { ...result, scenes: current?.scenes || result.scenes },
      );
      setLoadError('');
    } catch (error) {
      if (version !== sessionVersion.current || signal?.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        sessionVersion.current++;
        setSnapshot(null);
        onUnauthorized();
        setSession((value) => (value ? { ...value, authenticated: false } : null));
      } else setLoadError(error instanceof Error ? error.message : 'Не удалось обновить состояния');
    } finally {
      refreshingRef.current = false;
      if (version === sessionVersion.current) setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    const abort = new AbortController();
    void refresh(abort.signal);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(abort.signal);
    }, 2000);
    const visible = () => {
      if (!document.hidden) void refresh(abort.signal);
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      abort.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [session?.authenticated]);

  return { snapshot, setSnapshot, loadError, refreshing, sceneVersion, refresh };
}

export type HubSnapshotState = ReturnType<typeof useHubSnapshot>;
