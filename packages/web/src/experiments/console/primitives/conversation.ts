import { relativeTime } from '../lib/format';

/** Conversation summary primitive. Normalized from the server conversation row. */
export interface ConversationSummary {
  /**
   * Platform conversation id (`web-<ts>-<rand>`) — NOT the DB uuid. This is the
   * id the `/api/conversations/:id/messages` and `/api/stream/:id` routes accept.
   */
  id: string;
  title: string | null;
  platformType: string;
  lastActivityAt: string | null;
}

interface RawConversation {
  id: string;
  platform_conversation_id: string;
  platform_type: string;
  title: string | null;
  last_activity_at: string | null;
}

export function toConversationSummary(raw: RawConversation): ConversationSummary {
  return {
    id: raw.platform_conversation_id,
    title: raw.title,
    platformType: raw.platform_type,
    lastActivityAt: raw.last_activity_at,
  };
}

/**
 * What to call a conversation in the UI. The server only titles a conversation
 * once it has something to title it with, so a brand-new or untitled chat falls
 * back to when it was last active — never an empty row.
 */
export function conversationLabel(
  conversation: ConversationSummary,
  now: number = Date.now()
): string {
  const title = conversation.title?.trim() ?? '';
  if (title.length > 0) return title;
  if (conversation.lastActivityAt !== null) {
    return `Chat · ${relativeTime(conversation.lastActivityAt, now)}`;
  }
  return 'Untitled chat';
}
