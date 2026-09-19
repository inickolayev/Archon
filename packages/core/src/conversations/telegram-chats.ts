/**
 * Many Archon conversations inside one Telegram chat.
 *
 * A Telegram chat used to be exactly one conversation, forever. Conversations
 * are now addressed as `<chat id>:<n>` in `platform_conversation_id`; a bare
 * chat id is conversation 1 (every row written before this change) and keeps
 * working untouched.
 *
 * There is no "active conversation" column and no table of our own inside the
 * pinned engine: the active conversation of a chat is simply the one with the
 * newest `last_activity_at` among that chat's rows, which is true by
 * construction — every turn touches it — and `/switch` touches the row it
 * selects.
 *
 * The functions here are pure or take a small store port, so the numbering and
 * the command replies are testable without a database or Telegram.
 */

import { parseTelegramConversationId, telegramConversationId } from './telegram-conversation-id';

/**
 * A conversation timestamp as the DB layer hands it over: a `Date` on the
 * hydrated path, a naive UTC string straight from SQLite, or nothing at all.
 */
export type ConversationTimestamp = string | Date | null;

/** The columns of `remote_agent_conversations` this module reads. */
export interface TelegramChatRow {
  readonly platform_conversation_id: string;
  readonly title: string | null;
  readonly last_activity_at: ConversationTimestamp;
  /**
   * Tie-break for `last_activity_at`: on SQLite that column has one-second
   * granularity, so a `/switch` made in the same second as the previous turn
   * would otherwise tie with it. `markConversationActive` bumps both.
   */
  readonly updated_at?: ConversationTimestamp;
}

/** One conversation of a chat, as the operator sees it. */
export interface NumberedConversation {
  /** `platform_conversation_id` — what the rest of the engine addresses. */
  readonly id: string;
  /** 1-based, stable: derived from the id, not from the row order. */
  readonly index: number;
  readonly title: string | null;
  readonly lastActivityAt: ConversationTimestamp;
  readonly updatedAt: ConversationTimestamp;
  readonly active: boolean;
}

/**
 * DB access this module needs. A port rather than a direct import so the
 * command handling can be unit-tested with a fake.
 */
export interface TelegramChatStore {
  /** Every conversation of the chat, any order. */
  list(chatId: string): Promise<readonly TelegramChatRow[]>;
  /** Create the conversation row for this platform id (idempotent). */
  create(platformConversationId: string): Promise<void>;
  /** Bump `last_activity_at` — this is what makes a conversation the active one. */
  touch(platformConversationId: string): Promise<void>;
  /** Registered projects, for `/projects`. */
  listProjects(): Promise<readonly { name: string; default_cwd: string | null }[]>;
}

/**
 * DB timestamps arrive as naive UTC strings on SQLite ("2026-09-19 17:21:01"),
 * which `new Date()` would read as local time. Tag them as UTC; strings that
 * already carry a zone pass through.
 */
function toMs(timestamp: ConversationTimestamp): number {
  if (timestamp === null || timestamp === undefined) return 0;
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  const normalized = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(timestamp)
    ? timestamp
    : `${timestamp.replace(' ', 'T')}Z`;
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** Compact "when" for a phone: `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function formatAgo(timestamp: ConversationTimestamp, now: number = Date.now()): string {
  if (timestamp === null || timestamp === undefined) return 'never used';
  const ms = toMs(timestamp);
  if (ms === 0) return 'never used';
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86400))}d ago`;
}

/**
 * The chat's conversations, numbered and sorted by number, with the active one
 * marked. Rows that belong to another chat (or are unparseable) are ignored.
 */
export function numberConversations(
  rows: readonly TelegramChatRow[],
  chatId: string
): NumberedConversation[] {
  const numbered = rows.flatMap(row => {
    const parsed = parseTelegramConversationId(row.platform_conversation_id);
    if (parsed === null || String(parsed.chatId) !== chatId) return [];
    return [
      {
        id: row.platform_conversation_id,
        index: parsed.index,
        title: row.title,
        lastActivityAt: row.last_activity_at,
        updatedAt: row.updated_at ?? null,
        active: false,
      },
    ];
  });

  // Active = newest activity, tie-broken by updated_at (which a switch bumps)
  // and finally by the number, so a fresh chat where nothing has a timestamp
  // yet lands on the one /new just created.
  let activeIndex = -1;
  let best = { ms: -1, updated: -1, index: -1 };
  numbered.forEach((conversation, i) => {
    const ms = toMs(conversation.lastActivityAt);
    const updated = toMs(conversation.updatedAt);
    const wins =
      ms > best.ms ||
      (ms === best.ms &&
        (updated > best.updated || (updated === best.updated && conversation.index > best.index)));
    if (wins) {
      best = { ms, updated, index: conversation.index };
      activeIndex = i;
    }
  });

  return numbered
    .map((conversation, i) => ({ ...conversation, active: i === activeIndex }))
    .sort((a, b) => a.index - b.index);
}

