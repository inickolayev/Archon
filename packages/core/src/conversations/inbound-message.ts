/**
 * Writing down what the operator said, the moment it arrives.
 *
 * A message that lands while a turn is running is held in memory by the
 * conversation lock — unpersisted, unannounced — until that turn ends and the
 * queued handler finally runs. Only then is a row written, stamped `now()`. So
 * a line typed at 13:35 could appear in the console at 13:41, in the wrong
 * place, with nothing in between to show it had even been received.
 *
 * Persisting at ingest fixes both halves at once: the row exists before the
 * lock is ever taken, and it carries the time the PLATFORM says the operator
 * pressed send rather than the time we got around to inserting it.
 *
 * Nothing here decides whether the message earns a turn. It is the operator's
 * message either way, and every path that declines a turn declines it by
 * SAYING so — and those answers are persisted too — so a row written here can
 * never be left without a reply beside it.
 */

import { createLogger } from '@archon/paths';
import * as conversationDb from '../db/conversations';
import * as messageDb from '../db/messages';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('inbound-message');
  return cachedLog;
}

export interface InboundMessage {
  readonly platformType: string;
  /** The platform's conversation id — `<chat id>[:<n>]` for Telegram. */
  readonly platformConversationId: string;
  readonly text: string;
  /** Archon user UUID, when the adapter resolved one. */
  readonly userId?: string;
  /**
   * When the operator pressed send, epoch milliseconds, for platforms that
   * report it. Omitted, the row is stamped with the insert time as before.
   */
  readonly sentAtMs?: number;
  /** Attachment descriptions, shaped as the web upload route writes them. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Persist an inbound message and answer whether it landed.
 *
 * NEVER THROWS. A history write that fails must not cost the operator their
 * message: the caller carries on into the turn, and `handleMessage` is told the
 * row is missing so it can write one itself at its own, later point — the
 * behaviour before any of this existed.
 */
export async function persistInboundMessage(inbound: InboundMessage): Promise<boolean> {
  try {
    // Resolves the same row `handleMessage` will resolve a moment later, by the
    // same call: a conversation is adopted across platforms, never forked, so
    // asking twice costs a lookup and changes nothing.
    const conversation = await conversationDb.getOrAdoptConversation(
      inbound.platformType,
      inbound.platformConversationId,
      undefined,
      undefined,
      inbound.userId
    );
    await messageDb.addMessage(
      conversation.id,
      'user',
      inbound.text,
      inbound.metadata,
      inbound.userId,
      inbound.sentAtMs === undefined ? undefined : { sentAtMs: inbound.sentAtMs }
    );
    return true;
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    getLog().warn(
      {
        err,
        errorType: err.constructor.name,
        conversationId: inbound.platformConversationId,
      },
      'inbound_message.persist_failed'
    );
    return false;
  }
}
