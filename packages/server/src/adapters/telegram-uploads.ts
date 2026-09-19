/**
 * Files sent from Telegram, on their way to the same place browser uploads go.
 *
 * The adapter knows how to fetch the bytes (it holds the token); this module
 * turns them into `UploadEntry`s and hands them to the shared persistence, so
 * a phone upload and a browser upload are validated by the same code and land
 * in the same directory.
 */

import { createLogger } from '@archon/paths';
import type { AttachedFile } from '@archon/core';
import type { TelegramIncomingFile } from '@archon/adapters';
import {
  MAX_FILES_PER_MESSAGE,
  MAX_UPLOAD_BYTES,
  persistUploadedFiles,
  type UploadEntry,
} from '../uploads/attachments';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.telegram-uploads');
  return cachedLog;
}

/** Downloads one file's bytes — the adapter's `downloadFile`, narrowed. */
export type TelegramFileDownloader = (file: TelegramIncomingFile) => Promise<Uint8Array>;

export type TelegramUploadResult =
  | { ok: true; savedFiles: AttachedFile[]; uploadDir: string }
  | { ok: false; error: string };

/**
 * Download and persist what a Telegram message carried.
 *
 * Refusals are worded for a phone screen and returned, not thrown: the caller
 * sends them back to the chat so a rejected file never looks like silence.
 * A download failure names no URL — that URL contains the bot token.
 */
export async function persistTelegramFiles(
  conversationId: string,
  files: readonly TelegramIncomingFile[],
  download: TelegramFileDownloader
): Promise<TelegramUploadResult> {
  if (files.length === 0) return { ok: true, savedFiles: [], uploadDir: '' };
  if (files.length > MAX_FILES_PER_MESSAGE) {
    return {
      ok: false,
      error: `That is ${String(files.length)} files — I can take ${String(MAX_FILES_PER_MESSAGE)} at a time.`,
    };
  }

  // Cheap refusal first: Telegram reports the size, so an oversized file never
  // has to be downloaded to be rejected.
  for (const file of files) {
    if (file.size !== undefined && file.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `"${file.fileName ?? 'That file'}" is larger than the 10 MB limit.`,
      };
    }
  }

  const entries: UploadEntry[] = [];
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = await download(file);
    } catch (err) {
      getLog().warn(
        { err, conversationId, fileName: file.fileName },
        'telegram_upload.download_failed'
      );
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Downloading that file from Telegram failed.',
      };
    }
    entries.push({
      name: file.fileName ?? 'file',
      type: file.mimeType ?? '',
      size: bytes.byteLength,
      bytes: () => Promise.resolve(bytes),
    });
  }

  const result = await persistUploadedFiles(conversationId, entries);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, savedFiles: result.savedFiles, uploadDir: result.uploadDir };
}
