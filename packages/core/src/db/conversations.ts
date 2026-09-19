/**
 * Database operations for conversations
 */
import { pool, getDatabaseType, getDialect } from './connection';
import type { Conversation } from '../types';
import { ConversationNotFoundError } from '../types';
import { createLogger } from '@archon/paths';
import { loadConfig } from '../config/config-loader';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.conversations');
  return cachedLog;
}

/**
 * Get a conversation by its database ID
 */
export async function getConversationById(id: string): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Find a conversation by platform_conversation_id only (no platform_type filter).
 * Safe because all platform IDs are globally unique (they include platform prefix + timestamp + random).
 * Used by the Web UI API to load conversations from any platform.
 */
export async function findConversationByPlatformId(
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1',
    [platformId]
  );
  return result.rows[0] ?? null;
}

/**
 * Get a conversation by platform type and platform ID
 * Returns null if not found (unlike getOrCreate which creates)
 */
export async function getConversationByPlatformId(
  platformType: string,
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );
  return result.rows[0] ?? null;
}

export async function getOrCreateConversation(
  platformType: string,
  platformId: string,
  codebaseId?: string,
  parentConversationId?: string,
  userId?: string
): Promise<Conversation> {
  const existing = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );

  if (existing.rows[0]) {
    // First-user-wins: do not overwrite user_id on subsequent messages in the
    // same thread from a different user. Per-message attribution lives on
    // workflow_runs/messages instead.
    return existing.rows[0];
  }

  // Check if we should inherit from a parent conversation (e.g., Discord thread inheriting from parent channel)
  let inheritedCodebaseId: string | null = null;
  let inheritedCwd: string | null = null;
  let assistantType: string | undefined;

  if (parentConversationId) {
    const parent = await pool.query<Conversation>(
      'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
      [platformType, parentConversationId]
    );
    if (parent.rows[0]) {
      inheritedCodebaseId = parent.rows[0].codebase_id;
      inheritedCwd = parent.rows[0].cwd;
      assistantType = parent.rows[0].ai_assistant_type;
      getLog().debug(
        { inheritedCodebaseId, inheritedCwd },
        'db.conversation_parent_context_inherited'
      );
    }
  }

  // Use provided codebase or inherited codebase
  const finalCodebaseId = codebaseId ?? inheritedCodebaseId;

  // Determine assistant type from codebase if provided (overrides inherited)
  if (codebaseId) {
    const codebase = await pool.query<{ ai_assistant_type: string }>(
      'SELECT ai_assistant_type FROM remote_agent_codebases WHERE id = $1',
      [codebaseId]
    );
    if (codebase.rows[0]) {
      assistantType = codebase.rows[0].ai_assistant_type;
    }
  }

  // No parent or codebase signal: resolve the configured default assistant
  // instead of hard-defaulting to Claude (#2241). loadConfig() owns the
  // fallback chain — explicit config (repo assistant > global defaultAssistant)
  // > DEFAULT_AI_ASSISTANT env > first registered built-in provider. The
  // per-user default assistant (#1998) deliberately stays OUT of this row: the
  // orchestrator applies it per turn (userAiPrefs.defaultProvider ??
  // conversation.ai_assistant_type), sender-first (#1982), so a personal
  // preference is never baked into a shared conversation.
  if (assistantType === undefined) {
    try {
      const config = await loadConfig();
      assistantType = config.assistant;
    } catch (err) {
      // Intentional fallback: a broken config (e.g. an unregistered
      // DEFAULT_AI_ASSISTANT value makes loadConfig throw) must not block
      // conversation creation — the turn itself surfaces config errors.
      getLog().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'db.conversation_default_assistant_config_load_failed'
      );
    }
  }
  assistantType ??= 'claude';

  const created = await pool.query<Conversation>(
    'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [platformType, platformId, assistantType, finalCodebaseId, inheritedCwd, userId ?? null]
  );

  return created.rows[0];
}

/**
 * The conversation this turn belongs to, adopting a row that was born on
 * another platform instead of forking a twin.
 *
 * A conversation is not owned by the platform it started on: the web console
 * can continue a Telegram-born chat, and then `handleMessage` runs with the
 * web adapter while `platform_conversation_id` still names a Telegram
 * conversation. Looking it up by (platform_type, platform_conversation_id)
 * alone would miss it and INSERT a second row with the same platform id under
 * `web` — two half-conversations, one history each.
 *
 * Platform ids are globally unique in practice (the web API has relied on that
 * in `findConversationByPlatformId` since before this), so a row found under a
 * different platform type is the same conversation, not a collision.
 */
export async function getOrAdoptConversation(
  platformType: string,
  platformId: string,
  codebaseId?: string,
  parentConversationId?: string,
  userId?: string
): Promise<Conversation> {
  const samePlatform = await getConversationByPlatformId(platformType, platformId);
  if (samePlatform) return samePlatform;

  const otherPlatform = await findConversationByPlatformId(platformId);
  if (otherPlatform) {
    getLog().debug(
      {
        platformId,
        deliveringAs: platformType,
        conversationPlatform: otherPlatform.platform_type,
      },
      'db.conversation_adopted_across_platforms'
    );
    return otherPlatform;
  }

  return getOrCreateConversation(
    platformType,
    platformId,
    codebaseId,
    parentConversationId,
    userId
  );
}

