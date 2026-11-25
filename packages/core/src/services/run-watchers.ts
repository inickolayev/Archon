/**
 * ChessWin fork (chesswin-factory ADR 0011 §6, issue #32): who in Telegram hears about a run.
 *
 * A run belongs to no conversation, so it calls the people it concerns: its author in their
 * own Telegram (the account the run was started under, through its linked Telegram), the
 * Telegram chat that started it, and any chat that watches it by id. A run nobody started —
 * the CLI, the nightly timer — calls the chats that watch every such run
 * (`/workflow watch all`). No chat is named in configuration. A watcher is not a parent — the
 * run neither waits for it nor ends with it.
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
  /**
   * Whether a person started the run (it carries a user). Only a run nobody started calls the
   * all-runs watchers.
   */
  authored: boolean;
  /** The author's private Telegram chat, when their account has Telegram linked. */
  authorChat?: string;
  /** Chats that watch every run nobody started (`/workflow watch all`). */
  allRunsWatchers: readonly string[];
  /**
   * The chat that started a background run. Its pauses are not told there inline (they go to
   * the run's worker conversation), and its result card comes only when the run ends without
   * pausing: a paused run is continued by another dispatch, which reports elsewhere.
   */
  starterChat?: string;
  /** The chat the run itself talks in (a foreground run): it was told everything inline. */
  ownChat?: string;
  watchers: ReadonlySet<string>;
  /** Whether a pause of this run was told; the callers and the starter then hear its end. */
  pauseTold: boolean;
}

/**
 * Who a run calls on its own: its author, or — nobody started it — the all-runs watchers. An
 * author whose run was started from, or talks in, a Telegram chat is in that chat already, so
 * their private chat is not called as well.
 */
function runCallers(input: RecipientInput): readonly string[] {
  if (!input.authored) return input.allRunsWatchers;
  const inTelegramAlready = input.starterChat !== undefined || input.ownChat !== undefined;
  return input.authorChat && !inTelegramAlready ? [input.authorChat] : [];
}

/** The chats one notice goes to, each once, in a stable order. */
export function telegramRecipients(input: RecipientInput): string[] {
  const terminal = input.kind === 'terminal';
  const called = [...runCallers(input), ...(input.starterChat ? [input.starterChat] : [])];
  const candidates = terminal
    ? [...(input.pauseTold ? called : []), ...input.watchers]
    : [...called, ...input.watchers];
  // A run that ends without pausing brings its result card to the starter itself.
  const toldElsewhere = new Set(
    [input.ownChat, terminal && !input.pauseTold ? input.starterChat : undefined].filter(
      (chat): chat is string => chat !== undefined
    )
  );
  return [...new Set(candidates)].filter(chat => !toldElsewhere.has(chat));
}
