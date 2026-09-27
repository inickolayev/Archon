import { describe, expect, test } from 'bun:test';
import { buildNodeSourcePath } from './nodeSource';

describe('buildNodeSourcePath', () => {
  test('encodes the workflow, the node and the project directory', () => {
    expect(buildNodeSourcePath('chesswin-announce', 'write', '/home/me/my project')).toBe(
      '/api/workflows/chesswin-announce/nodes/write/source?cwd=%2Fhome%2Fme%2Fmy%20project'
    );
  });

  test('a subfoldered workflow name keeps its slash encoded, not as another path segment', () => {
    expect(buildNodeSourcePath('triage/review', 'check')).toBe(
      '/api/workflows/triage%2Freview/nodes/check/source'
    );
  });
});
