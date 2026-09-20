/**
 * Pictures inside a chat message.
 *
 * The agent has no image channel — it writes the path of a file it produced,
 * and the console turns that into the picture itself rather than leaving the
 * operator to go and open it.
 *
 * The server reads the same text independently in
 * `packages/core/src/messaging/image-references.ts`, for the Telegram side of
 * the same answer; `@archon/web` is a client package and cannot import it, so
 * the two live apart and must agree on what a path looks like. Neither is a
 * trust boundary: this one only decides what to ASK for, and the server
 * re-validates every path before it serves a byte.
 */

/** Raster formats only. `.svg` is absent on purpose — the server never serves one as an image. */
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * Markdown that already means something: a fenced or inline code span (a path
 * shown as text is not an illustration), an existing image or link, and raw
 * HTML. Bare paths are only rewritten in the prose between these.
 */
const PROTECTED_SPAN = /```[\s\S]*?```|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>/g;

/**
 * A bare absolute path. The separator classes are what split a comma-joined
 * list and keep the sentence's punctuation out of the path — see the server's
 * copy for why a filename containing a comma or a bracket is not recognised.
 */
const BARE_PATH = /(^|[\s(<"'«,;])(\/[^\s<>"'«»,;()[\]]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** The last segment of a path — what an uncaptioned picture is called. */
export function imageName(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

/** True for an absolute local path to a raster image — the thing the agent writes. */
export function isLocalImagePath(src: string | undefined): src is string {
  return src !== undefined && src.startsWith('/') && IMAGE_EXTENSION.test(src);
}

/** Where the console fetches one image a conversation's reply pointed at. */
export function chatImageUrl(conversationId: string, path: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/image?path=${encodeURIComponent(path)}`;
}

/** Rewrite the bare paths in one stretch of prose as markdown images. */
function linkBarePaths(prose: string): string {
  return prose.replace(BARE_PATH, (whole, lead: string, path: string) => {
    const trimmed = path.replace(TRAILING_PUNCTUATION, '');
    if (!IMAGE_EXTENSION.test(trimmed)) return whole;
    const tail = path.slice(trimmed.length);
    return `${lead}![${imageName(trimmed)}](${trimmed})${tail}`;
  });
}

/** A line that is nothing but images (one or more), with no prose around them. */
const IMAGE_ONLY_LINE = /^\s*(?:!\[[^\]\n]*\]\([^)\n]+\)\s*)+$/;

/**
 * Put a run of image-only lines on a single line, so the renderer sees one
 * paragraph of pictures instead of one paragraph per picture.
 *
 * Screenshots are the common case and they are tall and narrow: left one per
 * line, four of them fill a screen and waste the whole right half of it. Joined,
 * they lay out as a grid. Blank lines inside the run are swallowed for the same
 * reason; a blank line is kept around the run so the pictures stay their own
 * paragraph and never glue themselves onto the sentence that introduced them.
 */
function groupImageLines(markdown: string): string {
  const out: string[] = [];
  const run: string[] = [];
  let pendingBlank = false;

  const flush = (): void => {
    if (run.length === 0) return;
    out.push(run.join(' '));
    run.length = 0;
  };

  for (const line of markdown.split('\n')) {
    if (IMAGE_ONLY_LINE.test(line)) {
      if (run.length === 0 && out.length > 0 && out[out.length - 1] !== '') out.push('');
      run.push(line.trim());
      pendingBlank = false;
      continue;
    }
    // A blank line between two image lines belongs to the run, not after it.
    if (run.length > 0 && line.trim() === '') {
      pendingBlank = true;
      continue;
    }
    flush();
    if (pendingBlank) {
      out.push('');
      pendingBlank = false;
    }
    out.push(line);
  }
  flush();
  if (pendingBlank) out.push('');
  return out.join('\n');
}

/**
 * The message as markdown, with every bare image path turned into a markdown
 * image so the renderer draws it. Paths inside code, links and existing images
 * are left exactly as they are.
 */
export function withInlineImages(content: string): string {
  let result = '';
  let cursor = 0;
  for (const match of content.matchAll(PROTECTED_SPAN)) {
    const start = match.index;
    result += linkBarePaths(content.slice(cursor, start)) + match[0];
    cursor = start + match[0].length;
  }
  return groupImageLines(result + linkBarePaths(content.slice(cursor)));
}

/** Every local image the message shows, in order and without repeats. */
export function inlineImagePaths(content: string): readonly string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of withInlineImages(content).matchAll(/!\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const path = match[1] ?? '';
    if (!isLocalImagePath(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
