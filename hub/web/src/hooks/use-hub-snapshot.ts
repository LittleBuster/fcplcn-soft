/** @file Последний снимок хаба и отменяемый опрос без параллельных запросов. */
import { useState, useRef, useEffect } from 'preact/hooks';
import type { HubSnapshot } from '../../../shared/types.js';
import { api, ApiError } from '../api';
import type { HubSession } from './use-hub-session';

const overviewTimeoutMs = 8000;
type Cancellation = 'cancelled' | 'timeout';
interface OverviewRequest {
  controller: AbortController;
  cancel: (reason: Cancellation) => void;
  reason?: Cancellation;
}

/** Не позволяет старому опросу перезаписать новую сессию или принятые изменения сценариев. */
export function useHubSnapshot(auth: HubSession, onUnauthorized: () => void) {
  const { session, sessionRef, sessionVersion, setSession } = auth;
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [connectionFresh, setConnectionFresh] = useState(false);
  const activeRequest = useRef<OverviewRequest | null>(null);
  const sceneVersion = useRef(0);

  /** Освобождает очередь сразу: зависший fetch не задерживает новое чтение после пробуждения. */
  function cancelActive() {
    const request = activeRequest.current;
    if (!request) return;
    activeRequest.current = null;
    request.cancel('cancelled');
    setRefreshing(false);
  }

  /** Применяет только ответ текущей сессии; намеренная отмена не становится сетевой ошибкой. */
  async function refresh(signal?: AbortSignal) {
    if (activeRequest.current || !sessionRef.current?.authenticated || document.hidden) return;
    if (navigator.onLine === false) {
      setConnectionFresh(false);
      setLoadError('Нет связи с хабом. Проверьте подключение к локальной сети.');
      return;
    }
    if (signal?.aborted) return;
    const version = sessionVersion.current;
    const sceneGeneration = sceneVersion.current;
    const request: OverviewRequest = { controller: new AbortController(), cancel: () => {} };
    // The race also settles when a suspended browser/network stack ignores AbortSignal.
    const cancellation = new Promise<never>((_resolve, reject) => {
      request.cancel = (reason) => {
        if (request.reason) return;
        request.reason = reason;
        request.controller.abort();
        reject(new DOMException('Overview request cancelled', 'AbortError'));
      };
    });
    activeRequest.current = request;
    setRefreshing(true);
    const timer = window.setTimeout(() => request.cancel('timeout'), overviewTimeoutMs);
    const externalAbort = () => {
      if (activeRequest.current === request) cancelActive();
      else request.cancel('cancelled');
    };
    signal?.addEventListener('abort', externalAbort, { once: true });
    try {
      const result = await Promise.race([
        api<HubSnapshot>('/overview', { signal: request.controller.signal }),
        cancellation,
      ]);
      if (
        activeRequest.current !== request ||
        version !== sessionVersion.current ||
        signal?.aborted ||
        document.hidden
      )
        return;
      setSnapshot((current) =>
        sceneGeneration === sceneVersion.current
          ? result
          : { ...result, scenes: current?.scenes || result.scenes },
      );
      setLoadError('');
      setConnectionFresh(true);
    } catch (error) {
      if (
        activeRequest.current !== request ||
        version !== sessionVersion.current ||
        signal?.aborted ||
        request.reason === 'cancelled'
      )
        return;
      setConnectionFresh(false);
      if (request.reason === 'timeout') {
        setLoadError('Хаб не ответил вовремя. Проверяем подключение…');
      } else if (error instanceof ApiError && error.status === 401) {
        sessionVersion.current++;
        setSnapshot(null);
        onUnauthorized();
        setSession((value) => (value ? { ...value, authenticated: false } : null));
      } else setLoadError(error instanceof Error ? error.message : 'Не удалось обновить состояния');
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', externalAbort);
      // A late completion cannot release or hide a newer request's progress.
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    const abort = new AbortController();
    setConnectionFresh(false);
    void refresh(abort.signal);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(abort.signal);
    }, 2000);
    const restore = () => {
      if (document.hidden) return;
      cancelActive();
      setConnectionFresh(false);
      void refresh(abort.signal);
    };
    const visible = () => {
      if (document.hidden) {
        setConnectionFresh(false);
        cancelActive();
      } else restore();
    };
    const offline = () => {
      setConnectionFresh(false);
      cancelActive();
      setLoadError('Нет связи с хабом. Проверьте подключение к локальной сети.');
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', restore);
    window.addEventListener('offline', offline);
    return () => {
      abort.abort();
      cancelActive();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', restore);
      window.removeEventListener('offline', offline);
    };
  }, [session?.authenticated]);

  return { snapshot, setSnapshot, loadError, refreshing, connectionFresh, sceneVersion, refresh };
}

export type HubSnapshotState = ReturnType<typeof useHubSnapshot>;
