/**
 * Live "which model is this running on" state for the chat view.
 *
 * Nothing here is persisted: it is rebuilt from the conversation stream as
 * events arrive (`model_info` for a chat turn, `dag_node` for the nodes of a
 * workflow this chat dispatched), and a reload simply starts empty until the
 * next event says otherwise.
 */
import type { WorkflowNodeEvent } from './sse';

/** `claude · opus`, or the provider alone when its own default applies. */
export function formatModelLabel(provider: string, model?: string): string {
  return model === undefined ? provider : `${provider} · ${model}`;
}

/** runId → running node name → the model label it runs on. */
export type NodeModelLabels = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Fold one node event into the labels. A node gains a label when it starts on
 * a model and loses it on any other transition — a finished node is not
 * running on anything, and a bash node after an AI node must not inherit it.
 */
export function applyWorkflowNodeEvent(
  labels: NodeModelLabels,
  event: WorkflowNodeEvent
): NodeModelLabels {
  const current = labels.get(event.runId);
  const label =
    event.status === 'running' && event.provider !== undefined
      ? formatModelLabel(event.provider, event.model)
      : undefined;
  // Unchanged: hand back the same object so React skips the re-render.
  if (current?.get(event.name) === label) return labels;
  const nodes = new Map(current ?? []);
  if (label === undefined) nodes.delete(event.name);
  else nodes.set(event.name, label);
  const next = new Map(labels);
  if (nodes.size === 0) next.delete(event.runId);
  else next.set(event.runId, nodes);
  return next;
}
