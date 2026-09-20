/**
 * Writing down what the agent said, as it says it.
 *
 * On every platform but the browser the whole turn used to be persisted as ONE
 * row, joined together and written after the last chunk. So while Telegram was
 * receiving bubble after bubble the console showed nothing at all, and then a
 * single wall of text landed at the end, stamped with the moment the turn
 * finished rather than the moments its parts were delivered.
 *
 * The web adapter already had the right shape — `MessagePersistence.flush`
 * writes one row per segment — and it is the `!isWebAdapter` guard that kept
 * the two halves from double-writing (#1182). This is the other half: wrap the
 * adapter so each DELIVERED message becomes a row. For a streaming adapter
 * each `sendMessage` call is one bubble on the phone, so one row per call is
 * not an approximation of what the operator saw; it is what the operator saw.
 *
 * Two consequences worth stating, because both were previously absent rather
 * than chosen. Refusals and command answers now land in the history too — every
 * path that declines a turn does so by sending a message, so the row the turn's
 * inbound message wrote can never end up alone. And `workflowResult` metadata
 * now rides the row, which is what `getRecentWorkflowResultMessages` reads, so
 * a chat outside the browser finally gets follow-up context about its own runs.
 */

import { createLogger } from '@archon/paths';
import type { IPlatformAdapter, MessageMetadata } from '../types';
import * as messageDb from '../db/messages';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('outbound-persistence');
  return cachedLog;
}

/**
 * Categories the console draws as structure rather than as something somebody
 * reads — a tool-call row, the isolation banner. The web persistence buffer and
 * the Telegram adapter refuse the same set; a row for one of these would be a
 * chat message full of absolute host paths.
 */
const STRUCTURAL_CATEGORIES = new Set(['tool_call_formatted', 'isolation_context']);

/** The metadata a persisted assistant row carries, mirroring the web buffer's. */
function rowMetadata(metadata: MessageMetadata | undefined): Record<string, unknown> | undefined {
  const row = {
    ...(metadata?.category ? { category: metadata.category } : {}),
    ...(metadata?.workflowDispatch ? { workflowDispatch: metadata.workflowDispatch } : {}),
    ...(metadata?.workflowResult ? { workflowResult: metadata.workflowResult } : {}),
  };
  return Object.keys(row).length > 0 ? row : undefined;
}

/**
 * Wrap an adapter so every message it delivers is also written to the
 * conversation's history, in delivery order.
 *
 * Delivery happens FIRST and the write can never fail it (#1182): a database
 * that is down must cost the operator their history, not their answer. The
 * write is awaited rather than fired and forgotten, and chained onto the
 * previous one, so two rows can never land in the wrong order — the reader
 * breaks ties on a random uuid, so "roughly in order" is not an order at all.
 *
 * A Proxy rather than a hand-written adapter, for the same reason
 * `withOutboundMirror` is one: the orchestrator calls optional,
 * platform-specific members, and forwarding everything by construction is the
 * only version of this that cannot silently lose one of them.
 */
export function withPersistedOutbound<T extends IPlatformAdapter>(
  primary: T,
  conversationDbId: string
): T {
  let tail: Promise<void> = Promise.resolve();

  const persist = (message: string, metadata?: MessageMetadata): Promise<void> => {
    tail = tail.then(async () => {
      try {
        await messageDb.addMessage(conversationDbId, 'assistant', message, rowMetadata(metadata));
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        getLog().warn(
          { err, errorType: err.constructor.name, conversationDbId },
          'orchestrator.assistant_message_persist_failed'
        );
      }
    });
    return tail;
  };

  return new Proxy(primary, {
    get(target, prop, _receiver): unknown {
      if (prop === 'sendMessage') {
        // Spread rather than three named parameters: an adapter is free to look
        // at `arguments.length`, and a wrapper that turned every two-argument
        // send into a three-argument one would be changing the call it forwards.
        return async (...args: Parameters<IPlatformAdapter['sendMessage']>): Promise<void> => {
          await target.sendMessage(...args);
          const [, message, metadata] = args;
          if (message.trim().length === 0) return;
          if (metadata?.category !== undefined && STRUCTURAL_CATEGORIES.has(metadata.category)) {
            return;
          }
          await persist(message, metadata);
        };
      }
      // Bind to the target, not the proxy: adapters are classes with private
      // fields, which throw when accessed through a proxy receiver.
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
