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
 * Two guards keep that narrow:
 *
 * - Only when a resume was actually ATTEMPTED. A turn that already started
 *   fresh cannot have lost a session, and its errors are real errors.
 * - Only while nothing has reached the operator yet. Once a chunk the platform
 *   renders has gone out, re-running the turn would produce a second answer
 *   beside the first; that case falls through to the handler's existing error
 *   path, unchanged.
 *
 * The retry cannot recurse: it passes no resume id, so the branch that triggers
 * it cannot be reached a second time.
 */
import type { MessageChunk } from '@archon/providers/types';

/**
 * The provider's way of saying "that session is not here".
 *
 * `error_during_execution` on a turn that asked to resume is the Claude SDK's
 * shape for a resume that found nothing — the same condition the orchestrator
 * already recognised when it cleared the stored id. It is matched on the chunk
 * rather than on message text so a wording change upstream cannot silently turn
 * recovery off.
 */
export function isLostSessionResult(chunk: MessageChunk): boolean {
  return (
    chunk.type === 'result' &&
    chunk.isError === true &&
    chunk.errorSubtype === 'error_during_execution'
  );
}

/**
 * Whether a chunk is something the operator could already have seen.
 *
 * System chunks are provider warnings the chat handlers drop on the floor, so
 * one arriving ahead of the failure must not be what stops a recovery. Anything
 * that renders — text, a tool call, its result — does.
 */
function isDeliverable(chunk: MessageChunk): boolean {
  if (chunk.type === 'assistant') return chunk.content.length > 0;
  return chunk.type === 'tool' || chunk.type === 'tool_result';
}

export interface SessionRecoveryInput {
  /** Run one attempt. The wrapper calls this at most twice. */
  readonly sendQuery: (prompt: string, resumeSessionId?: string) => AsyncGenerator<MessageChunk>;
  /** The prompt this turn would have sent on its own. */
  readonly prompt: string;
  /** The session being resumed, or undefined when the turn starts fresh. */
  readonly resumeSessionId?: string;
  /**
   * The conversation's history as a prompt block, or `''` when there is none
   * worth replaying. Called only on the recovery path, so a healthy turn pays
   * nothing for it. Must not throw.
   */
  readonly loadReplay: () => Promise<string>;
  /** Forget the dead session id. Called before the retry, and must not throw. */
  readonly onSessionLost: (staleSessionId: string | undefined) => Promise<void>;
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
export async function* withRecoveredSession(
  input: SessionRecoveryInput
): AsyncGenerator<MessageChunk> {
  const { sendQuery, prompt, resumeSessionId, loadReplay, onSessionLost, onRecovered } = input;
  let delivered = false;

  for await (const chunk of sendQuery(prompt, resumeSessionId)) {
    if (resumeSessionId !== undefined && !delivered && isLostSessionResult(chunk)) {
      const staleSessionId = chunk.type === 'result' ? chunk.sessionId : undefined;
      await onSessionLost(staleSessionId);
      const replay = await loadReplay();
      await onRecovered?.({ replayed: replay.length > 0 });
      const recoveredPrompt = replay.length > 0 ? replay + REPLAY_SEPARATOR + prompt : prompt;
      // No resume id: this attempt starts the session the conversation will
      // carry from here, and cannot re-enter the branch above.
      yield* sendQuery(recoveredPrompt, undefined);
      return;
    }
    if (isDeliverable(chunk)) delivered = true;
    yield chunk;
  }
}
