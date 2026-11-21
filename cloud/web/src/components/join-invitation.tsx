/** @file Явное принятие приглашения авторизованным пользователем. */
import type { CloudRole } from '../../../shared/api.js';
import type { CloudAction } from '../app/types';
import { Icon } from '../icons';
import { roles } from '../lib/presentation';

interface JoinInvitationProps {
  joinInfo: { homeName: string; role: CloudRole };
  invite: string;
  busy: boolean;
  act: CloudAction;
  onAccepted: () => void;
}

export function JoinInvitation({ joinInfo, invite, busy, act, onAccepted }: JoinInvitationProps) {
  return (
    <article class="panel join-invite">
      <Icon name="users" />
      <div>
        <h2>Приглашение: {joinInfo.homeName}</h2>
        <p>Ваша роль — {roles[joinInfo.role]}.</p>
      </div>
      <button
        class="button"
        disabled={busy}
        onClick={async () => {
          try {
            await act('/invites/accept', { token: invite }, 'POST', 'Доступ к дому добавлен.');
            onAccepted();
            window.history.replaceState({}, '', '/');
          } catch {}
        }}
      >
        Принять приглашение
      </button>
    </article>
  );
}
