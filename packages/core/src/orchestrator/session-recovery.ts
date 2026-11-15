/**
 * Answering the first message after a restart instead of erroring on it.
 *
 * A turn resumes the provider session recorded on the conversation. When that
 * session is gone — the usual cause is that Archon was restarted and the
 * provider's own state went with the process — the provider does not fail the
 * call outright; it ends the stream with an error `result` naming the id it
 * could not resume. The orchestrator used to clear the id and relay that error
 * to the operator ("Session error. Use /reset…"), so the first message after
 * every restart was answered with a warning and had to be sent again.
 *
 * Retrying is safe precisely here and nowhere else. The session was never
 * restored, so nothing ran: no tool was called, no text was produced, no money
 * was spent on work that would be repeated. The only thing lost is the memory,
 * and `conversation-replay.ts` rebuilds that from the durable message rows.
 * The second attempt therefore starts a fresh session with the record of the
 * conversation in front of it, and the operator sees one answer where they used
 * to see a warning.
 *
 * WHEN to retry is not decided here. The provider states the fact
 * (`sessionNotFound` on its result, from a structured check) and
 * `withStaleResumeRetry` owns the policy chat turns share with workflow nodes:
 * only when a resume was attempted, only before the turn produced output or ran
 * a tool, and at most once. What this module adds is what the retry carries —
 * the conversation's record in front of the prompt — and who is told.
 */
import type { MessageChunk } from '@archon/providers/types';
import { withStaleResumeRetry } from '@archon/workflows/stale-resume';

export interface SessionRecoveryInput {
  /** Run one attempt. Called at most twice. */
  readonly sendQuery: (prompt: string, resumeSessionId?: string) => AsyncIterable<MessageChunk>;
  /** The prompt this turn would have sent on its own. */
  readonly prompt: string;
  /** The session being resumed, or undefined when the turn starts fresh. */
  readonly resumeSessionId?: string;
  /** Identifies the turn in the retry log; never prompt text or a full session id. */
  readonly logContext: Record<string, unknown>;
  /**
   * The conversation's history as a prompt block, or `''` when there is none
   * worth replaying. Called only on the recovery path, so a healthy turn pays
   * nothing for it. Must not throw.
   */
  readonly loadReplay: () => Promise<string>;
  /** Forget the dead session id. Called before the retry, and must not throw. */
  readonly onSessionLost: (staleSessionId: string) => Promise<void>;
  /** Tell whoever is watching that this turn was recovered. Must not throw. */
  readonly onRecovered?: (info: { readonly replayed: boolean }) => Promise<void>;
}

/** Separates the replayed record from the turn's own prompt. */
const REPLAY_SEPARATOR = '\n\n---\n\n';

/**
 * Wrap a provider stream so a turn whose session has vanished is answered
 * rather than reported. Passes every chunk straight through in the ordinary
 * case; see the module comment for when it does not.
 */
export function withRecoveredSession(input: SessionRecoveryInput): AsyncGenerator<MessageChunk> {
  const { sendQuery, prompt, resumeSessionId, loadReplay, onSessionLost, onRecovered } = input;
  // Only the fresh attempt that follows a lost session ever sees anything else.
  let freshPrompt = prompt;
  return withStaleResumeRetry(
    resumeId => sendQuery(resumeId === undefined ? freshPrompt : prompt, resumeId),
    resumeSessionId,
    {
      logContext: input.logContext,
      onRetry: async staleSessionId => {
        await onSessionLost(staleSessionId);
        const replay = await loadReplay();
        freshPrompt = replay.length > 0 ? replay + REPLAY_SEPARATOR + prompt : prompt;
        await onRecovered?.({ replayed: replay.length > 0 });
      },
    }
  );
}
