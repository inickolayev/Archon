/**
 * Which of the paths an answer names may actually be delivered as a picture.
 *
 * This is the whole security surface of outbound images. The agent can name any
 * path the container can read, and the container mounts the operator's entire
 * workspace; a reply goes to Telegram, which is off the machine. So a named path
 * is not read because the agent asked — it is read only when it survives all of:
 *
 *  - an extension allowlist (raster images only, never `.svg`: it can carry script);
 *  - `realpath`, so a symlink planted inside an allowed root cannot point out of it,
 *    compared against the `realpath` of each root, because the roots themselves are
 *    often symlinks (`/tmp` → `/private/tmp` on macOS);
 *  - the file's own header bytes, because an extension is a claim by the same party
 *    that chose the path — this is what keeps a renamed secret out of the chat;
 *  - a size cap, which is Telegram's photo limit.
 *
 * A path that fails is not an error the operator has to act on: the answer is
 * delivered as written, minus the picture. The caller logs the reason.
 */

import { open, realpath, stat } from 'fs/promises';
import { isAbsolute, sep } from 'path';
import { tmpdir } from 'os';

/** Telegram refuses a photo larger than this, so nothing above it is worth reading. */
export const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;

/** Enough for every signature below; `RIFF….WEBP` needs the twelfth byte. */
const HEADER_BYTES = 12;

/**
 * File headers, not extensions. Each entry answers "is this really that format",
 * which is the question the extension only claims to answer.
 */
const SIGNATURES: readonly {
  readonly mediaType: string;
  readonly matches: (header: Uint8Array) => boolean;
}[] = [
  {
    mediaType: 'image/png',
    matches: h => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mediaType: 'image/jpeg', matches: h => startsWith(h, [0xff, 0xd8, 0xff]) },
  {
    mediaType: 'image/gif',
    matches: h => ascii(h, 0, 6) === 'GIF87a' || ascii(h, 0, 6) === 'GIF89a',
  },
  {
    mediaType: 'image/webp',
    matches: h => ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 12) === 'WEBP',
  },
];

function startsWith(header: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => header[index] === byte);
}

function ascii(header: Uint8Array, from: number, to: number): string {
  return Array.from(header.slice(from, to), byte => String.fromCharCode(byte)).join('');
}

/** Why a named path is not going to be delivered. Logged, never shown to the agent's reader. */
export type ImageRejection =
  | 'not_absolute'
  | 'unsupported_extension'
  | 'outside_allowed_roots'
  | 'unreadable'
  | 'not_a_file'
  | 'too_large'
  | 'not_an_image';

export interface AllowedImage {
  readonly ok: true;
  /** The real path, symlinks already followed — read THIS, never the path as written. */
  readonly path: string;
  /** Decided by the header bytes, not by the extension. */
  readonly mediaType: string;
  readonly size: number;
}

export type OutboundImage = AllowedImage | { readonly ok: false; readonly reason: ImageRejection };

const EXTENSION = /\.([a-z0-9]+)$/i;
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * The roots a conversation's answers may show pictures from: the directory the
 * turn actually works in, the project it belongs to, and the system temp
 * directory — where a screenshot tool writes by default.
 *
 * Nothing else is added, and in particular not the Archon home: a reply that can
 * reach a chat should not be able to reach the install's own files, however
 * unlikely it is that any of them would pass the header check.
 */
export function outboundImageRoots(
  cwds: readonly (string | null | undefined)[]
): readonly string[] {
  const named = cwds.filter(
    (cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0 && isAbsolute(cwd)
  );
  return [...new Set([...named, tmpdir()])];
}

/** True when `child` is `parent` itself or lies under it. Both must already be real paths. */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/** The real paths of the roots that exist; one that does not exist cannot contain anything. */
async function realRoots(roots: readonly string[]): Promise<readonly string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    const real = await realpath(root).catch(() => null);
    if (real !== null) resolved.push(real);
  }
  return resolved;
}

/** The first `HEADER_BYTES` of a file, or null when it cannot be read. */
async function readHeader(path: string): Promise<Uint8Array | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (handle === null) return null;
  try {
    const buffer = new Uint8Array(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.slice(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Decide whether one named path may be delivered as a picture.
 *
 * Cheap checks first, so a path that was never going to qualify costs no
 * filesystem work — and so that an answer full of prose paths does not turn into
 * a burst of stat calls.
 */
export async function resolveOutboundImage(
  candidate: string,
  roots: readonly string[]
): Promise<OutboundImage> {
  if (!isAbsolute(candidate)) return { ok: false, reason: 'not_absolute' };
  const extension = EXTENSION.exec(candidate)?.[1]?.toLowerCase();
  if (extension === undefined || !ALLOWED_EXTENSIONS.has(extension)) {
    return { ok: false, reason: 'unsupported_extension' };
  }

  const real = await realpath(candidate).catch(() => null);
  if (real === null) return { ok: false, reason: 'unreadable' };

  const allowed = await realRoots(roots);
  if (!allowed.some(root => isInside(real, root))) {
    return { ok: false, reason: 'outside_allowed_roots' };
  }

  const stats = await stat(real).catch(() => null);
  if (stats === null) return { ok: false, reason: 'unreadable' };
  if (!stats.isFile()) return { ok: false, reason: 'not_a_file' };
  if (stats.size > MAX_OUTBOUND_IMAGE_BYTES) return { ok: false, reason: 'too_large' };

  const header = await readHeader(real);
  if (header === null) return { ok: false, reason: 'unreadable' };
  const signature = SIGNATURES.find(candidateSignature => candidateSignature.matches(header));
  if (signature === undefined) return { ok: false, reason: 'not_an_image' };

  return { ok: true, path: real, mediaType: signature.mediaType, size: stats.size };
}
