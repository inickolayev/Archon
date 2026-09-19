import { requestJson } from '../lib/http';
import type { Directory } from '../primitives/author';

/**
 * The signed-in account, its linked external sources, and everyone who has
 * written here. Better Auth owns sign-in, sign-up, the password and the
 * profile fields; Archon owns platform identities and the authorship
 * directory, so both are called from here.
 */

export interface LinkedIdentity {
  platform: string;
  platformUserId: string;
  displayName: string | null;
  linkedAt: string | null;
}

export interface Account {
  userId: string;
  role: string;
  name: string | null;
  email: string | null;
  identities: LinkedIdentity[];
}

export async function getAccount(): Promise<Account> {
  return requestJson<Account>('/api/auth/me');
}

/** Everyone who has written here, plus which of them is me. */
export async function getDirectory(): Promise<Directory> {
  const raw = await requestJson<{
    me: string;
    users: { id: string; displayName: string | null; email: string | null }[];
  }>('/api/users/directory');
  return { me: raw.me, users: raw.users };
}

/** Better Auth's own profile update — the name shown next to "you". */
export async function updateName(name: string): Promise<void> {
  await requestJson('/api/auth/update-user', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/**
 * Better Auth's own password change. `revokeOtherSessions` is deliberately
 * false: changing a password must not sign the operator out of the window they
 * are typing in.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await requestJson('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: false }),
  });
}

/**
 * End the session server-side. Archon's own endpoint rather than Better
 * Auth's, because signing out also drops every pending one-time link token.
 */
export async function signOut(): Promise<void> {
  await requestJson('/api/auth/me/sign-out', { method: 'POST' });
}

/** What a one-time Telegram link would connect, before anything is changed. */
export interface LinkPreview {
  telegram: { displayName: string | null };
  account: { name: string | null; email: string | null };
  alreadyLinkedToThisAccount: boolean;
  expiresAt: string;
}

export async function previewTelegramLink(token: string): Promise<LinkPreview> {
  return requestJson<LinkPreview>(`/api/auth/telegram/link/${encodeURIComponent(token)}`);
}

export async function confirmTelegramLink(
  token: string
): Promise<{ linked: boolean; alreadyLinked: boolean; movedRows: number; email: string | null }> {
  return requestJson(`/api/auth/telegram/link/${encodeURIComponent(token)}`, { method: 'POST' });
}

export async function unlinkTelegram(): Promise<{ removed: number }> {
  return requestJson('/api/auth/me/identities/telegram', { method: 'DELETE' });
}
