/** @file Локальный вход в хаб; облачный портал использует свою сессию. */
import { useState } from 'preact/hooks';
import type { SessionView } from '../../../shared/types.js';
import { api, jsonBody } from '../api';
import { Icon } from '../icons';
/** Форма авторизации очищает пароль после успешного входа. */
export function Login({
  session,
  onLogin,
  initialUsername,
}: {
  session: SessionView;
  onLogin: (session: SessionView) => void;
  initialUsername: string;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <main class="login-page">
      <div class="login-orbit">
        <Icon name="home" />
      </div>
      <form
        class="login-card panel"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const result = await api<SessionView>('/auth/login', {
              method: 'POST',
              ...jsonBody({ username, password }),
            });
            setPassword('');
            onLogin(result);
          } catch (error) {
            setError(error instanceof Error ? error.message : 'Не удалось войти');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div class="login-brand">
          <div class="brand-symbol">
            <Icon name="home" />
          </div>
          <div>
            <strong>{session.product.name}</strong>
            <span>Локальный хаб</span>
          </div>
        </div>
        <h1>Дом начинается здесь</h1>
        <p>Войдите, чтобы управлять устройствами в своей локальной сети.</p>
        <label>
          Логин
          <input
            name="username"
            autoComplete="username"
            value={username}
            onInput={(event) => setUsername(event.currentTarget.value)}
            required
          />
        </label>
        <label>
          Пароль
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        {error ? (
          <div class="notice error" role="alert">
            {error}
          </div>
        ) : null}
        <button class="button login-button" disabled={busy}>
          {busy ? 'Входим…' : 'Войти в хаб'}
          <Icon name="arrow" />
        </button>
        <div class="login-foot">
          <Icon name="shield" />
          Ваш дом остаётся в вашей сети
        </div>
      </form>
      <span class="login-product">{session.product.fullName}</span>
    </main>
  );
}
