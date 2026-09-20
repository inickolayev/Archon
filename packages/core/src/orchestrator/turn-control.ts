/**
 * Calling off a turn that is already running.
 *
 * A misread instruction used to be unstoppable: once `handleMessage` had
 * reached the provider, the only thing the operator could do was watch it
 * finish. The provider contract already carries an `abortSignal` — every
 * provider forwards it to its SDK, which kills the subprocess — so the missing
 * piece was never cancellation itself but a way to reach the signal from
 * outside the turn.
 *
 * This is that handle, and nothing more: one live turn per conversation,
 * addressed by the same platform conversation id the console and the bot
 * already speak in, so a stop from either window lands on the same turn. The
 * conversation LOCK is untouched — the aborted turn returns normally, its
 * handler resolves, and the lock manager releases and drains its queue exactly
 * as it does after any other turn.
 */

import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('turn-control');
  return cachedLog;
}

/** A turn's end of the handle, held by `handleMessage` for its duration. */
export interface RunningTurn {
  /** Passed to the provider so the abort reaches its subprocess. */
  readonly signal: AbortSignal;
  /** True once an operator asked for this turn to stop. */
  wasStopped(): boolean;
  /** Give the handle up. Safe to call twice, and never stops anything. */
  release(): void;
}

interface Registration {
  readonly controller: AbortController;
  stopped: boolean;
}

const running = new Map<string, Registration>();

/**
 * Claim the conversation for the turn that is about to run.
 *
 * A second `begin` for the same conversation replaces the first rather than
 * refusing it: the lock manager already serializes turns per conversation, so
 * an overlap here means a nested or re-entrant call, and the innermost turn is
 * the one a stop should reach. `release` only clears the map when the entry is
 * still this turn's, so the outer turn's release cannot orphan the inner one.
 */
export function beginTurn(conversationId: string): RunningTurn {
  const registration: Registration = { controller: new AbortController(), stopped: false };
  running.set(conversationId, registration);
  return {
    signal: registration.controller.signal,
    wasStopped: () => registration.stopped,
    release: (): void => {
      if (running.get(conversationId) === registration) running.delete(conversationId);
    },
  };
}

/**
 * Stop the turn running in this conversation. Returns false when there is
 * nothing to stop — a queued message, or simply an idle chat — so the caller
 * can say so instead of claiming an abort that never happened.
 */
export function stopTurn(conversationId: string): boolean {
  const registration = running.get(conversationId);
  if (registration === undefined) return false;
  // Marked before the abort so the turn's own catch, which may run
  // synchronously off the abort, already sees the operator's intent.
  registration.stopped = true;
  registration.controller.abort();
  getLog().info({ conversationId }, 'turn_stopped');
  return true;
}

/** Whether a turn is in flight for this conversation. */
export function isTurnRunning(conversationId: string): boolean {
  return running.has(conversationId);
}

/**
 * The turn's own last word, written into the conversation by `handleMessage`
 * and therefore delivered — and persisted — like any other reply. This is the
 * record; the two below only acknowledge the gesture that asked for it.
 */
export const TURN_STOPPED_NOTICE = '⏹ Stopped — the agent was called off by the operator.';

/** Acknowledges the button or command, on the surface that carried it. */
export const STOP_REQUESTED_NOTICE = 'Stopping the agent — it will say so in the chat.';

/** What a stop says when the conversation was not doing anything. */
export const NOTHING_RUNNING_NOTICE = 'Nothing is running in this chat right now.';
