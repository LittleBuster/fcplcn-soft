/** @file Постоянно смонтированные черновики разделов: навигация не уничтожает введённые поля. */
import { useEffect, useState } from 'preact/hooks';
import type { CloudRole, HomeDetail, InvitationView, PairingView } from '../../../shared/api.js';

export function useConnectionDraft(selected: string, detail: HomeDetail | null) {
  const [homeName, setHomeName] = useState('');
  const [pairing, setPairing] = useState<PairingView | null>(null);

  useEffect(() => setPairing(null), [selected]);
  useEffect(() => {
    if (detail) setHomeName(detail.home.name);
  }, [detail?.home.id, detail?.home.name]);

  return { homeName, setHomeName, pairing, setPairing };
}

export function useAccessDraft(selected: string) {
  const [invitation, setInvitation] = useState<InvitationView | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<CloudRole>('operator');
  const [inviteSecurity, setInviteSecurity] = useState(false);

  useEffect(() => setInvitation(null), [selected]);

  return {
    invitation,
    setInvitation,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setInviteRole,
    inviteSecurity,
    setInviteSecurity,
  };
}
