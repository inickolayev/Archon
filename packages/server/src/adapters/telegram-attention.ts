/**
 * ChessWin fork (chesswin-factory ADR 0011 §6, issue #32): the bundled Telegram adapter as a
 * destination of the engine's attention router.
 *
 * Upstream routes pauses and ends only to web push and chat plugins; our Telegram is the
 * bundled adapter (media, buttons, several chats per project), not a plugin. This destination
 * gives it the same feed — every run, whoever started it: the CLI, the nightly timer, the
 * console or a chat — and sends each notice to the chats that should hear it
 * (`telegramRecipients`): the run's author in the Telegram linked to their account, the chat
 * that started the run, the chats watching it, and — for a run nobody started — the chats
 * watching all such runs. No chat is configured: a person is found through their account.
 */
import { listIdentitiesForUser } from '@archon/core/db/account-links';
import { getDatabase } from '@archon/core/db/connection';
import { getConversationById } from '@archon/core/db/conversations';
import {
  hasAnyAttentionNotice,
  listAttentionNotices,
  type AttentionNoticeRecord,
} from '@archon/core/db/workflow-events';
import { parseTelegramConversationId } from '@archon/core';
import { listAllRunsWatchers } from '@archon/core/services/all-runs-watchers';
import type { AttentionNotice } from '@archon/core/services/attention-notices';
import {
  TELEGRAM_ATTENTION_DESTINATION,
  pauseWasTold,
  runWatchers,
  telegramRecipients,
} from '@archon/core/services/run-watchers';
import { createLogger } from '@archon/paths';
import {
  recordActivationBaseline,
  type PushDeliveryResult,
  type PushDestination,
  type PushDestinationState,
} from '../services/attention-router';
import { telegramNoticeText } from './telegram-attention-text';

export interface TelegramNoticeSender {
  sendMessage(conversationId: string, message: string): Promise<void>;
}

export interface TelegramAttentionDeps {
  /** Chats watching every run nobody started (`/workflow watch all`). */
  readonly allRunsWatchers: () => Promise<readonly string[]>;
  /** The private chat of a user's linked Telegram account; its id is their Telegram user id. */
  readonly authorChatOf: (userId: string) => Promise<string | undefined>;
  /** The running bot, or null before it starts and on a machine without one. */
  readonly sender: () => TelegramNoticeSender | null;
  readonly ledger: (runId: string) => Promise<readonly AttentionNoticeRecord[]>;
  /** The Telegram chat a conversation lives in, if it is a Telegram chat. */
  readonly chatOf: (conversationId: string) => Promise<string | undefined>;
  /** Record open pauses as already noticed, once, the first time this destination exists. */
  readonly activateBaseline: () => Promise<void>;
}

const log = createLogger('server.telegram-attention');

export class TelegramAttentionDestination implements PushDestination {
  readonly id = TELEGRAM_ATTENTION_DESTINATION;

  constructor(private readonly deps: TelegramAttentionDeps) {}

  /** Must finish before the router's first scan, which treats this destination as baselined. */
  activate(): Promise<void> {
    return this.deps.activateBaseline();
  }

  async state(): Promise<PushDestinationState> {
    return this.deps.sender() ? 'active' : 'plugin_down';
  }

  async deliver(notice: AttentionNotice): Promise<PushDeliveryResult> {
    const sender = this.deps.sender();
    if (!sender) throw new Error('Telegram is not running');
    const { run } = notice;
    // Rendered first: a run that moved since selection throws, and nobody gets a stale notice.
    const text = telegramNoticeText(notice);
    const [records, starterChat, ownChat, authorChat, allRunsWatchers] = await Promise.all([
      this.deps.ledger(run.id),
      run.parent_conversation_id ? this.deps.chatOf(run.parent_conversation_id) : undefined,
      run.conversation_id ? this.deps.chatOf(run.conversation_id) : undefined,
      run.user_id ? this.deps.authorChatOf(run.user_id) : undefined,
      run.user_id ? [] : this.deps.allRunsWatchers(),
    ]);
    const recipients = telegramRecipients({
      kind: notice.kind,
      authored: run.user_id !== null,
      authorChat,
      allRunsWatchers,
      starterChat,
      ownChat,
      watchers: runWatchers(records, run.id),
      pauseTold: pauseWasTold(records, run.id),
    });
    const results = await Promise.allSettled(
      recipients.map(chat => sender.sendMessage(chat, text))
    );
    const failed = results.flatMap((result, index) =>
      result.status === 'rejected' ? [{ chat: recipients[index], err: result.reason }] : []
    );
    for (const { chat, err } of failed)
      log.warn({ err, chat, runId: run.id, kind: notice.kind }, 'telegram.attention_send_failed');
    // Recorded as sent once any chat has it: retrying would repeat it to the ones that did.
    // A failure Telegram calls final is not retried either: the router has no backoff, and a
    // chat that blocked the bot would be tried every scan for as long as the run waits.
    const retryable = failed.filter(({ err }) => !isFinalTelegramFailure(err));
    if (recipients.length > 0 && failed.length === recipients.length && retryable.length > 0)
      throw new Error(`no Telegram chat accepted the ${notice.kind} notice of run ${run.id}`);
    return {};
  }
}

/** 403: the bot was blocked or removed; 400 "chat not found": the chat is gone. */
function isFinalTelegramFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { error_code: code, description } = err as { error_code?: unknown; description?: unknown };
  return (
    code === 403 ||
    (code === 400 && typeof description === 'string' && /chat not found/i.test(description))
  );
}

async function telegramChatOfUser(userId: string): Promise<string | undefined> {
  const identities = await listIdentitiesForUser(userId);
  return identities.find(identity => identity.platform === 'telegram')?.platformUserId;
}

async function telegramChatOf(conversationId: string): Promise<string | undefined> {
  try {
    const conversation = await getConversationById(conversationId);
    if (conversation?.platform_type !== 'telegram') return undefined;
    const parsed = parseTelegramConversationId(conversation.platform_conversation_id);
    return parsed ? String(parsed.chatId) : undefined;
  } catch (err) {
    // A CLI run's anchor conversation refuses lookup; it is no Telegram chat either way.
    log.debug({ err, conversationId }, 'telegram.attention_chat_lookup_skipped');
    return undefined;
  }
}

/** The destination wired to the database and a live bot getter. */
export function createTelegramAttentionDestination(
  sender: () => TelegramNoticeSender | null,
  inlinePlatforms: ReadonlySet<string>
): TelegramAttentionDestination {
  return new TelegramAttentionDestination({
    allRunsWatchers: () => listAllRunsWatchers(),
    authorChatOf: telegramChatOfUser,
    sender,
    ledger: runId => listAttentionNotices([runId]),
    chatOf: telegramChatOf,
    activateBaseline: () =>
      getDatabase().withTransaction(async query => {
        if (!(await hasAnyAttentionNotice(TELEGRAM_ATTENTION_DESTINATION, query)))
          await recordActivationBaseline(TELEGRAM_ATTENTION_DESTINATION, inlinePlatforms, query);
      }),
  });
}
