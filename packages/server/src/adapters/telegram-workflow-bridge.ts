/**
 * A workflow dispatched from a Telegram chat, followed on the phone.
 *
 * The console learns a dispatched run's progress from the web adapter's event
 * bridge; Telegram had nothing, so after "🚀 Dispatching workflow" the chat went
 * quiet until the result card. This is the Telegram half of the same seam
 * (`IPlatformAdapter.watchDispatchedWorkflow`): its own status line, separate
 * from the turn's — the turn that dispatched the run ends at once and takes its
 * line with it, while the run goes on for as long as it runs.
 *
 * The line is taken down by the cleanup the dispatcher calls when the run's
 * execution returns, not by reading terminal events here: the dispatcher owns
 * when a run is over, and a paused run (an approval gate) returns too — it
 * then says so in the chat itself, and a "Running…" line above that message
 * would be untrue.
 */
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';
import { describeWorkflowNode, formatModelLabel, type TurnStatus } from '@archon/adapters';

/** The one emitter call this needs — a port so the lifecycle is testable without the engine. */
export interface WorkflowEventSource {
  subscribeForConversation(
    conversationId: string,
    listener: (event: WorkflowEmitterEvent) => void
  ): () => void;
}

export function watchWorkflowOnTelegram(
  events: WorkflowEventSource,
  status: TurnStatus,
  dispatch: { workerConversationId: string; workflowName: string }
): () => void {
  status.step(describeWorkflowNode(dispatch.workflowName));
  const unsubscribe = events.subscribeForConversation(dispatch.workerConversationId, event => {
    if (event.type !== 'node_started') return;
    status.step(describeWorkflowNode(dispatch.workflowName, event.nodeName));
    // Only AI nodes carry a provider. The model line always follows the node
    // it belongs to — a bash node after an AI node must not keep showing the
    // AI node's model as if it were running on it.
    status.showModel(
      event.provider === undefined ? null : formatModelLabel(event.provider, event.model)
    );
  });
  return () => {
    unsubscribe();
    void status.clear();
  };
}
