import { describe, expect, test } from 'bun:test';
import { errorText, HttpError } from './http';

describe('errorText', () => {
  test("shows the server's sentence, not the log line around it", () => {
    const err = new HttpError(
      404,
      '/api/auth/telegram/link/abc',
      '{"error":"This link has expired or was already used"}'
    );
    expect(errorText(err, 'fallback')).toBe('This link has expired or was already used');
    expect(errorText(err, 'fallback')).not.toContain('API error');
    expect(errorText(err, 'fallback')).not.toContain('/api/');
  });

  test('a detail is appended, because it usually says what to do', () => {
    const err = new HttpError(401, '/x', '{"error":"Sign in first","detail":"then open the link"}');
    expect(errorText(err, 'fallback')).toBe('Sign in first — then open the link');
  });

  test('a truncated or unreadable body falls back rather than showing JSON', () => {
    const err = new HttpError(500, '/x', '{"error":"half a sen');
    expect(errorText(err, 'Could not link the account')).toBe('Could not link the account');
  });

  test('an ordinary error keeps its own message', () => {
    expect(errorText(new Error('network down'), 'fallback')).toBe('network down');
  });

  test('anything else gets the fallback', () => {
    expect(errorText('oops', 'fallback')).toBe('fallback');
    expect(errorText(new Error('   '), 'fallback')).toBe('fallback');
  });
});
