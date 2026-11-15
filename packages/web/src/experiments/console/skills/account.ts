import { requestJson } from '../lib/http';
import { authClient } from '@/lib/auth-client';
import type { components } from '@/lib/api.generated';
import type { Directory } from '../primitives/author';

/**
 * The signed-in account, its linked external sources, and everyone who has
 * written here. Better Auth owns sign-in, sign-up, the password and the
 * profile fields; Archon owns platform identities and the authorship
 * directory, so both are called from here.
 */

export type LinkedIdentity = components['schemas']['LinkedIdentity'];
export type Account = components['schemas']['AccountMeResponse'];

export async function getAccount(): Promise<Account> {
  return requestJson('/api/auth/me', 'get');
}

/** Everyone who has written here, plus which of them is me. */
export async function getDirectory(): Promise<Directory> {
  const raw = await requestJson('/api/users/directory', 'get');
  return { me: raw.me, users: raw.users };
}

/**
 * Better Auth's client answers `{ data, error }` instead of throwing. Its
 * endpoints are not Archon's, so they are not in the generated API either;
 * this turns a refusal into the thrown error every caller here already handles.
 */
function throwOnAuthError(
  result: { error: { message?: string; statusText: string } | null },
  fallback: string
): void {
  if (result.error === null) return;
  const message = result.error.message?.trim() ?? '';
  throw new Error(message.length > 0 ? message : `${fallback} (${result.error.statusText})`);
}

/** Better Auth's own profile update — the name shown next to "you". */
export async function updateName(name: string): Promise<void> {
  throwOnAuthError(await authClient.updateUser({ name }), 'Could not save the name');
}

/**
 * Better Auth's own password change. `revokeOtherSessions` is deliberately
 * false: changing a password must not sign the operator out of the window they
 * are typing in.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  throwOnAuthError(
    await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: false }),
    'Could not change the password'
  );
}

/**
 * End the session server-side. Archon's own endpoint rather than Better
 * Auth's, because signing out also drops every pending one-time link token.
 */
export async function signOut(): Promise<void> {
  await requestJson('/api/auth/me/sign-out', 'post');
}

/** What a one-time Telegram link would connect, before anything is changed. */
export type LinkPreview = components['schemas']['TelegramLinkPreview'];

export async function previewTelegramLink(token: string): Promise<LinkPreview> {
  return requestJson('/api/auth/telegram/link/{token}', 'get', { params: { token } });
}

export async function confirmTelegramLink(
  token: string
): Promise<components['schemas']['TelegramLinkResult']> {
  return requestJson('/api/auth/telegram/link/{token}', 'post', { params: { token } });
}

export async function unlinkTelegram(): Promise<components['schemas']['UnlinkIdentityResponse']> {
  return requestJson('/api/auth/me/identities/{platform}', 'delete', {
    params: { platform: 'telegram' },
  });
}
