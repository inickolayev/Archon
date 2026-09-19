import type { TelegramIncomingFile } from './attachments';

/**
 * Message context passed to onMessage handler.
 * `displayName` is derived from ctx.from (first_name + last_name, fallback to
 * username); undefined if neither is present on the inbound event.
 * `files` carries photos and documents the sender attached — the server
 * downloads and persists them through the same path as a browser upload.
 */
export interface TelegramMessageContext {
  conversationId: string;
  message: string;
  userId: number | undefined;
  displayName?: string;
  files?: TelegramIncomingFile[];
}
