/** @file Жизненный цикл облачной сессии и очистка доступа после выхода или истечения cookie. */
import { useEffect, useState } from 'preact/hooks';
import type { CloudSession } from '../../../shared/api.js';
import type { CloudLifetime, SessionModel } from '../app/types';
import { api, sessionToken } from '../api';
import { failure } from '../lib/presentation';

interface Options {
  lifetime: CloudLifetime;
  onClear: (resetSelection?: boolean) => void;
  onError: (message: string) => void;
}

/** Не переносит данные прежнего пользователя через повторную авторизацию. */
export function useCloudSession({ lifetime, onClear, onError }: Options): SessionModel {
  const [session, setSession] = useState<CloudSession | null>(null);

  async function refreshSession() {
    const value = await api<CloudSession>('/session');
    sessionToken(value.csrfToken);
    if (lifetime.mounted.current) setSession(value);
  }

  useEffect(() => {
    lifetime.mounted.current = true;
    void refreshSession().catch((error) => onError(failure(error)));
    const expired = () => {
      lifetime.generation.current++;
      onClear();
      void refreshSession().catch(() => setSession(null));
    };
    window.addEventListener('fcplcn:session-ended', expired);
    return () => {
      lifetime.mounted.current = false;
      window.removeEventListener('fcplcn:session-ended', expired);
    };
  }, []);

  function acceptSession(value: CloudSession) {
    setSession(value);
    lifetime.generation.current++;
    onError('');
  }

  async function logout() {
    try {
      await api('/auth/logout', {});
    } finally {
      lifetime.generation.current++;
      sessionToken(null);
      onClear(true);
      if (session) setSession({ ...session, authenticated: false, user: null, csrfToken: null });
    }
  }

  return { session, refreshSession, acceptSession, logout };
}
