/**
 * Turning an inbound Telegram message into files the server can persist.
 *
 * Everything here is pure: what the update carries, what it is called, what to
 * say when it is something the agent cannot read. Downloading the bytes (which
 * needs the bot token) stays in the adapter.
 */

/** A file the bot can fetch from Telegram. */
export interface TelegramIncomingFile {
  /** Telegram's handle for the file — what `getFile` takes. */
  readonly fileId: string;
  /** Sender-supplied name; absent for photos, untrusted when present. */
  readonly fileName?: string;
  /** Sender-supplied MIME type; absent for photos. */
  readonly mimeType?: string;
  /** Size in bytes as Telegram reports it; absent for some updates. */
  readonly size?: number;
}

/** The shape of the pieces of a grammY message this module reads. */
export interface TelegramMessageLike {
  readonly caption?: string;
  readonly text?: string;
  readonly media_group_id?: string;
  readonly photo?: readonly { file_id: string; file_size?: number; width?: number }[];
  readonly document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  readonly voice?: { file_id: string; mime_type?: string; file_size?: number; duration?: number };
  readonly audio?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  readonly video_note?: unknown;
  readonly sticker?: unknown;
  readonly video?: unknown;
  readonly animation?: unknown;
}

/**
 * Telegram ships a photo in several sizes; the last entry is the largest, but
 * sort by reported size rather than trusting the order.
 */
export function largestPhoto(
  sizes: readonly { file_id: string; file_size?: number; width?: number }[]
): { file_id: string; file_size?: number } | null {
  let best: { file_id: string; file_size?: number; width?: number } | null = null;
  for (const size of sizes) {
    if (best === null) {
      best = size;
      continue;
    }
    const better =
      (size.file_size ?? 0) > (best.file_size ?? 0) || (size.width ?? 0) > (best.width ?? 0);
    if (better) best = size;
  }
  return best;
}

/**
 * The files an update carries, if any. A document keeps its name and type; a
 * photo has neither, so it gets a generated `.jpg` name (Telegram always
 * re-encodes photos as JPEG).
 */
export function filesOf(message: TelegramMessageLike): TelegramIncomingFile[] {
  const files: TelegramIncomingFile[] = [];
  if (message.voice) {
    // A voice note has no name of its own — Telegram sends OGG/Opus and nothing
    // else — so one is generated with the extension the bytes actually are,
    // which is also what tells the transcriber it can send them on untouched.
    files.push({
      fileId: message.voice.file_id,
      fileName: `voice-${message.voice.file_id.slice(0, 8)}.ogg`,
      mimeType: message.voice.mime_type ?? 'audio/ogg',
      size: message.voice.file_size,
    });
  }
  if (message.audio) {
    files.push({
      fileId: message.audio.file_id,
      fileName: message.audio.file_name,
      mimeType: message.audio.mime_type,
      size: message.audio.file_size,
    });
  }
  if (message.document) {
    files.push({
      fileId: message.document.file_id,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type,
      size: message.document.file_size,
    });
  }
  if (message.photo && message.photo.length > 0) {
    const best = largestPhoto(message.photo);
    if (best !== null) {
      files.push({
        fileId: best.file_id,
        fileName: `photo-${best.file_id.slice(0, 8)}.jpg`,
        mimeType: 'image/jpeg',
        size: best.file_size,
      });
    }
  }
  return files;
}

/**
 * True when the message carries something the operator spoke.
 *
 * Voice and audio take the ordinary attachment road — downloaded, validated and
 * persisted like a photo — and are transcribed on the far side of it.
 */
export function carriesRecording(message: TelegramMessageLike): boolean {
  return message.voice !== undefined || message.audio !== undefined;
}

/** How long the recording is, as Telegram measured it. */
export function recordingDurationOf(message: TelegramMessageLike): number | undefined {
  return message.voice?.duration ?? message.audio?.duration;
}

/** Media the agent cannot read — answered with one line instead of silence. */
export type UnsupportedKind = 'video note' | 'sticker' | 'video' | 'animation';

export function unsupportedKindOf(message: TelegramMessageLike): UnsupportedKind | null {
  if (message.video_note !== undefined) return 'video note';
  if (message.sticker !== undefined) return 'sticker';
  if (message.video !== undefined) return 'video';
  if (message.animation !== undefined) return 'animation';
  return null;
}

export function unsupportedMessage(kind: UnsupportedKind): string {
  return `I can't read a ${kind} — send a photo, a document, a voice message or text instead.`;
}

/**
 * What the agent is told when files arrive without a caption.
 *
 * An empty string is not an option: the turn would reach the orchestrator with
 * nothing to act on, and the agent would have to guess what the files are for.
 * Naming them is the smallest honest prompt — the agent sees the same names in
 * `attachedFiles`, and the operator can always add a caption to say more.
 *
 * A recording is the exception and does not come here: the transcript is what
 * the operator said, so the server fills the text in on the far side of the
 * upload rather than the adapter guessing at it (see `carriesRecording`).
 */
export function defaultCaption(files: readonly TelegramIncomingFile[]): string {
  if (files.length === 0) return 'Sent a file.';
  if (files.length === 1) {
    const name = files[0]?.fileName;
    return name ? `Sent a file: ${name}. Take a look.` : 'Sent a file. Take a look.';
  }
  return `Sent ${String(files.length)} files. Take a look.`;
}
