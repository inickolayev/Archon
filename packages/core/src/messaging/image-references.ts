/**
 * The images an answer points at.
 *
 * The agent has no picture channel of its own — it writes a path, the way it
 * already does after taking a screenshot ("Файлы: /tmp/devshot/desktop.png").
 * Reading those references back out of the finished text is what lets the
 * delivery layer put the picture in the chat instead of leaving the operator
 * to go and open the file themselves.
 *
 * Deliberately pure: nothing here touches the filesystem. A reference is a
 * CLAIM about a path, never permission to read it — `image-access.ts` is what
 * decides which claims may actually leave the machine.
 *
 * The browser has a second, independent reading of the same text in
 * `packages/web/src/experiments/console/primitives/chat-image.ts` (a client
 * package cannot import this one). The two must agree on what looks like an
 * image path; neither is a trust boundary, because the server re-validates
 * every path it is asked for.
 */

/**
 * More than this in one answer is a listing, not an illustration, and Telegram
 * would receive it as a burst of separate photo messages.
 */
export const MAX_IMAGE_REFERENCES = 10;

/** Raster formats every chat surface renders. `.svg` is absent on purpose: it can carry script. */
export const IMAGE_REFERENCE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;

const ENDS_WITH_IMAGE_EXTENSION = new RegExp(
  `\\.(?:${IMAGE_REFERENCE_EXTENSIONS.join('|')})$`,
  'i'
);

/**
 * `![alt](/path/to/shot.png "optional title")`. The alt text is the caption
 * when there is one — it is what the agent chose to call the picture.
 */
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s)<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

/**
 * A bare absolute path, which is what the agent writes today.
 *
 * The separator class in front is what makes a comma-joined list
 * (`/tmp/a.png,/tmp/b.png`) read as two paths; the same class inside the path
 * is why a filename containing a comma, a bracket or a quote is not recognised.
 * That is the deliberate trade: those characters end a path far more often than
 * they appear inside one, and an unrecognised path degrades to plain text.
 */
const PATH_CANDIDATE = /(?:^|[\s(<"'«,;])(\/[^\s<>"'«»,;()[\]]+)/g;

/** Sentence punctuation that follows a path rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** One image an answer refers to, in the order it is mentioned. */
export interface ImageReference {
  /** The path exactly as written, minus the punctuation that ended the sentence. */
  readonly path: string;
  /** Alt text when the agent wrote a markdown image, else the file name. */
  readonly caption: string;
}

/** The last segment of a path — what an uncaptioned image is called. */
export function imageReferenceName(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

/** Captions by path, from the markdown-image form only. */
function captionsOf(text: string): Map<string, string> {
  const captions = new Map<string, string>();
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const alt = match[1]?.trim() ?? '';
    const path = match[2] ?? '';
    if (alt.length > 0 && path.length > 0 && !captions.has(path)) captions.set(path, alt);
  }
  return captions;
}

/**
 * Every local image the text points at, in the order it mentions them, without
 * repeats and capped at `MAX_IMAGE_REFERENCES`.
 *
 * One ordered scan finds both forms: the path inside `![alt](…)` is preceded by
 * `(`, which the candidate pattern treats as a separator, so a markdown image is
 * simply a bare path that also happens to carry a caption.
 */
export function parseImageReferences(text: string): readonly ImageReference[] {
  const captions = captionsOf(text);
  const references: ImageReference[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(PATH_CANDIDATE)) {
    const candidate = (match[1] ?? '').replace(TRAILING_PUNCTUATION, '');
    if (!ENDS_WITH_IMAGE_EXTENSION.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    references.push({
      path: candidate,
      caption: captions.get(candidate) ?? imageReferenceName(candidate),
    });
    if (references.length === MAX_IMAGE_REFERENCES) break;
  }

  return references;
}
