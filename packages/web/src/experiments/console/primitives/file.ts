/**
 * Chat file-attachment limits + client-side validation.
 *
 * These are UX hints only — the server is the authoritative validator of
 * uploads. The accepted-extension list is an *approximate subset* of the old
 * production MessageInput's set (copied, not imported — the console may not
 * import `@/components/**`), so it can drift; a file the picker hides may still
 * be accepted by the server. Kept conservative on purpose.
 */

export const MAX_FILES = 5;
export const MAX_FILE_MB = 10;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

const ACCEPTED_EXTENSIONS_LIST = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.md',
  '.txt',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.log',
  '.html',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.sh',
  '.sql',
];

/** Comma-separated string for the file input's `accept` attribute. */
export const ACCEPTED_EXTENSIONS = ACCEPTED_EXTENSIONS_LIST.join(',');

const ACCEPTED_SET = new Set(ACCEPTED_EXTENSIONS_LIST);

/**
 * True if the file looks acceptable. Prefers the reported MIME type; falls back
 * to the extension because many code/config files report an empty MIME type. A
 * file with no extension and a non-text/non-image MIME is rejected.
 */
export function isAcceptedFileType(file: File): boolean {
  // Strip any `;charset=…` parameter — some sources (and Bun's File) append one.
  const mime = (file.type.split(';')[0] ?? '').trim();
  if (mime.startsWith('text/') || mime.startsWith('image/')) return true;
  if (mime === 'application/pdf' || mime === 'application/json') return true;
  const dot = file.name.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or a dotfile like `.gitignore` (no real ext)
  return ACCEPTED_SET.has(file.name.slice(dot).toLowerCase());
}

/** True for a file the browser can show as an image preview. */
export function isImageFile(file: File): boolean {
  return file.type.split(';')[0]?.trim().startsWith('image/') ?? false;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * The files carried by a paste or a drop, in order. A `DataTransferItemList`
 * mixes strings and files — a screenshot pasted from the clipboard arrives as
 * one `file` item next to `text/html` string items — so keep only the files.
 * Items whose `getAsFile()` returns null (a dragged link, an empty entry) are
 * skipped rather than reported: there is no file to attach.
 */
export function transferredFiles(items: DataTransferItemList): File[] {
  const found: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) found.push(file);
  }
  return found;
}

/**
 * One file picked for the next message. `previewUrl` is an object URL for
 * images (revoked by the owner when the attachment goes away) and null for
 * everything else — a PDF or a `.ts` file has no thumbnail.
 */
export interface Attachment {
  readonly id: string;
  readonly file: File;
  readonly previewUrl: string | null;
}

/** The id and preview URL minted for one accepted file. */
export type AttachmentMeta = Omit<Attachment, 'file'>;

/** The list after one batch of picks, plus a reason per rejected file. */
export interface AttachmentBatch {
  readonly next: readonly Attachment[];
  readonly skipped: readonly string[];
}

/**
 * Apply one batch of picked files (a paste, a drop, a picker pick) on top of
 * the attachments already held, returning a new list — never mutating the one
 * passed in. The caller must feed it the *latest* list, not a render snapshot:
 * two batches arriving in the same tick have to build on each other, or the
 * first one is silently dropped.
 *
 * `mint` produces the per-attachment id and preview URL. It is injected (and
 * called only for accepted files) so the accept/skip decision stays testable
 * without a DOM and no object URL is created for a file that is thrown away.
 *
 * Every rejection reason is accumulated, not just the last, so a mixed pick
 * surfaces all of them.
 */
export function attachFiles(
  current: readonly Attachment[],
  incoming: readonly File[],
  mint: (file: File) => AttachmentMeta
): AttachmentBatch {
  const next = [...current];
  const skipped: string[] = [];
  for (const file of incoming) {
    if (next.length >= MAX_FILES) {
      skipped.push(`${file.name}: over the ${String(MAX_FILES)}-file limit`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.push(`${file.name}: larger than ${String(MAX_FILE_MB)} MB`);
      continue;
    }
    if (!isAcceptedFileType(file)) {
      skipped.push(`${file.name}: unsupported type`);
      continue;
    }
    next.push({ file, ...mint(file) });
  }
  return { next, skipped };
}
