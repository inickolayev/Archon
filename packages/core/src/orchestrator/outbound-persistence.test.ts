import { describe, expect, mock, test, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import type { IPlatformAdapter } from '../types';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({ createLogger: mock(() => mockLogger) }));

/** Records what would have been written, and when relative to delivery. */
const written: { role: string; content: string; metadata: unknown }[] = [];
const mockAddMessage = mock(
  async (_convId: string, role: string, content: string, metadata?: unknown) => {
    written.push({ role, content, metadata });
    return { id: `msg-${String(written.length)}` };
  }
);
mock.module('../db/messages', () => ({ addMessage: mockAddMessage }));

const { withPersistedOutbound } = await import('./outbound-persistence');

/** A stream-mode adapter that records every bubble it was asked to deliver. */
function fakeAdapter(): IPlatformAdapter & { delivered: string[] } {
  const delivered: string[] = [];
  return {
    delivered,
    sendMessage: async (_id, message) => {
      delivered.push(message);
    },
    ensureThread: async id => id,
    getStreamingMode: () => 'stream',
    getPlatformType: () => 'telegram',
    start: async () => undefined,
    stop: () => undefined,
  };
}

describe('withPersistedOutbound', () => {
  beforeEach(() => {
    written.length = 0;
    mockAddMessage.mockClear();
  });

  test('every delivered bubble becomes a row, in delivery order', async () => {
    const adapter = fakeAdapter();
    const wrapped = withPersistedOutbound(adapter, 'conv-db-1');

    await wrapped.sendMessage('conv-1', 'first');
    await wrapped.sendMessage('conv-1', 'second');
    await wrapped.sendMessage('conv-1', 'third');

    // One row per bubble, not one row for the turn: on a streaming adapter each
    // send IS a message on the phone, so this is what the operator saw.
    expect(adapter.delivered).toEqual(['first', 'second', 'third']);
    expect(written.map(w => w.content)).toEqual(['first', 'second', 'third']);
    expect(written.every(w => w.role === 'assistant')).toBe(true);
  });

  test('rows land in delivery order even when the caller does not wait', async () => {
    const adapter = fakeAdapter();
    const wrapped = withPersistedOutbound(adapter, 'conv-db-1');

    // Writes are chained rather than fired off independently: the reader breaks
    // a tie on a random uuid, so two rows racing is two rows in no order.
    await Promise.all([
      wrapped.sendMessage('conv-1', 'a'),
      wrapped.sendMessage('conv-1', 'b'),
      wrapped.sendMessage('conv-1', 'c'),
    ]);

    expect(written.map(w => w.content)).toEqual(['a', 'b', 'c']);
  });

  test('structural messages are delivered decisions, not chat — no row', async () => {
    const adapter = fakeAdapter();
    const wrapped = withPersistedOutbound(adapter, 'conv-db-1');

    await wrapped.sendMessage('conv-1', '✏️READ /Users/x/artifacts/a.jpg', {
      category: 'tool_call_formatted',
    });
    await wrapped.sendMessage('conv-1', 'working in a worktree', {
      category: 'isolation_context',
    });
    await wrapped.sendMessage('conv-1', '   ');
    await wrapped.sendMessage('conv-1', 'a real answer');

    expect(written.map(w => w.content)).toEqual(['a real answer']);
  });

  test('a workflow result keeps the metadata the follow-up context reads', async () => {
    const adapter = fakeAdapter();
    const wrapped = withPersistedOutbound(adapter, 'conv-db-1');

    await wrapped.sendMessage('conv-1', 'plan finished', {
      category: 'workflow_result',
      workflowResult: { workflowName: 'plan', runId: 'run-1' },
    });

    // getRecentWorkflowResultMessages filters on metadata->>'workflowResult';
    // a bare row would be invisible to it, as every non-web row used to be.
    expect(written[0]?.metadata).toEqual({
      category: 'workflow_result',
      workflowResult: { workflowName: 'plan', runId: 'run-1' },
    });
  });

  test('a database that is down costs the history, never the answer', async () => {
    const adapter = fakeAdapter();
    const wrapped = withPersistedOutbound(adapter, 'conv-db-1');
    mockAddMessage.mockImplementationOnce(() => Promise.reject(new Error('db down')));

    await wrapped.sendMessage('conv-1', 'the answer');

    expect(adapter.delivered).toEqual(['the answer']);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('every other member is forwarded untouched', async () => {
    const adapter = fakeAdapter();
    const wrapped = withPersistedOutbound(adapter, 'conv-db-1');

    expect(wrapped.getPlatformType()).toBe('telegram');
    expect(wrapped.getStreamingMode()).toBe('stream');
    expect(await wrapped.ensureThread('conv-1')).toBe('conv-1');
  });
});
