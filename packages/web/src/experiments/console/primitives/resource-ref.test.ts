import { describe, expect, test } from 'bun:test';
import { describeResourceRef, packLabel } from './resource-ref';

describe('describeResourceRef', () => {
  test('a bare name is its own name and belongs to no pack', () => {
    expect(describeResourceRef('announce')).toEqual({ name: 'announce', owner: null });
  });

  test('a qualified reference yields the name its author wrote and the pack', () => {
    expect(describeResourceRef('__archon_pack__global:chesswin:announce::announce')).toEqual({
      name: 'announce',
      owner: { scope: 'global', pack: 'chesswin', workflow: 'announce' },
    });
  });

  test('a bundled pack reads the same way', () => {
    const ref = describeResourceRef('__archon_pack__bundled:sdlc:triage::verdict');
    expect(ref.name).toBe('verdict');
    expect(ref.owner === null ? '' : packLabel(ref.owner)).toBe('sdlc/triage');
  });

  test('a prefixed string that does not parse is shown verbatim rather than half-read', () => {
    expect(describeResourceRef('__archon_pack__global:chesswin::')).toEqual({
      name: '__archon_pack__global:chesswin::',
      owner: null,
    });
    expect(describeResourceRef('__archon_pack__whatever')).toEqual({
      name: '__archon_pack__whatever',
      owner: null,
    });
  });

  test('an inline body (a script snippet, not a name) is left alone', () => {
    expect(describeResourceRef('echo "hi"\n')).toEqual({ name: 'echo "hi"\n', owner: null });
  });
});
