/**
 * Read a node's command or script reference for display.
 *
 * Inside a workflow pack the engine rewrites `command: announce` into
 * `__archon_pack__global:chesswin:announce::announce` — the qualification is what makes the
 * reference resolvable, and it is unreadable. `GET /api/workflows` serves the qualified form
 * while `GET /api/workflows/:name` serves the bare one, so any surface showing a reference may
 * get either. This turns both into the name plus, when there is one, the pack it belongs to.
 */

const PREFIX = '__archon_pack__';
const OWNER_SEPARATOR = ':';
const RESOURCE_SEPARATOR = '::';

/** The pack a qualified reference belongs to. */
export interface ResourceOwner {
  /** Which scope the pack lives in: project, global, bundled or installed. */
  scope: string;
  pack: string;
  workflow: string;
}

export interface ResourceRef {
  /** The name as its author wrote it, with the qualification removed. */
  name: string;
  /** The pack, for a qualified reference; `null` for a bare name. */
  owner: ResourceOwner | null;
}

/**
 * Split a reference into its name and its pack.
 *
 * A reference that starts with the prefix but does not parse (a future shape, a truncated
 * string) is returned verbatim as a bare name: showing it unchanged is better than showing
 * a wrong half of it.
 */
export function describeResourceRef(reference: string): ResourceRef {
  if (!reference.startsWith(PREFIX)) return { name: reference, owner: null };
  const marker = reference.indexOf(RESOURCE_SEPARATOR, PREFIX.length);
  if (marker < 0) return { name: reference, owner: null };
  const owner = reference.slice(PREFIX.length, marker).split(OWNER_SEPARATOR);
  const name = reference.slice(marker + RESOURCE_SEPARATOR.length);
  if (owner.length !== 3 || name.length === 0) return { name: reference, owner: null };
  const [scope, pack, workflow] = owner;
  return { name, owner: { scope, pack, workflow } };
}

/** `pack/workflow` — how a pack is named in the console, matching its folders on disk. */
export function packLabel(owner: ResourceOwner): string {
  return `${owner.pack}/${owner.workflow}`;
}
