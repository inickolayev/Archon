import { describe, expect, test } from 'bun:test';
import { composedNodeKind, toAuthoringNode } from './authoring-shape';
import { fromWorkflowDefinition } from './from-workflow';
import type { WireDagNode, WireWorkflowDefinition } from '../types';

/**
 * The served shapes below are copied from what `GET /api/workflows` actually returns for a
 * workflow of each kind — that response, not the generated type, is what the builder reads.
 */
function served(node: Record<string, unknown>): WireDagNode {
  return node as unknown as WireDagNode;
}

describe('toAuthoringNode', () => {
  test('a command node comes back with its command name and bindings', () => {
    expect(
      toAuthoringNode(
        served({
          id: 'write',
          depends_on: ['recipients'],
          model: 'medium',
          kind: 'agent',
          source: {
            kind: 'command',
            name: '__archon_pack__global:chesswin:announce::announce',
            with: { facts: '$INPUTS.facts' },
          },
        })
      )
    ).toEqual(
      served({
        id: 'write',
        depends_on: ['recipients'],
        model: 'medium',
        command: '__archon_pack__global:chesswin:announce::announce',
        with: { facts: '$INPUTS.facts' },
      })
    );
  });

  test('an inline agent node comes back as a prompt', () => {
    expect(
      toAuthoringNode(
        served({ id: 'ask', kind: 'agent', source: { kind: 'inline', prompt: 'Do it' } })
      )
    ).toEqual(served({ id: 'ask', prompt: 'Do it' }));
  });

  test('an exec node with the shell runtime comes back as bash, not as a script', () => {
    expect(
      toAuthoringNode(
        served({ id: 'build', kind: 'exec', script: 'make', runtime: 'sh', timeout: 60 })
      )
    ).toEqual(served({ id: 'build', bash: 'make', timeout: 60 }));
  });

  test('an exec node with a real runtime keeps the runtime it declared', () => {
    expect(
      toAuthoringNode(
        served({
          id: 'deliver',
          kind: 'exec',
          script: 'deliver',
          runtime: 'uv',
          with: { text: '$write.output.text' },
        })
      )
    ).toEqual(
      served({
        id: 'deliver',
        script: 'deliver',
        runtime: 'uv',
        with: { text: '$write.output.text' },
      })
    );
  });

  test('a gate comes back as the approval its author wrote', () => {
    expect(
      toAuthoringNode(
        served({
          id: 'sign-off',
          kind: 'gate',
          message: 'Ship it?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
          captureResponse: true,
        })
      )
    ).toEqual(
      served({
        id: 'sign-off',
        approval: {
          message: 'Ship it?',
          capture_response: true,
          decisions: [{ id: 'approve' }, { id: 'reject' }],
        },
      })
    );
  });

  test('a gate whose decisions were synthesized comes back as on_reject', () => {
    expect(
      toAuthoringNode(
        served({
          id: 'sign-off',
          kind: 'gate',
          message: 'Ship it?',
          decisions: [
            { id: 'approve' },
            { id: 'reject', rework: { prompt: 'Fix it', maxAttempts: 2 } },
          ],
          decisionsAuthored: false,
          captureResponse: false,
        })
      )
    ).toEqual(
      served({
        id: 'sign-off',
        approval: { message: 'Ship it?', on_reject: { prompt: 'Fix it', max_attempts: 2 } },
      })
    );
  });

  test('a halt node comes back as cancel', () => {
    expect(toAuthoringNode(served({ id: 'stop', kind: 'halt', reason: 'nothing to do' }))).toEqual(
      served({ id: 'stop', cancel: 'nothing to do' })
    );
  });

  test('a wait node only loses the kind the transform added', () => {
    expect(
      toAuthoringNode(served({ id: 'hold', kind: 'wait', wait: { duration_ms: 1000 } }))
    ).toEqual(served({ id: 'hold', wait: { duration_ms: 1000 } }));
  });

  test('a node already in authoring shape is returned untouched', () => {
    const node = served({ id: 'write', command: 'announce' });
    expect(toAuthoringNode(node)).toBe(node);
  });

  test('a kind the builder has no variant for is handed on as it arrived', () => {
    const node = served({ id: 'sub', kind: 'workflow', workflow: 'chesswin-deliver' });
    expect(toAuthoringNode(node)).toBe(node);
  });
});

describe('composedNodeKind', () => {
  test('names the composition shape a node is', () => {
    expect(
      composedNodeKind(served({ id: 'criteria', kind: 'include', include: 'chesswin-criteria' }))
    ).toBe('include');
    expect(
      composedNodeKind(served({ id: 'loop', kind: 'loop_group', loop_group: { nodes: [] } }))
    ).toBe('loop_group');
  });

  test('a node the builder can edit is not a composition shape', () => {
    expect(
      composedNodeKind(
        served({ id: 'write', kind: 'agent', source: { kind: 'command', name: 'announce' } })
      )
    ).toBeNull();
    expect(composedNodeKind(served({ id: 'write', command: 'announce' }))).toBeNull();
  });
});

describe('fromWorkflowDefinition on a served definition', () => {
  /** The three nodes of `chesswin-announce`, as the server serves them. */
  const definition = {
    name: 'chesswin-announce',
    description: 'Write and deliver a short report about something the Factory did',
    nodes: [
      {
        id: 'recipients',
        kind: 'exec',
        script: '__archon_pack__global:chesswin:announce::recipients',
        runtime: 'uv',
      },
      {
        id: 'write',
        depends_on: ['recipients'],
        model: 'medium',
        kind: 'agent',
        source: {
          kind: 'command',
          name: '__archon_pack__global:chesswin:announce::announce',
          with: { facts: '$INPUTS.facts' },
        },
      },
      {
        id: 'deliver',
        depends_on: ['write'],
        kind: 'exec',
        script: '__archon_pack__global:chesswin:announce::deliver',
        runtime: 'uv',
        with: { text: '$write.output.text' },
      },
    ],
  } as unknown as WireWorkflowDefinition;

  test('every node lands on its real variant, with nothing to report', () => {
    const { workflow, issues } = fromWorkflowDefinition(definition);

    expect(workflow.nodes.map(n => [n.id, n.variant])).toEqual([
      ['recipients', 'script'],
      ['write', 'command'],
      ['deliver', 'script'],
    ]);
    expect(issues).toEqual([]);
  });

  test('an include node is reported as composition, by name', () => {
    const composed = {
      name: 'chesswin-deliver',
      nodes: [{ id: 'criteria', kind: 'include', include: 'chesswin-criteria' }],
    } as unknown as WireWorkflowDefinition;

    const { issues } = fromWorkflowDefinition(composed);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("composes other work ('include')");
    expect(issues[0]?.severity).toBe('error');
  });

  test('the command node carries the command it runs', () => {
    const { workflow } = fromWorkflowDefinition(definition);
    const write = workflow.nodes.find(n => n.id === 'write');

    expect(write?.variant).toBe('command');
    expect(write?.data).toEqual({
      command: '__archon_pack__global:chesswin:announce::announce',
      with: { facts: '$INPUTS.facts' },
    });
  });
});
