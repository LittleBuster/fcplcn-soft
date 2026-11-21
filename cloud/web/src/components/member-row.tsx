/** @file Строка участника дома с самостоятельным черновиком роли и разрешения охраны. */
import { useEffect, useState } from 'preact/hooks';
import type { CloudRole, MemberView } from '../../../shared/api.js';
import { Icon } from '../icons';
import { failure, roles } from '../lib/presentation';

/** Подтверждённый участник и операции владельца над его доступом к дому. */
interface MemberProps {
  member: MemberView;
  isOwner: boolean;
  onSave: (role: CloudRole, security: boolean) => Promise<void>;
  onRemove: () => Promise<void>;
}

/** Редактирует роль участника, сохраняя локальный черновик до явного подтверждения. */
export function MemberRow({ member, isOwner, onSave, onRemove }: MemberProps) {
  const [role, setRole] = useState(member.role);
  const [security, setSecurity] = useState(member.securityControl);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const dirty = role !== member.role || security !== member.securityControl;

  // Периодическое чтение состава дома не должно затирать несохранённый выбор владельца.
  useEffect(() => {
    if (!dirty) {
      setRole(member.role);
      setSecurity(member.securityControl);
    }
  }, [member.role, member.securityControl]);

  return (
    <article class="member-row">
      <span class="person-avatar">{member.name.slice(0, 1).toLocaleUpperCase('ru')}</span>
      <div class="member-name">
        <strong>{member.name}</strong>
        <span>{member.username || member.email}</span>
      </div>
      {isOwner ? (
        <>
          <label class="sr-only" for={'role-' + member.userId}>
            Роль {member.name}
          </label>
          <select
            id={'role-' + member.userId}
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.currentTarget.value as CloudRole)}
          >
            {Object.entries(roles).map(([id, title]) => (
              <option value={id} key={id}>
                {title}
              </option>
            ))}
          </select>
          {role === 'operator' ? (
            <label class="checkbox compact">
              <input
                type="checkbox"
                checked={security}
                onChange={(event) => setSecurity(event.currentTarget.checked)}
                disabled={busy}
              />
              Охрана
            </label>
          ) : null}
          <button
            class="button secondary small"
            disabled={busy || !dirty}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await onSave(role, role === 'owner' || (role === 'operator' && security));
              } catch (error) {
                setError(failure(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            Сохранить
          </button>
          <button
            class="icon-button danger"
            aria-label={'Удалить доступ ' + member.name}
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Удалить доступ этого пользователя к дому?')) return;
              setBusy(true);
              try {
                await onRemove();
              } catch (error) {
                setError(failure(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="trash" />
          </button>
        </>
      ) : (
        <span class="badge">{roles[member.role]}</span>
      )}
      {error ? (
        <p class="row-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
