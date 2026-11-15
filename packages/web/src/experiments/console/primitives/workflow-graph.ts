/**
 * Workflow DAG primitives — just enough to render a compact graph in the
 * run-detail sidebar. We don't need the full `DagNode` shape from the
 * production API; we only care about id + dependencies + kind + status.
 */

import type { components } from '@/lib/api.generated';
import type { RunNodeState } from './event';

export type WorkflowNodeKind =
  | 'prompt'
  | 'command'
  | 'bash'
  | 'script'
  | 'approval'
  | 'wait'
  | 'loop'
  | 'cancel';

export type WorkflowNodeStatus = RunNodeState['state'];

export interface WorkflowGraphNode {
  id: string;
  dependsOn: string[];
  kind: WorkflowNodeKind;
}

export interface WorkflowGraphNodeWithStatus extends WorkflowGraphNode {
  status: WorkflowNodeStatus;
}

/**
 * Attach the engine's state to each graph node. A node the engine has not
 * listed has not been reached, which the engine itself reports as `pending`.
 */
export function deriveNodeStatuses(
  graphNodes: WorkflowGraphNode[],
  nodes: readonly RunNodeState[]
): WorkflowGraphNodeWithStatus[] {
  const stateById = new Map(nodes.map(n => [n.node_id, n.state]));
  return graphNodes.map(n => ({ ...n, status: stateById.get(n.id) ?? 'pending' }));
}

/**
 * A node as the workflow LIST endpoint serves it: the engine's transform has already rewritten
 * what the author wrote (`command:` → `kind: 'agent'` + `source`, `bash:` → an exec node whose
 * runtime is the shell). The generated `DagNode` schema describes only the authoring form, so
 * the transformed fields are added here (`runtime` widens: a transformed bash node carries `sh`,
 * which the authored script runtime does not admit); a definition that has not been through the
 * transform still carries the authoring fields.
 */
export type ServedDagNode = Omit<components['schemas']['DagNode'], 'runtime'> & {
  kind?: string;
  source?: { kind?: string };
  runtime?: string;
};

export function nodeKind(n: ServedDagNode): WorkflowNodeKind {
  // The transformed form first: it is what the endpoint actually serves, and reading the
  // authoring fields alone made every command node in the graph render as a prompt.
  switch (n.kind) {
    case 'agent':
      return n.source?.kind === 'command' ? 'command' : 'prompt';
    case 'exec':
      return n.runtime === 'sh' ? 'bash' : 'script';
    case 'gate':
      return 'approval';
    case 'wait':
      return 'wait';
    case 'halt':
      return 'cancel';
    case 'loop':
    case 'loop_group':
      return 'loop';
    default:
      break;
  }
  if (n.loop !== undefined) return 'loop';
  if (n.approval !== undefined) return 'approval';
  if (n.wait !== undefined) return 'wait';
  if (n.cancel !== undefined) return 'cancel';
  if (n.bash !== undefined) return 'bash';
  if (n.command !== undefined) return 'command';
  if (n.script !== undefined) return 'script';
  return 'prompt';
}
