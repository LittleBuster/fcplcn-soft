/** @file Личная учётная запись: логин, пароль, TOTP и коды восстановления. */
import { useState } from 'preact/hooks';
import type { CloudSession, TOTPSetup } from '../../../shared/api.js';
import type { Notice } from '../app/types';
import { api } from '../api';
import { Icon } from '../icons';
import { copy, failure } from '../lib/presentation';

/** Текущая учётная запись и повторное чтение сессии после её изменения. */
interface AccountProps {
  session: CloudSession;
  refresh: () => Promise<void>;
}

/** Настраивает логин, пароль и TOTP, не передавая секреты во встроенную панель хаба. */
export function AccountPage({ session, refresh }: AccountProps) {
  const [username, setUsername] = useState(
    session.user?.username || session.user?.email || 'admin',
  );
  const [password, setPassword] = useState('');
  const [next, setNext] = useState('');
  const [changePassword, setChangePassword] = useState(false);

  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<TOTPSetup | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  /** Выполняет изменение учётной записи и заново читает сессию после подтверждения сервера. */
  async function act(path: string, body: unknown, onSuccess?: (value: any) => void) {
    setBusy(true);
    setNotice(null);
    try {
      const value = await api(path, body);
      onSuccess?.(value);
      setNotice({ kind: 'success', text: 'Настройки учётной записи сохранены.' });
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', text: failure(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="account-grid">
      <article class="panel card">
        <h2>
          <Icon name="users" />
          Ваш профиль
        </h2>
        <dl class="facts">
          <div>
            <dt>Имя</dt>
            <dd>{session.user?.name}</dd>
          </div>
          <div>
            <dt>Логин</dt>
            <dd>{session.user?.username || session.user?.email}</dd>
          </div>
          <div>
            <dt>Почта</dt>
            <dd>{session.user?.email || 'Не указана'}</dd>
          </div>
          <div>
            <dt>Двухфакторная защита</dt>
            <dd>{session.user?.totpEnabled ? 'Включена' : 'Не включена'}</dd>
          </div>
        </dl>
        <p>Учётная запись открывает только те дома, к которым вам выдан доступ.</p>
        {notice ? (
          <div class={'notice ' + notice.kind} role="status">
            {notice.text}
          </div>
        ) : null}
      </article>
      <article class="panel card">
        <h2>
          <Icon name="key" />
          Логин, пароль и защита
        </h2>
        <label>
          Логин
          <input
            autoComplete="username"
            value={username}
            onInput={(event) => setUsername(event.currentTarget.value)}
            maxLength={254}
            disabled={busy}
          />
        </label>
        <label>
          Текущий пароль
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        <p class="hint">Если текущий пароль пустой, оставьте поле пустым.</p>
        <label>
          Код подтверждения
          <input
            value={code}
            onInput={(event) => setCode(event.currentTarget.value)}
            autoComplete="one-time-code"
            placeholder="Код 2FA или восстановления"
          />
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            checked={changePassword}
            disabled={busy}
            onChange={(event) => setChangePassword(event.currentTarget.checked)}
          />
          Изменить пароль
        </label>
        {changePassword ? (
          <label>
            Новый пароль
            <input
              type="password"
              minLength={10}
              maxLength={256}
              autoComplete="new-password"
              value={next}
              onInput={(event) => setNext(event.currentTarget.value)}
            />
          </label>
        ) : null}
        {changePassword ? (
          <p class="hint">
            Пустой новый пароль сохраняет вход без пароля. Непустой — от 10 символов.
          </p>
        ) : null}
        <button
          class="button secondary"
          disabled={
            busy ||
            !username.trim() ||
            (changePassword && next.length > 0 && next.length < 10) ||
            (!changePassword && username === (session.user?.username || session.user?.email))
          }
          onClick={() =>
            void act(
              '/auth/account',
              {
                username,
                currentPassword: password,
                ...(changePassword ? { password: next } : {}),
                ...(code ? { code } : {}),
              },
              (value) => {
                if (typeof value.user?.username === 'string') setUsername(value.user.username);
                setPassword('');
                setNext('');
                setChangePassword(false);
                setCode('');
              },
            )
          }
        >
          Сохранить учётные данные
        </button>
        {!session.user?.totpEnabled ? (
          <button
            class="button"
            disabled={busy}
            onClick={() => void act('/auth/totp/setup', { password }, (value) => setSetup(value))}
          >
            <Icon name="shield" />
            Настроить двухфакторную защиту
          </button>
        ) : (
          <button
            class="button secondary danger"
            disabled={busy || !code}
            onClick={() =>
              void act('/auth/totp/disable', { password, code }, () => {
                setPassword('');
                setCode('');
              })
            }
          >
            Отключить двухфакторную защиту
          </button>
        )}
        {setup ? (
          <div class="secret-card">
            <strong>Добавьте ключ в приложение-аутентификатор</strong>
            <code>{setup.secret}</code>
            <button class="button secondary small" onClick={() => void copy(setup.secret)}>
              <Icon name="copy" />
              Скопировать ключ
            </button>
            <p>Введите шестизначный код из приложения, чтобы завершить настройку.</p>
            <button
              class="button"
              disabled={busy || !code.trim()}
              onClick={() =>
                void act('/auth/totp/confirm', { code: code.trim() }, (value) => {
                  setRecovery(value.recoveryCodes || []);
                  setSetup(null);
                  setCode('');
                  setPassword('');
                })
              }
            >
              Подтвердить включение
            </button>
          </div>
        ) : null}
        {recovery.length ? (
          <div class="secret-card">
            <strong>Сохраните коды восстановления</strong>
            <p>Каждый код используется один раз. После закрытия они больше не показываются.</p>
            <div class="recovery-codes">
              {recovery.map((entry) => (
                <code key={entry}>{entry}</code>
              ))}
            </div>
            <button class="button secondary" onClick={() => void copy(recovery.join('\n'))}>
              <Icon name="copy" />
              Скопировать коды
            </button>
            <button class="text-button" onClick={() => setRecovery([])}>
              Коды сохранены
            </button>
          </div>
        ) : null}
      </article>
    </section>
  );
}