export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'isolation_env_id'>> & {
    hidden?: boolean;
  }
): Promise<void> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  if (updates.cwd !== undefined) {
    fields.push(`cwd = $${String(i++)}`);
    values.push(updates.cwd);
  }
  if (updates.isolation_env_id !== undefined) {
    fields.push(`isolation_env_id = $${String(i++)}`);
    values.push(updates.isolation_env_id);
  }
  if (updates.hidden !== undefined) {
    fields.push(`hidden = $${String(i++)}`);
    values.push(updates.hidden ? 1 : 0);
  }

  if (fields.length === 0) {
    return; // No updates
  }

  const dialect = getDialect();
  fields.push(`updated_at = ${dialect.now()}`);
  values.push(id);

  const result = await pool.query(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${String(i)}`,
    values
  );

  if (result.rowCount === 0) {
    getLog().error({ conversationId: id, fields, updates }, 'db.conversation_update_not_found');
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Find a conversation by isolation environment ID (legacy - single result)
 * Used for provider-based lookup and shared environment detection
 */
export async function getConversationByIsolationEnvId(envId: string): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1 LIMIT 1',
    [envId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find all conversations using a specific isolation environment (new UUID model)
 */
export async function getConversationsByIsolationEnvId(
  envId: string
): Promise<readonly Conversation[]> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows;
}

/**
 * List all conversations ordered by recent activity
 */
export async function listConversations(
  limit = 50,
  platformType?: string,
  codebaseId?: string,
  excludeEmpty = false,
  /**
   * Non-enforcing "mine" filter: when set, restrict to conversations attributed
   * to this user (`user_id = $N`). Absent → all (default visibility stays open).
   */
  userId?: string
): Promise<readonly Conversation[]> {
  const params: unknown[] = [];
  let sql =
    'SELECT * FROM remote_agent_conversations WHERE deleted_at IS NULL AND (hidden IS NULL OR hidden = false)';

  if (excludeEmpty) {
    sql +=
      ' AND (title IS NOT NULL OR EXISTS (SELECT 1 FROM remote_agent_messages WHERE conversation_id = remote_agent_conversations.id LIMIT 1))';
  }

  if (platformType) {
    params.push(platformType);
    sql += ` AND platform_type = $${String(params.length)}`;
  }

  if (codebaseId) {
    params.push(codebaseId);
    sql += ` AND codebase_id = $${String(params.length)}`;
  }

  if (userId) {
    params.push(userId);
    sql += ` AND user_id = $${String(params.length)}`;
  }

  sql += ' ORDER BY last_activity_at DESC NULLS LAST';
  params.push(limit);
  sql += ` LIMIT $${String(params.length)}`;

  const result = await pool.query<Conversation>(sql, params);
  return result.rows;
}

/**
 * Every conversation of one chat of a platform — the rows addressed as
 * `<chat id>` (legacy) or `<chat id>:<n>`. Used by the Telegram front end,
 * where a chat holds many conversations and the most recently active one is
 * the one a new message belongs to.
 *
 * The chat id is matched exactly or as a `<chat id>:` prefix, so chat 123 can
 * never pick up chat 1234's rows.
 */
export async function listConversationsForChat(
  platformType: string,
  chatId: string
): Promise<readonly Conversation[]> {
  const result = await pool.query<Conversation>(
    `SELECT * FROM remote_agent_conversations
      WHERE platform_type = $1
        AND (platform_conversation_id = $2 OR platform_conversation_id LIKE $3)
        AND deleted_at IS NULL
      ORDER BY last_activity_at DESC NULLS LAST`,
    [platformType, chatId, `${chatId}:%`]
  );
  return result.rows;
}

/**
 * `YYYY-MM-DD HH:MM:SS.mmm` in UTC — the shape SQLite's `datetime('now')`
 * writes, plus milliseconds, so the two compare correctly both in SQL and
 * after parsing.
 */
export function formatSqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Make a conversation the most recently active one of its chat — this is what
 * a Telegram `/switch` does, and there is no "active" column to set.
 *
 * `notBeforeMs` is the newest activity among the chat's other conversations:
 * the write lands strictly after it, so a switch is never a tie it could lose.
 * That matters because SQLite's `datetime('now')` resolves to whole seconds —
 * a switch made in the same second as the previous turn silently did nothing —
 * and two writes can share a millisecond anyway. Postgres keeps using `now()`
 * (microseconds, and a foreign timestamp string would carry timezone risk).
 *
 * `updated_at` moves with `last_activity_at`: the pair is what breaks a tie for
 * readers that only see whole seconds.
 */
export async function markConversationActive(id: string, notBeforeMs?: number): Promise<void> {
  if (getDatabaseType() === 'sqlite') {
    const at = formatSqliteTimestamp(Math.max(Date.now(), (notBeforeMs ?? 0) + 1));
    await pool.query(
      'UPDATE remote_agent_conversations SET last_activity_at = $2, updated_at = $2 WHERE id = $1',
      [id, at]
    );
    return;
  }
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_conversations SET last_activity_at = ${dialect.now()}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}

/**
 * Update last_activity_at for staleness tracking
 */
export async function touchConversation(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_conversations SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}

/**
 * Update conversation title
 */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET title = $1, updated_at = ${dialect.now()} WHERE id = $2`,
    [title, id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Soft delete a conversation (sets deleted_at timestamp)
 */
export async function softDeleteConversation(id: string): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET deleted_at = ${dialect.now()}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}
