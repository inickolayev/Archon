import type { TelegramIncomingFile } from './attachments';

/**
 * Message context passed to onMessage handler.
 * `displayName` is derived from ctx.from (first_name + last_name, fallback to
 * username); undefined if neither is present on the inbound event.
 * `files` carries photos and documents the sender attached — the server
 * downloads and persists them through the same path as a browser upload.
 * `sentAtMs` is when Telegram says the operator pressed send: the history is
 * stamped with that rather than with the moment the server got around to
 * inserting a row, which can be minutes later when a turn was already running.
 * `platformMessageId` and `voiceDurationSec` describe a dictated message: the
 * first is what the transcript is posted back as a reply to, the second is what
 * Telegram measured so the transcriber need not probe the file for it.
 */
export interface TelegramMessageContext {
  conversationId: string;
  message: string;
  userId: number | undefined;
  displayName?: string;
  files?: TelegramIncomingFile[];
  /** Epoch milliseconds, from `ctx.message.date` (which Telegram sends in seconds). */
  sentAtMs?: number;
  /** Telegram's id for this message, within its chat. */
  platformMessageId?: number;
  /** Length of the voice note or audio file this message carried, in seconds. */
  voiceDurationSec?: number;
}
