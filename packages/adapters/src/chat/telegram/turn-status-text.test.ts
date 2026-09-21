import { describe, expect, test } from 'bun:test';
import { describeTool, STATUS_WORKING } from './turn-status-text';

/**
 * The line an operator reads on a phone. Two things are being checked
 * throughout: that it says something a human recognises, and that it says
 * nothing about the shape of the operator's disk.
 */
describe('describeTool', () => {
  test('names the file, never the directory it lives in', () => {
    const line = describeTool('Read', {
      file_path: '/Users/nikolaeviv/sources/repos/chesswin/src/app/server.js',
    });
    expect(line).toBe('⏳ Reading server.js…');
    expect(line).not.toContain('/Users');
    expect(line).not.toContain('/');
  });

  test('a Windows-shaped path from an MCP tool is cut down the same way', () => {
    expect(describeTool('Write', { file_path: 'C:\\Users\\op\\notes\\plan.md' })).toBe(
      '⏳ Writing plan.md…'
    );
  });

  test('a very long file name keeps both ends, so the extension survives', () => {
    const line = describeTool('Edit', {
      file_path: '/repo/a-really-quite-long-generated-component-name.test.tsx',
    });
    expect(line.length).toBeLessThan(45);
    expect(line.startsWith('⏳ Editing a-really')).toBe(true);
    expect(line.endsWith('.test.tsx…')).toBe(true);
  });

  test('without a file name it still says what kind of work it is', () => {
    expect(describeTool('Read', {})).toBe('⏳ Reading files…');
    expect(describeTool('Edit')).toBe('⏳ Editing files…');
  });

  test('a shell call is classified, and the command itself is thrown away', () => {
    expect(describeTool('Bash', { command: 'cd /Users/op/repo && bun test packages/core' })).toBe(
      '⏳ Running tests…'
    );
    expect(describeTool('Bash', { command: 'git -C /Users/op/repo status' })).toBe(
      '⏳ Running git…'
    );
    const other = describeTool('Bash', { command: 'cat /Users/op/.ssh/config' });
    expect(other).toBe('⏳ Running a command…');
    expect(other).not.toContain('/Users');
  });

  test('searching says where it is searching', () => {
    expect(describeTool('Grep', { pattern: 'TODO' })).toBe('⏳ Searching the repo…');
    expect(describeTool('Glob', { pattern: '**/*.ts' })).toBe('⏳ Looking for files…');
    expect(describeTool('WebSearch', { query: 'grammy edit message' })).toBe(
      '⏳ Searching the web…'
    );
  });

  test('an MCP call names the server it went to — configuration, not a path', () => {
    expect(describeTool('mcp__chesswin-admin__bots_list', {})).toBe('⏳ Asking chesswin-admin…');
  });

  test('tool names are matched however the provider spells them', () => {
    expect(describeTool('MULTIEDIT', { file_path: '/x/y/adapter.ts' })).toBe(
      '⏳ Editing adapter.ts…'
    );
    expect(describeTool('shell', { command: 'ls' })).toBe('⏳ Running a command…');
  });

  test('a tool nobody has a phrase for is honest rather than special-cased', () => {
    expect(describeTool('SomeFutureTool', { anything: '/Users/op/secret' })).toBe(STATUS_WORKING);
  });
});
