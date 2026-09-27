import { describe, expect, test } from 'bun:test';
import { pendingMessage } from './NodeSourcePanel';
import { HttpError } from '../lib/http';

/**
 * The panel's own states, before any file is in hand. What is worth pinning is that a panel
 * that has not answered yet says it is reading — an earlier version keyed this on the store's
 * `loading` flag, which is false for the first paint, so every panel opened with "no file" and
 * then changed its mind — and that a refusal is shown in the server's own words.
 */
describe('what the panel says before it has a file', () => {
  test('a panel with nothing yet is reading, not empty', () => {
    expect(pendingMessage(undefined)).toBe('Reading…');
  });

  test('a 404 is shown as the server worded it — it is an answer, not a failure', () => {
    const error = new HttpError(
      404,
      '/api/workflows/ship/nodes/gate/source',
      '{"error":"Node runs no command or script: gate"}',
      'Node runs no command or script: gate'
    );

    expect(pendingMessage(error)).toBe('Node runs no command or script: gate');
  });

  test('an error carrying no server message falls back to its own', () => {
    expect(pendingMessage(new Error('Failed to fetch'))).toBe('Failed to fetch');
  });
});
