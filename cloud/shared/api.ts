/** @file Public FCPLCn cloud contracts. Credentials and hub broker keys never enter views. */
export type CloudRole = 'owner' | 'operator' | 'viewer';
export interface CloudUser {
  id: string;
  username: string;
  email: string | null;
  name: string;
  totpEnabled: boolean;
}
export interface CloudSession {
  authenticated: boolean;
  setupRequired: boolean;
  product: { name: string; fullName: string; id: string };
  user: CloudUser | null;
  csrfToken: string | null;
}
export interface HomeView {
  id: string;
  name: string;
  role: CloudRole;
  securityControl: boolean;
}
export interface MemberView {
  userId: string;
  username: string;
  email: string | null;
  name: string;
  role: CloudRole;
  securityControl: boolean;
}
export interface HubView {
  id: string;
  homeId: string;
  name: string;
  revoked: boolean;
  online: boolean;
  lastSeenAt: string | null;
}
export interface HomeDetail {
  home: HomeView;
  members: MemberView[];
  hubs: HubView[];
}
export interface CloudAudit {
  id: string;
  at: string;
  actorName: string;
  operation: string;
  target: string;
  status: string;
  detail: string | null;
}
export interface InvitationView {
  token: string;
  url: string;
  expiresAt: string;
}
export interface PairingView {
  code: string;
  expiresAt: string;
}
export interface TOTPSetup {
  secret: string;
  uri: string;
}

/** API surface used by the independent cloud shell; /homes/:id/hub/* mirrors the local panel. */
export const cloudRoutes = {
  session: '/session',
  homes: '/homes',
  setup: '/auth/setup',
  login: '/auth/login',
  logout: '/auth/logout',
  acceptInvite: '/invites/accept',
} as const;
