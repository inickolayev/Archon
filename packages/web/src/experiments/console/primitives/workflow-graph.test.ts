import { describe, test, expect } from 'bun:test';
import { deriveNodeStatuses, nodeKind, type WorkflowGraphNode } from './workflow-graph';

describe('deriveNodeStatuses', () => {
  const graph: WorkflowGraphNode[] = [
    { id: 'prepare', dependsOn: [], kind: 'bash' },
    { id: 'flaky', dependsOn: ['prepare'], kind: 'prompt' },
    { id: 'report', dependsOn: ['flaky'], kind: 'prompt' },
  ];

  test("each graph node takes the engine's state, and an unlisted node is pending", () => {
    const statuses = deriveNodeStatuses(graph, [
      { node_id: 'prepare', state: 'pending' },
      { node_id: 'flaky', state: 'failed', error: 'boom' },
    ]);
    expect(statuses.map(n => [n.id, n.status])).toEqual([
      ['prepare', 'pending'],
      ['flaky', 'failed'],
      ['report', 'pending'],
    ]);
  });
});

describe('nodeKind — the transformed shape the endpoint actually serves', () => {
  test('a command node is a command, not a prompt', () => {
    expect(nodeKind({ id: 'write', kind: 'agent', source: { kind: 'command' } })).toBe('command');
  });

  test('an inline agent node is a prompt', () => {
    expect(nodeKind({ id: 'ask', kind: 'agent', source: { kind: 'inline' } })).toBe('prompt');
  });

  test('an exec node with the shell runtime is bash; any other runtime is a script', () => {
    expect(nodeKind({ id: 'build', kind: 'exec', runtime: 'sh' })).toBe('bash');
    expect(nodeKind({ id: 'deliver', kind: 'exec', runtime: 'uv' })).toBe('script');
  });

  test('gate, halt and loop group read as their palette names', () => {
    expect(nodeKind({ id: 'gate', kind: 'gate' })).toBe('approval');
    expect(nodeKind({ id: 'stop', kind: 'halt' })).toBe('cancel');
    expect(nodeKind({ id: 'each', kind: 'loop_group' })).toBe('loop');
  });

  test('a definition still in authoring shape keeps reading correctly', () => {
    expect(nodeKind({ id: 'write', command: 'announce' })).toBe('command');
    expect(nodeKind({ id: 'build', bash: 'make' })).toBe('bash');
  });
});
