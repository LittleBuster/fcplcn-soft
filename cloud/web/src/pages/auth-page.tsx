/** @file Вход в облако, первый запуск и принятие приглашения до авторизации. */
import { useEffect, useState } from 'preact/hooks';
import type { CloudSession, CloudRole } from '../../../shared/api.js';
import { api, sessionToken } from '../api';
import { Icon } from '../icons';
import { failure, roles } from '../lib/presentation';

/** Данные формы входа, первого запуска или принятия приглашения. */
interface AuthProps {
  session: CloudSession;
  onSession: (value: CloudSession) => void;
  invite: string;
}

/** Показывает нужный вариант авторизации и передаёт оболочке только обновлённую сессию. */
export function AuthPage({ session, onSession, invite }: AuthProps) {
  const [username, setUsername] = useState('admin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [totp, setTotp] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invitation, setInvitation] = useState<{
    homeName: string;
    role: CloudRole;
    emailRequired: boolean;
  } | null>(null);

  useEffect(() => {
    if (invite)
      void api<typeof invitation>('/invites/' + encodeURIComponent(invite))
        .then(setInvitation)
        .catch((error) => setError(failure(error)));
  }, [invite]);

  const create = session.setupRequired || Boolean(invite);

  return (
    <main class="auth-page">
      <div class="auth-art">
        <span class="art-grid" />
        <div class="cloud-emblem">
          <Icon name="cloud" />
          <i />
          <i />
        </div>
        <h1>{session.product.name}</h1>
        <p>{session.product.fullName}</p>
        <h2>
          Дом рядом,
          <br />
          где бы вы ни были.
        </h2>
        <span>Защищённый доступ · Автономная работа PLC</span>
      </div>
      <form
        class="auth-card panel"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            if (invite) await api('/invites/accept', { token: invite, email, name, password });
            else if (session.setupRequired)
              await api('/auth/setup', { setupKey, email, name, password });
            else
              await api('/auth/login', {
                username,
                password,
                ...(totp.trim() ? { totp: totp.trim() } : {}),
              });
            const next = await api<CloudSession>('/session');
            sessionToken(next.csrfToken);
            setPassword('');
            setTotp('');
            onSession(next);
          } catch (error) {
            setError(failure(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div class="auth-brand">
          <span class="brand-symbol">
            <Icon name="home" />
          </span>
          <div>
            <strong>{session.product.name}</strong>
            <small>Облачная панель</small>
          </div>
        </div>
        <span class="eyebrow">
          {session.setupRequired
            ? 'Первый запуск'
            : invite
              ? 'Приглашение в дом'
              : 'Добро пожаловать'}
        </span>
        <h2>
          {session.setupRequired
            ? 'Создайте владельца'
            : invite
              ? 'Присоединиться к дому'
              : 'Войти в свой дом'}
        </h2>
        <p>
          {invitation
            ? `${invitation.homeName} · ${roles[invitation.role]}`
            : session.setupRequired
              ? 'Создайте первую учётную запись и добавьте свой хаб.'
              : 'Войдите, чтобы видеть состояния и управлять вашим домом.'}
        </p>
        {session.setupRequired ? (
          <label>
            Код первого запуска
            <input
              value={setupKey}
              onInput={(event) => setSetupKey(event.currentTarget.value)}
              autoComplete="off"
              required
            />
          </label>
        ) : null}
        {create ? (
          <label>
            Ваше имя
            <input
              value={name}
              onInput={(event) => setName(event.currentTarget.value)}
              maxLength={96}
              autoComplete="name"
              required
            />
          </label>
        ) : null}
        <label>
          {create ? 'Электронная почта' : 'Логин'}
          {create ? (
            <input
              type="email"
              value={email}
              onInput={(event) => setEmail(event.currentTarget.value)}
              autoComplete="username"
              maxLength={254}
              required
            />
          ) : (
            <input
              type="text"
              value={username}
              onInput={(event) => setUsername(event.currentTarget.value)}
              autoComplete="username"
              maxLength={254}
              required
            />
          )}
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
            minLength={create ? 10 : undefined}
            maxLength={256}
            autoComplete={create ? 'new-password' : 'current-password'}
            required={create}
          />
        </label>
        {!create ? (
          <label>
            Код двухфакторной защиты <span class="muted">если включена</span>
            <input
              value={totp}
              onInput={(event) => setTotp(event.currentTarget.value)}
              inputMode="text"
              autoComplete="one-time-code"
              placeholder="Код из приложения или код восстановления"
              maxLength={80}
            />
          </label>
        ) : (
          <p class="hint">Пароль — от 10 символов.</p>
        )}
        {error ? (
          <div class="notice error" role="alert">
            <Icon name="shield" />
            {error}
          </div>
        ) : null}
        <button class="button" disabled={busy}>
          {busy ? 'Подключаемся…' : create ? 'Создать учётную запись' : 'Войти'}
          <Icon name="arrow" />
        </button>
        <div class="auth-foot">
          <Icon name="lock" />
          Доступ только к вашим домам
        </div>
      </form>
    </main>
  );
}