/** The conversation a new message in this chat belongs to. */
export function activeConversationId(rows: readonly TelegramChatRow[], chatId: string): string {
  const active = numberConversations(rows, chatId).find(c => c.active);
  // No rows yet: the first conversation of a chat keeps the bare, legacy id.
  return active?.id ?? telegramConversationId(chatId, 1);
}

/** The id `/new` should create: one past the highest number in use. */
export function nextConversationId(rows: readonly TelegramChatRow[], chatId: string): string {
  const numbered = numberConversations(rows, chatId);
  const highest = numbered.reduce((max, c) => Math.max(max, c.index), 0);
  return telegramConversationId(chatId, highest + 1);
}

const NO_TITLE = 'untitled';

function label(conversation: NumberedConversation): string {
  const title = conversation.title?.trim() ?? '';
  return title.length > 0 ? title : NO_TITLE;
}

/** `/chats` output — one short line per conversation. */
export function formatChatList(
  conversations: readonly NumberedConversation[],
  now: number = Date.now()
): string {
  if (conversations.length === 0) {
    return 'No chats yet. Send a message to start one, or /new.';
  }
  const lines = conversations.map(conversation => {
    const marker = conversation.active ? ' ← active' : '';
    return `${String(conversation.index)}. ${label(conversation)} — ${formatAgo(
      conversation.lastActivityAt,
      now
    )}${marker}`;
  });
  return [...lines, '', '/switch <n> to change, /new for a new chat'].join('\n');
}

/** The commands this module owns. Telegram only — the web has its own UI. */
export const TELEGRAM_CHAT_COMMANDS = ['new', 'chats', 'switch', 'projects'] as const;
export type TelegramChatCommand = (typeof TELEGRAM_CHAT_COMMANDS)[number];

export function isTelegramChatCommand(command: string): command is TelegramChatCommand {
  return (TELEGRAM_CHAT_COMMANDS as readonly string[]).includes(command);
}

export interface TelegramChatCommandInput {
  readonly command: TelegramChatCommand;
  readonly args: readonly string[];
  /** The Telegram chat the message came from. */
  readonly chatId: string;
  readonly store: TelegramChatStore;
  readonly now?: number;
}

/**
 * Run one of the chat-management commands and return the reply text. Kept
 * short on purpose: this is read on a phone.
 */
export async function handleTelegramChatCommand(input: TelegramChatCommandInput): Promise<string> {
  const { command, args, chatId, store } = input;
  const now = input.now ?? Date.now();

  if (command === 'projects') {
    const projects = await store.listProjects();
    if (projects.length === 0) {
      return 'No projects registered.\n/register-project <name> <path> adds one.';
    }
    const lines = projects.map(p => `• ${p.name}${p.default_cwd ? ` — ${p.default_cwd}` : ''}`);
    return ['Projects:', ...lines, '', '/setproject <name> binds this chat'].join('\n');
  }

  if (command === 'chats') {
    const rows = await store.list(chatId);
    return formatChatList(numberConversations(rows, chatId), now);
  }

  if (command === 'new') {
    const rows = await store.list(chatId);
    const id = nextConversationId(rows, chatId);
    const index = parseTelegramConversationId(id)?.index ?? rows.length + 1;
    // Created eagerly (unlike the web's lazy creation): on a phone the operator
    // needs an immediate confirmation that the next message lands somewhere new.
    await store.create(id);
    await store.touch(id);
    return `Chat ${String(index)} created and active. /chats to list.`;
  }

  // switch
  const requested = Number(args[0]);
  const rows = await store.list(chatId);
  const conversations = numberConversations(rows, chatId);
  if (!Number.isInteger(requested) || requested < 1) {
    return `Usage: /switch <n>\n${formatChatList(conversations, now)}`;
  }
  const target = conversations.find(c => c.index === requested);
  if (target === undefined) {
    const known = conversations.map(c => c.index);
    const range = known.length === 0 ? 'none yet' : known.join(', ');
    return `No chat ${String(requested)}. Existing: ${range}.`;
  }
  if (target.active) {
    return `Already on chat ${String(target.index)} (${label(target)}).`;
  }
  // Touching is the switch: the active conversation is the most recently active one.
  await store.touch(target.id);
  return `Switched to chat ${String(target.index)}: ${label(target)}.`;
}
