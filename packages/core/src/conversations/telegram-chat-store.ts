/**
 * The database behind `TelegramChatStore` — kept apart from the logic in
 * `telegram-chats.ts` so the numbering and the command replies can be tested
 * without a database.
 */

import * as codebaseDb from '../db/codebases';
import * as conversationDb from '../db/conversations';
import {
  activeConversationId,
  type TelegramChatRow,
  type TelegramChatStore,
} from './telegram-chats';

const TELEGRAM = 'telegram';

export function createTelegramChatStore(): TelegramChatStore {
  return {
    list: (chatId: string): Promise<readonly TelegramChatRow[]> =>
      conversationDb.listConversationsForChat(TELEGRAM, chatId),

    create: async (platformConversationId: string): Promise<void> => {
      // Eager creation (unlike the web's lazy first-send): on a phone the
      // operator needs an immediate "chat N created" to trust where the next
      // message goes. getOrCreate keeps it idempotent.
      await conversationDb.getOrCreateConversation(TELEGRAM, platformConversationId);
    },

    touch: async (platformConversationId: string): Promise<void> => {
      const conversation = await conversationDb.getConversationByPlatformId(
        TELEGRAM,
        platformConversationId
      );
      if (conversation === null) return;
      await conversationDb.markConversationActive(conversation.id);
    },

    listProjects: async (): Promise<readonly { name: string; default_cwd: string | null }[]> => {
      const codebases = await codebaseDb.listCodebases();
      return codebases.map(codebase => ({
        name: codebase.name,
        default_cwd: codebase.default_cwd,
      }));
    },
  };
}

/**
 * Which conversation of a Telegram chat an inbound message belongs to: the most
 * recently active one, or the chat's first (legacy-shaped) id when the chat has
 * none yet. The caller passes this to `handleMessage` instead of the bare chat
 * id.
 */
export async function resolveActiveTelegramConversationId(chatId: string): Promise<string> {
  const rows = await conversationDb.listConversationsForChat(TELEGRAM, chatId);
  return activeConversationId(rows, chatId);
}
