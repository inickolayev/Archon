/**
 * A Telegram chat holds many Archon conversations, addressed as
 * `<chat id>:<n>` in `platform_conversation_id`. Rows written before that —
 * a bare chat id — are conversation 1 of their chat and stay valid forever.
 *
 * Outbound delivery has to turn such an id back into a chat id, and it must do
 * so explicitly: `parseInt('-1001234:2')` happens to return the chat id, but
 * relying on that accident would break the moment the format grows.
 */

const CONVERSATION_ID_RE = /^(-?\d+)(?::(\d+))?$/;

export interface TelegramConversationId {
  /** The Telegram chat the conversation belongs to. */
  readonly chatId: number;
  /** 1 for a legacy bare id, otherwise the suffix. */
  readonly index: number;
  /** True when the id carries no `:n` suffix (a pre-multi-conversation row). */
  readonly legacy: boolean;
}

/** Parse `<chat id>[:<n>]`; null when the id is not one of ours. */
export function parseTelegramConversationId(conversationId: string): TelegramConversationId | null {
  const match = CONVERSATION_ID_RE.exec(conversationId.trim());
  if (match === null) return null;
  const chatId = Number(match[1]);
  if (!Number.isSafeInteger(chatId)) return null;
  const suffix = match[2];
  if (suffix === undefined) return { chatId, index: 1, legacy: true };
  const index = Number(suffix);
  if (!Number.isSafeInteger(index) || index < 1) return null;
  return { chatId, index, legacy: false };
}

/**
 * The chat id to deliver to. Throws on an id this adapter cannot address —
 * better a loud failure than a message sent to `NaN`.
 */
export function telegramChatIdOf(conversationId: string): number {
  const parsed = parseTelegramConversationId(conversationId);
  if (parsed === null) {
    throw new Error(`Not a Telegram conversation id: ${JSON.stringify(conversationId)}`);
  }
  return parsed.chatId;
}

/** Build the id of conversation `index` in a chat (1 keeps the legacy bare form). */
export function telegramConversationId(chatId: number | string, index: number): string {
  return index <= 1 ? String(chatId) : `${String(chatId)}:${String(index)}`;
}

/** True when this looks like a Telegram conversation id rather than a web one. */
export function isTelegramConversationId(conversationId: string): boolean {
  return parseTelegramConversationId(conversationId) !== null;
}
