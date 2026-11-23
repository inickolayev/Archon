/**
 * ChessWin fork (chesswin-factory ADR 0011 §6, issue #32): who in Telegram hears about a run.
 *
 * A run belongs to no conversation, so it calls whoever has asked to hear from it: the
 * operator chats an install routes attention to, the Telegram chat that started it, and any
 * chat that watches it by id. A watcher is not a parent — the run neither waits for it nor
 * ends with it.
 *
 * A subscription is a row in the attention ledger (`attention_notice_sent`) of the one
 * Telegram destination, keyed `watch@<chat>` / `unwatch@<chat>`. Living there is what makes
 * the router owe that destination the run's end: it selects a finished run for every
 * destination holding a non-baseline row for it. `@` cannot appear in a node id, so these keys
 * never collide with a pause's `<node>:<occurrence>`.
 */
import type {
  AttentionNoticeData,
  AttentionNoticeKind,
} from '@archon/workflows/schemas/attention-notice';
import type { AttentionNoticeRecord } from '../db/workflow-events';

/** The ledger destination of the bundled Telegram adapter; route ids carry a ':', this cannot. */
export const TELEGRAM_ATTENTION_DESTINATION = 'telegram';

const WATCH = 'watch@';
const UNWATCH = 'unwatch@';

function isWatchKey(key: string): boolean {
  return key.startsWith(WATCH) || key.startsWith(UNWATCH);
}

/** The ledger row that starts (`watching`) or stops a chat's subscription to a run. */
export function watchRecord(chatId: string, watching: boolean): AttentionNoticeData {
  return {
    destination: TELEGRAM_ATTENTION_DESTINATION,
    key: `${watching ? WATCH : UNWATCH}${chatId}`,
    conversationId: chatId,
  };
}

function telegramRows(
  records: readonly AttentionNoticeRecord[],
  runId: string
): AttentionNoticeRecord[] {
  return records.filter(
    row => row.runId === runId && row.data.destination === TELEGRAM_ATTENTION_DESTINATION
  );
}

/** The chats watching `runId` now: rows are in ledger order, so the latest word wins. */
export function runWatchers(
  records: readonly AttentionNoticeRecord[],
  runId: string
): ReadonlySet<string> {
  return telegramRows(records, runId).reduce<ReadonlySet<string>>((watching, { data }) => {
    if (data.key.startsWith(WATCH)) return new Set([...watching, data.key.slice(WATCH.length)]);
    if (data.key.startsWith(UNWATCH)) {
      const chat = data.key.slice(UNWATCH.length);
      return new Set([...watching].filter(watcher => watcher !== chat));
    }
    return watching;
  }, new Set());
}

/** Whether Telegram was told of one of this run's pauses (a baseline is not telling). */
export function pauseWasTold(records: readonly AttentionNoticeRecord[], runId: string): boolean {
  return telegramRows(records, runId).some(
    ({ data }) => data.baseline !== true && data.key !== 'terminal' && !isWatchKey(data.key)
  );
}

export interface RecipientInput {
  kind: AttentionNoticeKind;
  /** Chats every pause is routed to (`attentionNotices` routes with platform `telegram`). */
  operators: readonly string[];
  /**
   * The chat that started a background run. Its pauses are not told there inline (they go to
   * the run's worker conversation), and its result card comes only when the run ends without
   * pausing: a paused run is continued by another dispatch, which reports elsewhere.
   */
  starterChat?: string;
  /** The chat the run itself talks in (a foreground run): it was told everything inline. */
  ownChat?: string;
  watchers: ReadonlySet<string>;
  /** Whether a pause of this run was told; operators and the starter then hear its end. */
  pauseTold: boolean;
}

/** The chats one notice goes to, each once, in a stable order. */
export function telegramRecipients(input: RecipientInput): string[] {
  const terminal = input.kind === 'terminal';
  const starter = input.starterChat ? [input.starterChat] : [];
  const candidates = terminal
    ? [...(input.pauseTold ? [...input.operators, ...starter] : []), ...input.watchers]
    : [...input.operators, ...starter, ...input.watchers];
  // A run that ends without pausing brings its result card to the starter itself.
  const toldElsewhere = new Set(
    [input.ownChat, terminal && !input.pauseTold ? input.starterChat : undefined].filter(
      (chat): chat is string => chat !== undefined
    )
  );
  return [...new Set(candidates)].filter(chat => !toldElsewhere.has(chat));
}
