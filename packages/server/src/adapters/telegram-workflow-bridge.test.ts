import { describe, expect, test } from 'bun:test';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';
import { TurnStatus, type StatusTransport } from '@archon/adapters';
import { watchWorkflowOnTelegram, type WorkflowEventSource } from './telegram-workflow-bridge';

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

class FakeTransport implements StatusTransport {
  readonly sent: string[] = [];
  readonly edited: string[] = [];
  readonly removed: number[] = [];
  #nextId = 1;
  async send(text: string): Promise<number | null> {
    this.sent.push(text);
    return this.#nextId++;
  }
  async edit(_messageId: number, text: string): Promise<void> {
    this.edited.push(text);
  }
  async remove(messageId: number): Promise<boolean> {
    this.removed.push(messageId);
    return true;
  }
  async typing(): Promise<void> {
    /* nothing to record */
  }
}

/** One conversation's listeners, fired by hand. */
class FakeEvents implements WorkflowEventSource {
  readonly listeners = new Map<string, (event: WorkflowEmitterEvent) => void>();
  subscribeForConversation(
    conversationId: string,
    listener: (event: WorkflowEmitterEvent) => void
  ): () => void {
    this.listeners.set(conversationId, listener);
    return () => this.listeners.delete(conversationId);
  }
  fire(conversationId: string, event: WorkflowEmitterEvent): void {
    this.listeners.get(conversationId)?.(event);
  }
}

const dispatch = { workerConversationId: 'worker-1', workflowName: 'nightly-audit' };

describe('watchWorkflowOnTelegram', () => {
  test('names the running node and the model it runs on', async () => {
    const transport = new FakeTransport();
    const events = new FakeEvents();
    const status = new TurnStatus(transport, { throttleMs: 10 });

    const cleanup = watchWorkflowOnTelegram(events, status, dispatch);
    await tick(5);
    events.fire('worker-1', {
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'lint',
      nodeName: 'lint',
      provider: 'claude',
      model: 'claude-haiku-4-5',
    });
    await tick(30);

    expect(transport.sent).toEqual(['⏳ Running workflow nightly-audit…']);
    expect(transport.edited).toEqual([
      '⏳ Running workflow nightly-audit (node: lint)…\nclaude · claude-haiku-4-5',
    ]);
    cleanup();
  });

  test('a node with no model drops the previous node’s model', async () => {
    const transport = new FakeTransport();
    const events = new FakeEvents();
    const status = new TurnStatus(transport, { throttleMs: 10 });

    const cleanup = watchWorkflowOnTelegram(events, status, dispatch);
    events.fire('worker-1', {
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'plan',
      nodeName: 'plan',
      provider: 'claude',
    });
    await tick(30);
    events.fire('worker-1', {
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'check',
      nodeName: 'check',
    });
    await tick(30);

    expect([...transport.sent, ...transport.edited].at(-1)).toBe(
      '⏳ Running workflow nightly-audit (node: check)…'
    );
    cleanup();
  });

  test('the cleanup unsubscribes and takes the line down', async () => {
    const transport = new FakeTransport();
    const events = new FakeEvents();
    const status = new TurnStatus(transport, { throttleMs: 10 });

    const cleanup = watchWorkflowOnTelegram(events, status, dispatch);
    await tick(5);
    cleanup();
    await tick(5);

    expect(events.listeners.size).toBe(0);
    expect(transport.removed).toEqual([1]);
  });
});
