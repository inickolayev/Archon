import { describe, test, expect, afterEach } from 'bun:test';
import {
  buildWorkflowPath,
  buildSavePath,
  getWorkflowGraph,
  listWorkflows,
  nodeKind,
} from './workflows';

describe('buildWorkflowPath', () => {
  test('encodes both name and cwd', () => {
    expect(buildWorkflowPath('my-flow', 'D:/Dynamous/Archon')).toBe(
      '/api/workflows/my-flow?cwd=D%3A%2FDynamous%2FArchon'
    );
  });

  test('encodes special characters in the name', () => {
    expect(buildWorkflowPath('a b', '/repo')).toBe('/api/workflows/a%20b?cwd=%2Frepo');
  });

  test('uses encodeURIComponent (not encodeURI) — a literal % is escaped', () => {
    expect(buildWorkflowPath('50%off', '/repo')).toBe('/api/workflows/50%25off?cwd=%2Frepo');
  });
});

describe('buildSavePath', () => {
  test('appends &source=project to the encoded cwd query', () => {
    expect(buildSavePath('my-flow', '/repo', 'project')).toBe(
      '/api/workflows/my-flow?cwd=%2Frepo&source=project'
    );
  });

  test('appends &source=global', () => {
    expect(buildSavePath('my-flow', '/repo', 'global')).toBe(
      '/api/workflows/my-flow?cwd=%2Frepo&source=global'
    );
  });
});

describe('listWorkflows — declared inputs survive the wire mapping (#2554)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("carries a workflow's declared inputs through to the console primitive", async () => {
    // The console's run form depends on this field surviving `listWorkflows`, and the
    // wire shape here is hand-rolled — it once omitted `inputs` entirely and still
    // compiled, because a missing optional property satisfies the parameter type. This
    // is the regression guard the compiler cannot be.
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            workflows: [
              {
                workflow: {
                  name: 'review-block',
                  description: 'reviews a diff',
                  inputs: { diff: { required: true }, style: { default: 'strict' } },
                },
                source: 'project',
              },
            ],
            recommended: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )) as typeof fetch;

    const result = await listWorkflows('/repo');

    expect(result.workflows[0].inputs).toEqual([
      { name: 'diff', required: true, default: null, description: null },
      { name: 'style', required: false, default: 'strict', description: null },
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

describe('getWorkflowGraph', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('projects wait nodes as wait rather than prompt', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            workflows: [
              {
                workflow: {
                  name: 'await-checks',
                  description: 'waits for checks',
                  nodes: [{ id: 'checks', wait: { event: 'checks.complete', deadline_ms: 1000 } }],
                },
                source: 'project',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )) as typeof fetch;

    await expect(getWorkflowGraph('await-checks')).resolves.toEqual([
      { id: 'checks', dependsOn: [], kind: 'wait' },
    ]);
  });
});
