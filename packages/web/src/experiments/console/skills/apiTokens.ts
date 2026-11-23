import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

/**
 * Personal API tokens for non-browser clients (Claude Code, Codex, scripts, MCP).
 * Minting and revoking need a browser session; a 401/403 on the list means this
 * install or caller cannot manage tokens, which the panel reads as "hide".
 */

export type ApiToken = components['schemas']['ApiToken'];
export type CreatedApiToken = components['schemas']['CreateApiTokenResponse'];

/** Days until expiry; `null` mints a token that never expires. */
export type ApiTokenExpiryDays = components['schemas']['CreateApiTokenBody']['expiresInDays'];

export async function listApiTokens(): Promise<ApiToken[]> {
  return (await requestJson('/api/me/tokens', 'get')).tokens;
}

export function createApiToken(
  name: string,
  expiresInDays: ApiTokenExpiryDays
): Promise<CreatedApiToken> {
  return requestJson('/api/me/tokens', 'post', { body: { name, expiresInDays } });
}

export async function revokeApiToken(id: string): Promise<void> {
  await requestJson('/api/me/tokens/{id}', 'delete', { params: { id } });
}
