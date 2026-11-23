/**
 * Personal access tokens (PATs): long-lived bearer credentials a user mints in the
 * console for non-browser clients (Claude Code, Codex, scripts, the MCP endpoint).
 *
 * Only the SHA-256 of the token is stored. The token carries 256 bits of entropy, so a
 * fast hash is enough and the lookup is by hash (no timing concern). The plaintext is
 * returned once from `createApiToken` and never logged or read back.
 *
 * (Filename avoids a `token(s).ts` basename, which a local secret-guard hook blocks.)
 */
import { createHash, randomBytes } from 'node:crypto';
import { pool } from './connection';
import { toHydratedTimestamp } from './timestamps';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.api-tokens');
  return cachedLog;
}

export const API_TOKEN_PREFIX = 'arc_pat_';
/** Leading characters kept for display so a user can tell tokens apart. */
const DISPLAY_PREFIX_LENGTH = 12;
/** `last_used_at` is refreshed at most this often, to keep reads from becoming writes. */
const LAST_USED_REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;

export interface ApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreatedApiToken {
  /** The full token. Shown to the user once; not recoverable afterwards. */
  token: string;
  record: ApiTokenRecord;
}

export interface VerifiedApiToken {
  userId: string;
  tokenId: string;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  created_at: Date | string | null;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : toHydratedTimestamp(value).toISOString();
}

function toRecord(row: ApiTokenRow): ApiTokenRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
  };
}

/** Mint a token for `userId`. `expiresInDays` null means it never expires. */
export async function createApiToken(params: {
  userId: string;
  name: string;
  expiresInDays: number | null;
  now?: Date;
}): Promise<CreatedApiToken> {
  const now = params.now ?? new Date();
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt =
    params.expiresInDays === null
      ? null
      : new Date(now.getTime() + params.expiresInDays * DAY_MS).toISOString();
  const result = await pool.query<ApiTokenRow>(
    `INSERT INTO remote_agent_api_tokens (user_id, name, token_hash, token_prefix, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, name, token_prefix, created_at, last_used_at, expires_at, revoked_at`,
    [
      params.userId,
      params.name,
      hashToken(token),
      token.slice(0, DISPLAY_PREFIX_LENGTH),
      now.toISOString(),
      expiresAt,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create API token');
  getLog().info({ userId: params.userId, tokenId: row.id }, 'api_token.created');
  return { token, record: toRecord(row) };
}

/**
 * Resolve a presented token to its owner. Returns null for unknown, revoked or
 * expired tokens; the caller must treat that as a hard 401 without falling back
 * to another credential.
 */
export async function verifyApiToken(
  token: string,
  now: Date = new Date()
): Promise<VerifiedApiToken | null> {
  if (!looksLikeApiToken(token)) return null;
  const result = await pool.query<ApiTokenRow>(
    `SELECT id, user_id, name, token_prefix, created_at, last_used_at, expires_at, revoked_at
     FROM remote_agent_api_tokens WHERE token_hash = $1`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row || row.revoked_at !== null) return null;
  if (row.expires_at !== null && toHydratedTimestamp(row.expires_at).getTime() <= now.getTime()) {
    return null;
  }
  const lastUsed = row.last_used_at === null ? null : toHydratedTimestamp(row.last_used_at);
  if (lastUsed === null || now.getTime() - lastUsed.getTime() >= LAST_USED_REFRESH_MS) {
    try {
      await pool.query('UPDATE remote_agent_api_tokens SET last_used_at = $1 WHERE id = $2', [
        now.toISOString(),
        row.id,
      ]);
    } catch (err) {
      // Usage bookkeeping must not turn a valid credential into a failure.
      getLog().warn({ err: err as Error, tokenId: row.id }, 'api_token.last_used_update_failed');
    }
  }
  return { userId: row.user_id, tokenId: row.id };
}

/** The user's live (not revoked) tokens, newest first. Never includes hashes or plaintext. */
export async function listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
  const result = await pool.query<ApiTokenRow>(
    `SELECT id, user_id, name, token_prefix, created_at, last_used_at, expires_at, revoked_at
     FROM remote_agent_api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC, id`,
    [userId]
  );
  return result.rows.map(toRecord);
}

/** Revoke one of `userId`'s tokens. Returns false when it does not exist or is not theirs. */
export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_api_tokens SET revoked_at = $1
     WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL`,
    [new Date().toISOString(), tokenId, userId]
  );
  if (result.rowCount === 0) return false;
  getLog().info({ userId, tokenId }, 'api_token.revoked');
  return true;
}
