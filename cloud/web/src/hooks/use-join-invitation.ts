/** @file Просмотр приглашения уже вошедшим пользователем; выдача доступа остаётся явным действием. */
import { useEffect, useState } from 'preact/hooks';
import type { CloudRole } from '../../../shared/api.js';
import type { Notice } from '../app/types';
import { api } from '../api';
import { failure } from '../lib/presentation';

export function invitationToken() {
  return (
    new URLSearchParams(window.location.search).get('invite') ||
    /^\/invite\/([a-zA-Z0-9_-]{20,160})\/?$/.exec(window.location.pathname)?.[1] ||
    ''
  );
}

export function useJoinInvitation(
  authenticated: boolean,
  invite: string,
  onNotice: (notice: Notice) => void,
) {
  const [joinInfo, setJoinInfo] = useState<{ homeName: string; role: CloudRole } | null>(null);

  useEffect(() => {
    if (authenticated && invite)
      void api<{ homeName: string; role: CloudRole }>('/invites/' + encodeURIComponent(invite))
        .then(setJoinInfo)
        .catch((error) => onNotice({ kind: 'error', text: failure(error) }));
  }, [authenticated, invite]);

  return { joinInfo, setJoinInfo };
}
