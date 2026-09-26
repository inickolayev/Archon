import { describe, expect, test } from 'bun:test';
import { applyWorkflowNodeEvent, formatModelLabel, type NodeModelLabels } from './live-model';
import type { WorkflowNodeEvent } from './sse';

const node = (over: Partial<WorkflowNodeEvent>): WorkflowNodeEvent => ({
  type: 'dag_node',
  runId: 'run-1',
  nodeId: 'lint',
  name: 'lint',
  status: 'running',
  timestamp: 0,
  ...over,
});

describe('formatModelLabel', () => {
  test('provider and model, or the provider alone', () => {
    expect(formatModelLabel('claude', 'claude-haiku-4-5')).toBe('claude · claude-haiku-4-5');
    expect(formatModelLabel('codex')).toBe('codex');
  });
});

describe('applyWorkflowNodeEvent', () => {
  const empty: NodeModelLabels = new Map();

  test('a node started on a model gains a label', () => {
    const labels = applyWorkflowNodeEvent(
      empty,
      node({ provider: 'claude', model: 'claude-haiku-4-5' })
    );
    expect(labels.get('run-1')?.get('lint')).toBe('claude · claude-haiku-4-5');
  });

  test('a finished node loses it, and an emptied run is dropped', () => {
    const started = applyWorkflowNodeEvent(empty, node({ provider: 'claude' }));
    const done = applyWorkflowNodeEvent(started, node({ status: 'completed' }));
    expect(done.has('run-1')).toBe(false);
  });

  test('a node with no model gets no label', () => {
    expect(applyWorkflowNodeEvent(empty, node({}))).toBe(empty);
  });

  test('parallel nodes keep their own labels', () => {
    let labels = applyWorkflowNodeEvent(empty, node({ provider: 'claude' }));
    labels = applyWorkflowNodeEvent(
      labels,
      node({ nodeId: 'review', name: 'review', provider: 'codex', model: 'gpt-5.5' })
    );
    expect([...(labels.get('run-1')?.entries() ?? [])]).toEqual([
      ['lint', 'claude'],
      ['review', 'codex · gpt-5.5'],
    ]);
  });
});
