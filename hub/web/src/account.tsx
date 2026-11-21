/** @file Редактор локальной учётной записи хаба с повторным входом после сохранения. */

import { useEffect, useRef, useState } from 'preact/hooks';
import { api, jsonBody } from './api';
import { Icon } from './icons';
import './account.css';

/** Редактирует логин и пароль; после подтверждённого сохранения запрашивает повторный вход. */
export function AccountPanel({ onChanged }: { onChanged: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [changePassword, setChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void api<{ username: string }>('/account', { signal: abort.signal })
      .then((value) => {
        if (abort.signal.aborted) return;
        setUsername(value.username);
        setReady(true);
      })
      .catch((failure) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : 'Не удалось прочитать учётную запись',
          );
      });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, []);

  return (
    <section class="account-settings" data-account-settings>
      <article class="panel account-hero">
        <span class="account-symbol">
          <Icon name="person" />
        </span>
        <div>
          <span class="eyebrow">Ваш локальный доступ</span>
          <h2>Учётная запись хаба</h2>
          <p>Измените логин и пароль для входа в этот хаб.</p>
        </div>
      </article>
      <form
        class="panel account-card"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current || !ready) return;
          setError('');
          if (changePassword && newPassword !== confirmation) {
            setError('Новые пароли не совпадают');
            return;
          }
          pending.current = true;
          setBusy(true);
          try {
            await api('/account', {
              method: 'POST',
              ...jsonBody({
                username: username.trim(),
                currentPassword,
                ...(changePassword ? { newPassword } : {}),
              }),
            });
            setCurrentPassword('');
            setNewPassword('');
            setConfirmation('');
            if (mounted.current) onChanged(username.trim());
          } catch (failure) {
            if (mounted.current)
              setError(
                failure instanceof Error ? failure.message : 'Не удалось сохранить учётную запись',
              );
          } finally {
            pending.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <h2>
          <Icon name="shield" /> Данные для входа
        </h2>
        <label>
          Логин
          <input
            name="username"
            autoComplete="username"
            value={username}
            onInput={(event) => setUsername(event.currentTarget.value)}
            maxLength={64}
            required
            disabled={busy || !ready}
          />
        </label>
        <label>
          Текущий пароль
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onInput={(event) => setCurrentPassword(event.currentTarget.value)}
            maxLength={256}
            disabled={busy || !ready}
          />
        </label>
        <p class="account-hint">Если пароль ещё не задан, оставьте текущий пароль пустым.</p>
        <label class="account-checkbox">
          <input
            type="checkbox"
            checked={changePassword}
            onChange={(event) => setChangePassword(event.currentTarget.checked)}
            disabled={busy || !ready}
          />
          Изменить пароль
        </label>
        {changePassword ? (
          <div class="account-passwords">
            <label>
              Новый пароль
              <input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onInput={(event) => setNewPassword(event.currentTarget.value)}
                minLength={8}
                maxLength={256}
                disabled={busy}
              />
            </label>
            <label>
              Повторите новый пароль
              <input
                name="confirmation"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onInput={(event) => setConfirmation(event.currentTarget.value)}
                maxLength={256}
                disabled={busy}
              />
            </label>
            <p class="account-hint">
              От 8 символов. Чтобы убрать пароль, оставьте оба поля пустыми.
            </p>
          </div>
        ) : null}
        {error ? (
          <div class="notice error" role="alert">
            <Icon name="alarm" />
            <span>{error}</span>
          </div>
        ) : null}
        <p class="account-hint">После сохранения потребуется войти заново на всех устройствах.</p>
        <button class="button" disabled={busy || !ready}>
          <Icon name={busy ? 'refresh' : 'check'} />
          {busy ? 'Сохраняем…' : 'Сохранить учётную запись'}
        </button>
      </form>
    </section>
  );
}
