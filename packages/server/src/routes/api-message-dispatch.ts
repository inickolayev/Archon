import { unlink } from 'fs/promises';
import {
  handleMessage,
  isTelegramConversationId,
  type AttachedFile,
  type ConversationLockManager,
  type HandleMessageContext,
  type IPlatformAdapter,
} from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import { MirrorBuffer, withOutboundMirror } from '../adapters/mirror';
import type { WebAdapter } from '../adapters/web';
import { getLog } from './api-route-kit';

/**
 * The Telegram adapter, read at delivery time rather than captured at
 * registration: routes are registered before the HTTP listener starts and
 * Telegram starts after it, so a value taken then would always be null.
 */
export type TelegramAdapterSource = () => IPlatformAdapter | null;

/**
 * The Telegram adapter to mirror this conversation's replies to, or null when
 * the conversation is not Telegram-born (or the bot is not running).
 */
async function resolveTelegramMirror(
  conversationId: string,
  getTelegramAdapter: TelegramAdapterSource | undefined
): Promise<{ adapter: IPlatformAdapter; buffer: MirrorBuffer } | null> {
  const adapter = getTelegramAdapter?.() ?? null;
  if (adapter === null || !isTelegramConversationId(conversationId)) return null;
  try {
    const conversation = await conversationDb.findConversationByPlatformId(conversationId);
    if (conversation?.platform_type !== 'telegram') return null;
  } catch (error) {
    getLog().warn({ err: error, conversationId }, 'telegram_mirror.lookup_failed');
    return null;
  }
  return { adapter, buffer: new MirrorBuffer() };
}

// Shared lock/dispatch/error handling for message and workflow endpoints

export function createOrchestratorDispatch(
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager,
  getTelegramAdapter?: TelegramAdapterSource
) {
  return async function dispatchToOrchestrator(
    conversationId: string,
    message: string,
    extraContext: Omit<HandleMessageContext, 'isolationHints'>,
    filesToCleanup?: AttachedFile[]
  ): Promise<{ accepted: boolean; status: string }> {
    // A conversation born in Telegram is answered in Telegram too, even when
    // the question was typed in the browser — the person on the phone must not
    // be left staring at their own unanswered message. The web delivery is
    // unconditional; the mirror is best effort and only ever logged.
    const telegramMirror = await resolveTelegramMirror(conversationId, getTelegramAdapter);

    const result = await lockManager.acquireLock(conversationId, async () => {
      // Emit lock:true at handler start so the UI knows processing has begun.
      // Fire-and-forget — if no SSE stream is connected yet, the event is buffered.
      webAdapter.emitLockEvent(conversationId, true);
      try {
        const deliverTo =
          telegramMirror === null
            ? webAdapter
            : withOutboundMirror(webAdapter, (text, metadata) => {
                telegramMirror.buffer.capture(text, metadata);
              });
        await handleMessage(deliverTo, conversationId, message, {
          isolationHints: { workflowType: 'thread', workflowId: conversationId },
          ...extraContext,
        });
      } catch (error) {
        getLog().error({ err: error, conversationId }, 'handle_message_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'error',
              message: `Failed to process message: ${(error as Error).message ?? 'unknown error'}. Try /reset if the problem persists.`,
              classification: 'transient',
              timestamp: Date.now(),
            })
          );
        } catch (sseError) {
          getLog().error({ err: sseError, conversationId }, 'sse_error_emit_failed');
        }
      } finally {
        // Flush after the turn, not per chunk: streaming sends the answer one
        // delta at a time and a phone should get one message, not fifty.
        if (telegramMirror !== null) {
          for (const mirrored of telegramMirror.buffer.take()) {
            try {
              await telegramMirror.adapter.sendMessage(conversationId, mirrored.text);
            } catch (mirrorError) {
              // Never fails the web answer — it is already delivered.
              getLog().error(
                { err: mirrorError, conversationId },
                'telegram_mirror.delivery_failed'
              );
            }
          }
        }
        await webAdapter.emitLockEvent(conversationId, false);
        // Clean up uploaded files AFTER handleMessage completes so the AI subprocess
        // has had a chance to read them. Doing this in the HTTP handler's finally block
        // would delete files while the fire-and-forget lock handler is still running.
        // The directory is shared with uploads that have not written their first file yet.
        if (filesToCleanup) {
          for (const f of filesToCleanup) {
            await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') {
                getLog().warn({ err, filePath: f.path, conversationId }, 'upload.cleanup_failed');
              }
            });
          }
        }
      }
    });

    if (result.status === 'queued-conversation' || result.status === 'queued-capacity') {
      // Intentionally fire-and-forget: the lock-acquire signal (locked: true) is sent
      // optimistically so the UI shows a queued state immediately. It is not awaited
      // because we want the HTTP response to return before the SSE write completes.
      // The lock-release signal (locked: false) IS awaited inside the task callback
      // above to guarantee ordering — all tool results and flush must precede the
      // release event on the SSE stream.
      webAdapter.emitLockEvent(conversationId, true);
    }

    return { accepted: true, status: result.status };
  };
}

export type OrchestratorDispatch = ReturnType<typeof createOrchestratorDispatch>;
