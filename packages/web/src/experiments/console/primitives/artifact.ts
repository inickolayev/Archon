/**
 * How one run artifact should be rendered, decided from its extension.
 *
 * The server side of this decision lives in
 * `packages/server/src/routes/artifact-content-type.ts` (it picks the
 * `Content-Type` and refuses to serve document-executable types as their
 * native type). The two lists are kept deliberately separate — the server's
 * job is safety, this one's is presentation — but they must agree on what the
 * browser will accept as an image: anything typed `text/plain` by the server
 * has to land in `text` here, or the viewer would show a broken image.
 */

export type ArtifactKind = 'markdown' | 'text' | 'image' | 'pdf' | 'binary';

const MARKDOWN = new Set(['md', 'markdown', 'mdx']);

/**
 * Raster images only. `.svg` is deliberately absent: the server serves it as
 * text (an SVG can carry script), so it renders in the text viewer.
 */
const IMAGES = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);

/** Everything the server types as `text/plain` and the viewer shows as text. */
const TEXT = new Set([
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
  'rst',
  'tex',
  'env',
  'lock',
  // Downgraded to text by the server because a browser would run them.
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
]);

/** The last path segment — what the UI shows as the file's name. */
export function artifactBasename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** The extension of a path, lowercased, without the dot (`''` when there is none). */
export function artifactExtension(path: string): string {
  const base = artifactBasename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Which viewer a file gets. Unknown extensions are `binary` — offered as a
 * download rather than dumped into the page as mangled text.
 */
export function artifactKind(path: string): ArtifactKind {
  const ext = artifactExtension(path);
  if (MARKDOWN.has(ext)) return 'markdown';
  if (IMAGES.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT.has(ext)) return 'text';
  return 'binary';
}

/** The raw-bytes URL of one artifact, each path segment encoded separately. */
export function artifactUrl(runId: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `/api/artifacts/${encodeURIComponent(runId)}/${encodedPath}`;
}

/** Human-readable byte size for the file list and the download card. */
export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
