/**
 * One human, one account.
 *
 * A chat platform mints its own Archon user the first time it sees a sender
 * (`findOrCreateUserByPlatformIdentity`), so the same person arriving from
 * Telegram and from the browser is two users with two halves of a history.
 * Linking moves the platform identity onto the account's user and brings every
 * row the platform user owned with it — nothing is deleted, and the history
 * stays where it can be read.
 *
 * The reverse (unlinking) deliberately does NOT hand the rows back: they were
 * written by the person who is still signed in, and orphaning them would hide
 * conversations from everyone. Unlinking only stops the Telegram sender from
 * being that account; their next message mints a fresh user, as before.
 */

import { pool, getDatabase } from './connection';
import type { IdentityPlatform, User, UserIdentity } from '../types';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.account-links');
  return cachedLog;
}

/** Tables whose `user_id` points at an Archon user and moves with a link. */
const OWNED_BY_USER = [
  'remote_agent_conversations',
  'remote_agent_messages',
  'remote_agent_workflow_runs',
] as const;

export interface LinkedIdentity {
  readonly platform: string;
  readonly platformUserId: string;
  readonly displayName: string | null;
  readonly linkedAt: string | Date | null;
}

/** Every platform identity that resolves to this account's user. */
export async function listIdentitiesForUser(userId: string): Promise<LinkedIdentity[]> {
  const result = await pool.query<{
    platform: string;
    platform_user_id: string;
    platform_display_name: string | null;
    created_at: string | Date | null;
  }>(
    `SELECT platform, platform_user_id, platform_display_name, created_at
       FROM remote_agent_user_identities
      WHERE user_id = $1
      ORDER BY created_at`,
    [userId]
  );
  return result.rows.map(row => ({
    platform: row.platform,
    platformUserId: row.platform_user_id,
    displayName: row.platform_display_name,
    linkedAt: row.created_at,
  }));
}

export interface LinkOutcome {
  /** Rows moved to the account, per table. */
  readonly moved: Record<string, number>;
  /** True when the identity already belonged to this account. */
  readonly alreadyLinked: boolean;
}

/**
 * Point a platform identity at an existing account and bring its history over.
 *
 * Everything happens in one transaction: either the identity and every row it
 * owned belong to the account, or nothing changed. The now-empty user row is
 * removed only when it owns nothing else — a shared or unexpected reference is
 * a reason to leave it alone, not to delete rows.
 */
export async function linkIdentityToUser(
  platform: IdentityPlatform,
  platformUserId: string,
  targetUserId: string
): Promise<LinkOutcome> {
  const db = getDatabase();
  return db.withTransaction(async q => {
    const identityResult = await q<UserIdentity>(
      'SELECT * FROM remote_agent_user_identities WHERE platform = $1 AND platform_user_id = $2',
      [platform, platformUserId]
    );
    const identity = identityResult.rows[0];

    if (identity === undefined) {
      // Never seen this sender: just record the mapping.
      await q(
        `INSERT INTO remote_agent_user_identities (user_id, platform, platform_user_id)
         VALUES ($1, $2, $3)`,
        [targetUserId, platform, platformUserId]
      );
      return { moved: {}, alreadyLinked: false };
    }

    if (identity.user_id === targetUserId) {
      return { moved: {}, alreadyLinked: true };
    }

    const previousUserId = identity.user_id;
    const moved: Record<string, number> = {};
    for (const table of OWNED_BY_USER) {
      const result = await q(`UPDATE ${table} SET user_id = $1 WHERE user_id = $2`, [
        targetUserId,
        previousUserId,
      ]);
      moved[table] = result.rowCount ?? 0;
    }

    await q('UPDATE remote_agent_user_identities SET user_id = $1 WHERE id = $2', [
      targetUserId,
      identity.id,
    ]);

    // Drop the emptied user only when nothing else points at it.
    const remaining = await q<{ count: string }>(
      'SELECT COUNT(*) AS count FROM remote_agent_user_identities WHERE user_id = $1',
      [previousUserId]
    );
    if (Number(remaining.rows[0]?.count ?? '1') === 0) {
      await q('DELETE FROM remote_agent_users WHERE id = $1', [previousUserId]);
    }

    getLog().info(
      { platform, targetUserId, previousUserId, moved },
      'account_link.identity_linked'
    );
    return { moved, alreadyLinked: false };
  });
}

/**
 * Stop a platform identity from resolving to this account. History stays with
 * the account — see the note at the top of this file.
 */
export async function unlinkIdentity(
  platform: IdentityPlatform,
  userId: string
): Promise<{ removed: number }> {
  const result = await pool.query(
    'DELETE FROM remote_agent_user_identities WHERE platform = $1 AND user_id = $2',
    [platform, userId]
  );
  getLog().info(
    { platform, userId, removed: result.rowCount ?? 0 },
    'account_link.identity_unlinked'
  );
  return { removed: result.rowCount ?? 0 };
}

export interface DirectoryUser {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

/**
 * Who has ever written here, for labelling authorship in the console: the
 * Archon user id, the display name it carries, and the email of the web
 * account behind it when there is one.
 *
 * Everyone who can open the console is an administrator of this install, so an
 * email is not a leak here — the moment that stops being true, this is the
 * surface to gate.
 */
export async function listDirectoryUsers(): Promise<DirectoryUser[]> {
  const result = await pool.query<{
    id: string;
    display_name: string | null;
    email: string | null;
  }>(
    // The web account's own name wins when there is one: Profile edits that
    // name (Better Auth owns it), and a label that kept showing the display
    // name captured at sign-up would quietly disagree with the profile the
    // operator just changed.
    `SELECT u.id,
            COALESCE(NULLIF(TRIM(a.name), ''), u.display_name) AS display_name,
            a.email
       FROM remote_agent_users u
       LEFT JOIN remote_agent_user_identities i
              ON i.user_id = u.id AND i.platform = 'web'
       LEFT JOIN remote_agent_auth_user a
              ON a.id = i.platform_user_id
      ORDER BY u.created_at`
  );
  return result.rows.map(row => ({
    id: row.id,
    displayName: row.display_name,
    email: row.email,
  }));
}

/** The web account (if any) behind an Archon user. */
export async function findWebAccountForUser(
  userId: string
): Promise<{ id: string; name: string | null; email: string } | null> {
  const result = await pool.query<{ id: string; name: string | null; email: string }>(
    `SELECT a.id, a.name, a.email
       FROM remote_agent_user_identities i
       JOIN remote_agent_auth_user a ON a.id = i.platform_user_id
      WHERE i.user_id = $1 AND i.platform = 'web'
      LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

/** The Archon user a platform identity currently resolves to, if any. */
export async function findUserByIdentity(
  platform: IdentityPlatform,
  platformUserId: string
): Promise<User | null> {
  const result = await pool.query<User>(
    `SELECT u.* FROM remote_agent_users u
       JOIN remote_agent_user_identities i ON i.user_id = u.id
      WHERE i.platform = $1 AND i.platform_user_id = $2`,
    [platform, platformUserId]
  );
  return result.rows[0] ?? null;
}
