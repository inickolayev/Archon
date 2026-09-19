/**
 * Content type for a workflow artifact served by `GET /api/artifacts/:runId/*`.
 *
 * Artifacts are written by agents, so their bytes are untrusted input, and this
 * origin also serves the Archon console — anything the browser would run in a
 * document context (SVG, HTML, XML with a stylesheet…) must never be served as
 * its native type, or an artifact could script the console. Those are
 * downgraded to plain text; unknown types are handed over as a download.
 */

export interface ArtifactContentType {
  /** Value for the `Content-Type` header. */
  readonly type: string;
  /** Whether the browser may display it in place or should download it. */
  readonly disposition: 'inline' | 'attachment';
}

const MARKDOWN = new Set(['md', 'markdown']);

/**
 * Extensions the browser can run as a document. Served as text so they can
 * still be read in the UI, never as `image/svg+xml` / `text/html` / `*+xml`.
 */
const EXECUTABLE_AS_DOCUMENT = new Set([
  'svg',
  'svgz',
  'html',
  'htm',
  'xhtml',
  'shtml',
  'mhtml',
  'xml',
  'xsl',
  'xslt',
  'xsd',
  'rdf',
  'atom',
  'rss',
  'vtt', // rendered by <track>, but harmless as text and never needed inline here
]);

/** Text and code the UI renders in its `<pre>` viewer. */
const PLAIN_TEXT = new Set([
  'txt',
  'text',
  'log',
  'out',
  'err',
  'diff',
  'patch',
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'properties',
  'csv',
  'tsv',
  'sql',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'pl',
  'lua',
  'r',
  'scala',
  'clj',
  'ex',
  'exs',
  'erl',
  'hs',
  'dart',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'css',
  'scss',
  'sass',
  'less',
  'graphql',
  'gql',
  'proto',
  'mdx',
  'rst',
  'tex',
  'env',
  'lock',
  'gitignore',
  'dockerfile',
  'makefile',
]);

/** Raster images — safe to render inline, unlike SVG. */
const IMAGES = new Map([
  ['png', 'image/png'],
  ['apng', 'image/apng'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/vnd.microsoft.icon'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
]);

/**
 * Binary formats worth naming so the browser and the UI know what they are.
 * Everything here downloads rather than renders, except the PDF the artifact
 * viewer embeds.
 */
const BINARY = new Map<string, ArtifactContentType>([
  ['pdf', { type: 'application/pdf', disposition: 'inline' }],
  ['zip', { type: 'application/zip', disposition: 'attachment' }],
  ['gz', { type: 'application/gzip', disposition: 'attachment' }],
  ['tgz', { type: 'application/gzip', disposition: 'attachment' }],
  ['tar', { type: 'application/x-tar', disposition: 'attachment' }],
  ['7z', { type: 'application/x-7z-compressed', disposition: 'attachment' }],
  ['webm', { type: 'video/webm', disposition: 'attachment' }],
  ['mp4', { type: 'video/mp4', disposition: 'attachment' }],
  ['mp3', { type: 'audio/mpeg', disposition: 'attachment' }],
  ['wav', { type: 'audio/wav', disposition: 'attachment' }],
  ['woff', { type: 'font/woff', disposition: 'attachment' }],
  ['woff2', { type: 'font/woff2', disposition: 'attachment' }],
  ['ttf', { type: 'font/ttf', disposition: 'attachment' }],
  ['otf', { type: 'font/otf', disposition: 'attachment' }],
]);

const TEXT_PLAIN = 'text/plain; charset=utf-8';

/** The extension of a path, lowercased, without the dot (`''` when there is none). */
export function artifactExtension(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** How one artifact should be typed and disposed of. */
export function artifactContentType(filename: string): ArtifactContentType {
  const ext = artifactExtension(filename);
  if (MARKDOWN.has(ext)) return { type: 'text/markdown; charset=utf-8', disposition: 'inline' };
  // Checked before the text set on purpose: these are readable as text but must
  // never reach the browser as a runnable document type.
  if (EXECUTABLE_AS_DOCUMENT.has(ext)) return { type: TEXT_PLAIN, disposition: 'inline' };
  if (PLAIN_TEXT.has(ext)) return { type: TEXT_PLAIN, disposition: 'inline' };
  const image = IMAGES.get(ext);
  if (image !== undefined) return { type: image, disposition: 'inline' };
  const binary = BINARY.get(ext);
  if (binary !== undefined) return binary;
  return { type: 'application/octet-stream', disposition: 'attachment' };
}

/**
 * A download filename safe to put in a header: the basename with everything
 * outside `[A-Za-z0-9._-]` replaced, so no quote or newline can break out of
 * the `Content-Disposition` value.
 */
function safeDownloadName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'artifact' : cleaned;
}

/** Response headers for serving one artifact's bytes. */
export function artifactHeaders(filename: string): Record<string, string> {
  const { type, disposition } = artifactContentType(filename);
  const headers: Record<string, string> = {
    'Content-Type': type,
    // The type above is deliberately conservative; never let the browser sniff
    // a downgraded artifact back into HTML.
    'X-Content-Type-Options': 'nosniff',
  };
  if (disposition === 'attachment') {
    headers['Content-Disposition'] = `attachment; filename="${safeDownloadName(filename)}"`;
  }
  return headers;
}
