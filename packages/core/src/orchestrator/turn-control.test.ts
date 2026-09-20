import { describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({ createLogger: mock(() => mockLogger) }));

const { beginTurn, isTurnRunning, stopTurn } = await import('./turn-control');
const { ConversationLockManager } = await import('../utils/conversation-lock');

/**
 * Drains microtasks until the world looks the way the test expects. Nothing
 * here sleeps: an abort and a lock handoff both settle on the microtask queue,
 * so a bounded drain converges without touching the clock and turns a broken
 * handoff into a failure rather than a hang.
 */
async function drainUntil(predicate: () => boolean, expectation: string): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`never reached expected state: ${expectation}`);
}

/** A turn that runs until its signal aborts, then throws the way a provider does. */
function abortableWork(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('Query aborted'));
    });
  });
}

describe('beginTurn / stopTurn', () => {
  test('a stop aborts the running turn and is reported as stopped', async () => {
    const turn = beginTurn('conv-1');
    const running = abortableWork(turn.signal);

    expect(stopTurn('conv-1')).toBe(true);
    expect(turn.wasStopped()).toBe(true);
    await expect(running).rejects.toThrow('Query aborted');
    turn.release();
  });

  test('a stop for an idle conversation answers false and aborts nothing', () => {
    expect(isTurnRunning('conv-idle')).toBe(false);
    expect(stopTurn('conv-idle')).toBe(false);
  });

  test('a released turn can no longer be stopped', () => {
    const turn = beginTurn('conv-2');
    turn.release();
    expect(isTurnRunning('conv-2')).toBe(false);
    expect(stopTurn('conv-2')).toBe(false);
    expect(turn.wasStopped()).toBe(false);
  });

  test('the next turn gets a fresh signal rather than the stopped one', () => {
    const first = beginTurn('conv-3');
    stopTurn('conv-3');
    first.release();

    const second = beginTurn('conv-3');
    expect(second.signal.aborted).toBe(false);
    expect(second.wasStopped()).toBe(false);
    second.release();
  });

  test('a nested turn is the one a stop reaches, and the outer release leaves it alone', () => {
    const outer = beginTurn('conv-4');
    const inner = beginTurn('conv-4');

    expect(stopTurn('conv-4')).toBe(true);
    expect(inner.wasStopped()).toBe(true);
    expect(outer.wasStopped()).toBe(false);

    // The outer handle is stale — releasing it must not clear the inner entry.
    outer.release();
    expect(isTurnRunning('conv-4')).toBe(true);
    inner.release();
    expect(isTurnRunning('conv-4')).toBe(false);
  });

  test('two conversations are stopped independently', () => {
    const a = beginTurn('conv-a');
    const b = beginTurn('conv-b');
    stopTurn('conv-a');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    a.release();
    b.release();
  });
});

/**
 * The half that would be worse than no stop at all: a stop that aborted the
 * work but left the conversation lock held would wedge the chat for good.
 * Nothing in turn-control touches the lock — the aborted turn simply returns
 * through its own handler — and this pins that the queue drains afterwards.
 */
describe('stopping a turn and the conversation lock', () => {
  test('the lock is released and the queued message runs', async () => {
    const manager = new ConversationLockManager();
    const started: string[] = [];

    void manager.acquireLock('conv-5', async () => {
      const turn = beginTurn('conv-5');
      started.push('first');
      try {
        await abortableWork(turn.signal);
      } catch {
        // What handleMessage does with an aborted turn: swallow it, say so, end.
      } finally {
        turn.release();
      }
    });
    await drainUntil(() => started.length === 1, 'the first turn started');

    // Queued behind the running turn — the operator's correction, which must
    // survive the stop rather than being thrown away with it.
    void manager.acquireLock('conv-5', async () => {
      started.push('queued');
    });
    expect(manager.getStats().queuedTotal).toBe(1);

    expect(stopTurn('conv-5')).toBe(true);

    await drainUntil(() => started.length === 2, 'the queued message ran after the stop');
    expect(started).toEqual(['first', 'queued']);
    await drainUntil(() => manager.getStats().active === 0, 'the lock was released');
    expect(manager.getStats().queuedTotal).toBe(0);
    expect(isTurnRunning('conv-5')).toBe(false);
  });
});
