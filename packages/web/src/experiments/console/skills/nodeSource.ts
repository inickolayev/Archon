/**
 * Read the file one node of a workflow runs.
 *
 * A command node names a markdown file and a script node names a script; neither is readable
 * from the definition alone, and the name in a pack is qualified beyond recognition. The
 * server resolves it in the workflow's own context — the same resolution a run uses — so what
 * arrives here is the file that would actually be read, with the path it came from.
 */
import { buildApiUrl, requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/** The resolved file behind one node. `runtime` is present for scripts only. */
export type NodeSource = components['schemas']['ResourceSourceResponse'];

/** Build the path, encoding both names: a pack-qualified reference carries `:` and `/`. */
export function buildNodeSourcePath(workflowName: string, nodeId: string, cwd?: string): string {
  return buildApiUrl('/api/workflows/{name}/nodes/{nodeId}/source', 'get', {
    params: { name: workflowName, nodeId },
    query: { cwd },
  });
}

/**
 * Fetch one node's file. Throws `HttpError` with status 404 both when the workflow or node is
 * gone and when the node runs no file at all (an inline prompt, an inline bash body) — the
 * server's message says which, and the panel shows that message rather than inventing one.
 */
export function getNodeSource(
  workflowName: string,
  nodeId: string,
  cwd?: string
): Promise<NodeSource> {
  return requestJson('/api/workflows/{name}/nodes/{nodeId}/source', 'get', {
    params: { name: workflowName, nodeId },
    query: { cwd },
  });
}
