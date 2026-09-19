/**
 * Files attached to a message, wherever they came from.
 *
 * The browser uploads them as multipart form entries; Telegram sends them as
 * photos and documents the bot downloads. Both end up in the same place, pass
 * the same validation and become the same `AttachedFile[]` the orchestrator
 * hands to the agent — one implementation, so the two paths cannot drift into
 * accepting different things.
 */

import { mkdir, unlink, writeFile } from 'fs/promises';
import { basename, join, sep } from 'path';
import { randomUUID } from 'crypto';
import { getArchonHome, createLogger } from '@archon/paths';
import type { AttachedFile } from '@archon/core';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.uploads');
  return cachedLog;
}

/** Maximum allowed upload size per file (10 MB) */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Maximum number of files per message (enforced server-side) */
export const MAX_FILES_PER_MESSAGE = 5;

/**
 * Binary (non-text) MIME types explicitly allowed for upload.
 * All text/* types are accepted separately via isAllowedUploadType().
 */
const ALLOWED_UPLOAD_BINARY_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  // application/json is a structured text type browsers may report for .json files
  'application/json',
]);

/** Extensions accepted when the sender reports an empty MIME type (code/config files). */
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.log',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.rs',
  '.swift',
  '.kt',
  '.scala',
  '.r',
  '.sql',
]);

/** Returns true if the MIME type is allowed for upload. */
export function isAllowedUploadType(mimeType: string, fileName: string): boolean {
  // All text/* types are acceptable (covers .md, .py, .rs, .go, .sh, .yaml, etc.)
  if (mimeType.startsWith('text/')) return true;
  if (ALLOWED_UPLOAD_BINARY_MIME_TYPES.has(mimeType)) return true;
  // Browsers assign empty MIME types to many code/config extensions — fall back to extension
  if (!mimeType) {
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex !== -1) {
      return ALLOWED_UPLOAD_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase());
    }
  }
  return false;
}

/**
 * A filename safe to put on disk and to show back to the sender.
 *
 * Both sources are untrusted, but Telegram especially so: `file_name` comes
 * straight from whoever sent the file and may carry `../`, control characters,
 * a NUL, or nothing at all. `basename` drops any path, the character filter
 * leaves only a conservative set, and an empty result falls back rather than
 * producing a nameless file.
 */
export function safeUploadName(rawName: string | undefined, fallback = 'file'): string {
  // Backslashes first: `basename` does not treat them as separators on POSIX,
  // so a Windows-style path would otherwise survive as one long name.
  const base = basename((rawName ?? '').replace(/\\/g, '/'))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '') // no leading dots: never a dotfile, never '..'
    .slice(0, 120);
  return base.length > 0 ? base : fallback;
}

/** The directory this conversation's uploads live in. */
export function uploadDirFor(conversationId: string): string {
  // A Telegram conversation id carries a colon, which is not a legal path
  // character everywhere (Windows reads it as a drive separator). The directory
  // only has to be unique per conversation, so flatten it.
  const uploadDirName = conversationId.replace(/[^\w.-]/g, '_');
  return join(getArchonHome(), 'artifacts', 'uploads', uploadDirName);
}

/**
 * One file to persist. Deliberately not `File`: Telegram hands over bytes it
 * downloaded, the browser hands over a multipart `File`, and both fit this.
 */
export interface UploadEntry {
  readonly name: string;
  /** MIME type as reported by the sender; may be empty. */
  readonly type: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
}

export type PersistUploadsResult =
  | { ok: true; savedFiles: AttachedFile[]; uploadDir: string }
  | { ok: false; status: 400 | 500; error: string };

/** Wrap a multipart `File` (the browser path) as an `UploadEntry`. */
export function uploadEntryFromFile(file: File): UploadEntry {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

/**
 * Validate and write a message's attachments to the conversation's upload
 * directory. Nothing is written until every entry has passed validation, and a
 * write failure rolls back what it already wrote.
 */
export async function persistUploadedFiles(
  conversationId: string,
  entries: readonly UploadEntry[]
): Promise<PersistUploadsResult> {
  if (entries.length > MAX_FILES_PER_MESSAGE) {
    return {
      ok: false,
      status: 400,
      error: `Maximum ${MAX_FILES_PER_MESSAGE.toString()} files per message`,
    };
  }

  const archonHome = getArchonHome();
  const uploadDir = uploadDirFor(conversationId);
  if (!uploadDir.startsWith(archonHome + sep)) {
    return { ok: false, status: 400, error: 'Invalid conversation ID' };
  }

  // Validate all files before writing any to disk.
  for (const entry of entries) {
    const displayName = safeUploadName(entry.name);
    if (!isAllowedUploadType(entry.type, entry.name)) {
      return {
        ok: false,
        status: 400,
        error: `File "${displayName}" has an unsupported type: ${entry.type}`,
      };
    }
    if (entry.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 400,
        error: `File "${displayName}" exceeds the 10 MB size limit`,
      };
    }
  }

  const savedFiles: AttachedFile[] = [];
  try {
    await mkdir(uploadDir, { recursive: true });
    for (const entry of entries) {
      const fileId = randomUUID();
      const safeName = safeUploadName(entry.name, fileId);
      const filePath = join(uploadDir, `${fileId}_${safeName}`);
      await writeFile(filePath, Buffer.from(await entry.bytes()));
      const normalizedMime =
        entry.type.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
      savedFiles.push({
        path: filePath,
        name: safeName,
        mimeType: normalizedMime,
        size: entry.size,
      });
    }
  } catch (writeErr: unknown) {
    for (const f of savedFiles) {
      await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          getLog().warn({ err, filePath: f.path, conversationId }, 'upload.rollback_failed');
        }
      });
    }
    getLog().error({ err: writeErr, conversationId }, 'upload.write_failed');
    return {
      ok: false,
      status: 500,
      error: 'Failed to save uploaded file. Check available disk space.',
    };
  }

  return { ok: true, savedFiles, uploadDir };
}
