/** @file Авторизация, сведения о продукте и поколение текущей браузерной сессии. */
import { useState, useRef, useEffect } from 'preact/hooks';
import type { SessionView } from '../../../shared/types.js';
import { api, jsonBody } from '../api';

/** Загружает сессию и отсекает результаты операций, начатых до выхода. */
export function useHubSession(onLogout: () => void) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loginUsername, setLoginUsername] = useState('admin');
  const [initialError, setInitialError] = useState('');
  const sessionVersion = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  /** Читает состояние входа и сведения о продукте для начального экрана. */
  async function loadSession() {
    setInitialError('');
    try {
      setSession(await api<SessionView>('/session'));
    } catch (error) {
      setInitialError(error instanceof Error ? error.message : 'Хаб недоступен');
    }
  }

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (!session) return;
    document.title = `${session.product.name} · Хаб — ${session.product.fullName}`;
  }, [session?.product.name]);

  /** Сразу закрывает локальный интерфейс и затем завершает серверную сессию. */
  async function logout(contactServer = true) {
    const version = ++sessionVersion.current;
    onLogout();
    try {
      if (contactServer) await api('/auth/logout', { method: 'POST', ...jsonBody({}) });
    } catch {
      /* Даже при истёкшей серверной сессии локальный интерфейс остаётся закрытым. */
    }
    if (version !== sessionVersion.current) return;
    await loadSession();
  }

  /** Новая авторизация получает отдельное поколение асинхронных действий. */
  function acceptLogin(value: SessionView) {
    sessionVersion.current++;
    setSession(value);
  }

  return {
    session,
    setSession,
    sessionRef,
    sessionVersion,
    loginUsername,
    setLoginUsername,
    initialError,
    loadSession,
    logout,
    acceptLogin,
  };
}

export type HubSession = ReturnType<typeof useHubSession>;
