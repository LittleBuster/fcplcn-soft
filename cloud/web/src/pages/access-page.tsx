/** @file Участники дома и создание приглашения с отдельным разрешением управления охраной. */
import type { CloudRole, HomeDetail, HomeView, InvitationView } from '../../../shared/api.js';
import type { CloudAction } from '../app/types';
import type { useAccessDraft } from '../hooks/use-home-drafts';
import { api } from '../api';
import { MemberRow } from '../components/member-row';
import { Icon } from '../icons';
import { copy, date, roles } from '../lib/presentation';

interface AccessPageProps {
  home: HomeView;
  detail: HomeDetail | null;
  owner: boolean;
  busy: boolean;
  act: CloudAction;
  refresh: () => Promise<void>;
  draft: ReturnType<typeof useAccessDraft>;
}

export function AccessPage({ home, detail, owner, busy, act, refresh, draft }: AccessPageProps) {
  const {
    invitation,
    setInvitation,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setInviteRole,
    inviteSecurity,
    setInviteSecurity,
  } = draft;
  return (
    <div class="access-grid">
      <article class="panel card">
        <h2>
          <Icon name="users" />
          Доступ к дому
        </h2>
        <p>
          Права выдаются для этого дома. Настройки оборудования и обновления доступны владельцам.
        </p>
        <div class="members-list">
          {detail?.members.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              isOwner={owner}
              onSave={async (role, security) => {
                await api(
                  '/homes/' + home.id + '/members/' + member.userId,
                  { role, securityControl: security },
                  'PATCH',
                );
                await refresh();
              }}
              onRemove={async () => {
                await api('/homes/' + home.id + '/members/' + member.userId, {}, 'DELETE');
                await refresh();
              }}
            />
          ))}
        </div>
      </article>
      <form
        class="panel card"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const value = await act<InvitationView>('/homes/' + home.id + '/invites', {
              ...(inviteEmail.trim() ? { email: inviteEmail.trim() } : {}),
              role: inviteRole,
              securityControl:
                inviteRole === 'owner' || (inviteRole === 'operator' && inviteSecurity),
            });
            if (value) setInvitation(value);
          } catch {}
        }}
      >
        <h2>
          <Icon name="plus" />
          Пригласить человека
        </h2>
        <label>
          Электронная почта <span class="muted">необязательно</span>
          <input
            type="email"
            value={inviteEmail}
            onInput={(event) => setInviteEmail(event.currentTarget.value)}
            placeholder="name@example.ru"
          />
        </label>
        <label>
          Права доступа
          <select
            value={inviteRole}
            onChange={(event) => setInviteRole(event.currentTarget.value as CloudRole)}
          >
            {Object.entries(roles).map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </select>
        </label>
        {inviteRole === 'operator' ? (
          <label class="checkbox">
            <input
              type="checkbox"
              checked={inviteSecurity}
              onChange={(event) => setInviteSecurity(event.currentTarget.checked)}
            />
            Разрешить управление охраной
          </label>
        ) : null}
        <button class="button" disabled={busy}>
          Создать приглашение
          <Icon name="arrow" />
        </button>
        <p class="hint">
          Скопируйте ссылку и передайте человеку. Письма автоматически не отправляются.
        </p>
        {invitation ? (
          <div class="secret-card">
            <strong>Ссылка приглашения</strong>
            <input readOnly value={invitation.url} />
            <button
              class="button secondary"
              type="button"
              onClick={() => void copy(invitation.url)}
            >
              <Icon name="copy" />
              Скопировать ссылку
            </button>
            <small>Действует до {date(invitation.expiresAt)}</small>
          </div>
        ) : null}
      </form>
    </div>
  );
}
