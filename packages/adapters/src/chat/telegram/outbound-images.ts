/**
 * Putting the pictures an answer names into the Telegram chat.
 *
 * The agent answers in text and refers to a file it produced — a screenshot, a
 * chart. On a phone that reference is useless on its own: the file is on the
 * machine Archon runs on, and the operator is not. So after the text lands, the
 * files it named are uploaded as photos.
 *
 * Every path is re-validated here against the conversation's own roots
 * (`resolveOutboundImage`), because a Telegram send leaves the machine: the
 * agent choosing to write a path is not the same thing as that path being
 * allowed to travel. A refused path changes nothing — the text already says
 * where the file is, and the reason is logged for the operator, not the chat.
 */

import { InputFile } from 'grammy';
import { createLogger } from '@archon/paths';
import { parseImageReferences } from '@archon/core/messaging/image-references';
import { resolveOutboundImage } from '@archon/core/messaging/image-access';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.telegram.images');
  return cachedLog;
}

/** Telegram truncates a longer caption; trimming here keeps the text ours rather than theirs. */
const MAX_CAPTION_LENGTH = 1024;

/** The one Bot API call this needs, named so a test can stand in for it. */
export interface PhotoSender {
  sendPhoto(
    chatId: number,
    photo: InputFile,
    other?: { readonly caption?: string }
  ): Promise<unknown>;
}

/**
 * Upload every image `text` names and is allowed to show, in the order it names
 * them.
 *
 * Never throws and never rejects: it runs after the answer itself has already
 * been delivered, and a picture that fails to upload must not turn a delivered
 * answer into a failed one.
 */
export async function sendReferencedImages(
  api: PhotoSender,
  chatId: number,
  text: string,
  roots: readonly string[]
): Promise<void> {
  const references = parseImageReferences(text);
  if (references.length === 0 || roots.length === 0) return;

  // Two different references can name the same file through different symlinks;
  // the real path is the only identity that catches that.
  const sent = new Set<string>();

  for (const reference of references) {
    const resolved = await resolveOutboundImage(reference.path, roots);
    if (!resolved.ok) {
      getLog().warn(
        { chatId, path: reference.path, reason: resolved.reason },
        'telegram.outbound_image_refused'
      );
      continue;
    }
    if (sent.has(resolved.path)) continue;
    sent.add(resolved.path);

    try {
      await api.sendPhoto(chatId, new InputFile(resolved.path), {
        caption: reference.caption.slice(0, MAX_CAPTION_LENGTH),
      });
      getLog().debug(
        { chatId, path: resolved.path, mediaType: resolved.mediaType, size: resolved.size },
        'telegram.outbound_image_sent'
      );
    } catch (err) {
      getLog().warn({ err, chatId, path: resolved.path }, 'telegram.outbound_image_send_failed');
    }
  }
}
