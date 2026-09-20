/**
 * Database operations for conversation messages (Web UI history and orchestrator prompt enrichment)
 */
import { pool, getDatabaseType } from './connection';
import type { MessageRow } from '../schemas/message';
import { formatSqliteTimestamp } from './timestamps';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.messages');
  return cachedLog;
}

export type { MessageRow } from '../schemas/message';

/** The last instant handed out for a row whose time is simply "now". */
let lastNowMs = 0;

/**
 * The instant a row is written at.
 *
 * Milliseconds, computed here rather than by the database, for two reasons.
 * SQLite's `datetime('now')` resolves to whole SECONDS, so the rows of one turn
 * routinely shared a value and the reader's tie-breaker — a RANDOM uuid —
 * decided their order by luck; that is how a question could render above the
 * answer to the one before it. And a platform that tells us when the operator
 * actually pressed send can only say so if the caller, not the database,
 * chooses the instant.
 *
 * The counter makes a tie impossible for "now" rows even when the clock has not
 * ticked between two inserts (an in-memory database answers that fast). A
 * REPORTED send time is used verbatim: it is allowed to be older than rows
 * already written — a message typed mid-turn belongs where it was typed — and
 * nudging it to break a tie would invent an order the platform never gave us.
 */
function nextCreatedAtMs(sentAtMs: number | undefined): number {
  if (sentAtMs !== undefined) return sentAtMs;
  lastNowMs = Math.max(Date.now(), lastNowMs + 1);
  return lastNowMs;
}

/**
 * How one instant is written into `created_at` on each dialect.
 *
 * Postgres gets `to_timestamp(<epoch seconds>)`, which produces a `timestamptz`
 * the column converts using the session time zone — byte-for-byte the path
 * `NOW()` took, so new rows stay comparable with every row written before this.
 * SQLite gets the UTC text `datetime('now')` writes, plus milliseconds, which
 * sorts correctly against the seconds-only values already in the table.
 */
function createdAtSql(ms: number, paramIndex: number): { sql: string; param: string | number } {
  return getDatabaseType() === 'sqlite'
    ? { sql: `$${String(paramIndex)}`, param: formatSqliteTimestamp(ms) }
    : { sql: `to_timestamp($${String(paramIndex)})`, param: ms / 1000 };
}

/** Optional facts about a message that only its origin knows. */
export interface AddMessageOptions {
  /**
   * When the operator actually sent it, in epoch milliseconds, for platforms
   * that report it (Telegram's `ctx.message.date`). Without this a message
   * typed while a turn was running is stamped with the moment it was finally
   * INSERTED — which is why one typed at 13:35 could surface at 13:41, in the
   * wrong place in the history.
   */
  readonly sentAtMs?: number;
}

/**
 * Add a message to conversation history.
 * metadata should contain toolCalls array and/or error object if applicable.
 * userId is the Archon user UUID; pass undefined for assistant messages or
 * when the originating user is unknown.
 */
export async function addMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  metadata?: Record<string, unknown>,
  userId?: string,
  options?: AddMessageOptions
): Promise<MessageRow> {
  const createdAt = createdAtSql(nextCreatedAtMs(options?.sentAtMs), 6);
  const result = await pool.query<MessageRow>(
    `INSERT INTO remote_agent_messages (conversation_id, role, content, metadata, user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, ${createdAt.sql})
     RETURNING *`,
    [conversationId, role, content, JSON.stringify(metadata ?? {}), userId ?? null, createdAt.param]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Failed to persist message: INSERT returned no rows (conversation: ${conversationId})`
    );
  }
  getLog().debug({ conversationId, role, messageId: row.id }, 'db.message_persist_completed');
  return row;
}

/**
 * List messages for a conversation, oldest first.
 * Fetches the newest `limit` messages so that the most recent history is always
 * returned, then reverses to preserve chronological (oldest-first) order.
 * `id DESC` breaks ties between rows sharing a created_at so the LIMIT window
 * is stable across refetches. `addMessage` no longer produces ties — it writes
 * milliseconds and keeps them strictly increasing — but the tie-breaker still
 * earns its place: every row written before that change was stamped at SQLite's
 * one-second granularity, and a random uuid is a stable order, just not a
 * meaningful one. It decides which rows the window holds, never which turn came
 * first. conversationId is the database UUID (not platform_conversation_id).
 */
export async function listMessages(
  conversationId: string,
  limit = 200
): Promise<readonly MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [conversationId, limit]
  );
  return [...result.rows].reverse();
}

/**
 * Get recent messages with workflowResult metadata for a conversation.
 * Used to inject workflow context into the orchestrator prompt.
 * Non-throwing — returns empty array on error.
 */
export async function getRecentWorkflowResultMessages(
  conversationId: string,
  limit = 3
): Promise<readonly MessageRow[]> {
  const dbType = getDatabaseType();
  const metadataFilter =
    dbType === 'postgresql'
      ? "(metadata->>'workflowResult') IS NOT NULL"
      : "json_extract(metadata, '$.workflowResult') IS NOT NULL";
  try {
    const result = await pool.query<Pick<MessageRow, 'id' | 'content' | 'metadata'>>(
      `SELECT id, content, metadata FROM remote_agent_messages
       WHERE conversation_id = $1
       AND ${metadataFilter}
       -- id DESC tie-breaker: see listMessages() above for why.
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [conversationId, limit]
    );
    return result.rows as MessageRow[];
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, conversationId }, 'db.workflow_result_messages_query_failed');
    return [];
  }
}
