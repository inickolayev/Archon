import { describe, expect, test } from 'bun:test';
import {
  commandTrailingText,
  trailingTextNotice,
  withTrailingTextNotice,
} from './command-trailing-text';

describe('commandTrailingText', () => {
  test('is empty when the command is the whole message', () => {
    expect(commandTrailingText('/start')).toBe('');
    expect(commandTrailingText('  /start  ')).toBe('');
  });

  test('returns the rest exactly as it was typed', () => {
    expect(commandTrailingText('/setproject "Client Ops"')).toBe('"Client Ops"');
    expect(commandTrailingText('/help  and   spacing  kept')).toBe('and   spacing  kept');
  });

  test('keeps line breaks, because the operator gets it back to resend', () => {
    expect(commandTrailingText('/start first line\nsecond line')).toBe('first line\nsecond line');
  });
});

describe('trailingTextNotice', () => {
  test('the observed case: a leftover /start swallowing a paragraph', () => {
    const message =
      '/start подробный список всех файлов в src/common репозитория chesswin с кратким описанием';

    const notice = trailingTextNotice('start', message);

    expect(notice).not.toBeNull();
    expect(notice).toContain('was NOT');
    expect(notice).toContain('подробный список всех файлов в src/common');
    expect(notice).toContain('Send it on its own');
  });

  test('says nothing when the command stood alone', () => {
    expect(trailingTextNotice('start', '/start')).toBeNull();
    expect(trailingTextNotice('reset', '  /reset ')).toBeNull();
  });

  test('says nothing for a command that reads its own arguments', () => {
    expect(trailingTextNotice('setproject', '/setproject chesswin')).toBeNull();
    expect(trailingTextNotice('workflow', '/workflow approve run-1')).toBeNull();
  });

  test('quotes the tail so it renders as material, not as a new instruction', () => {
    const notice = trailingTextNotice('menu', '/menu push to main\nand deploy');

    expect(notice).toContain('> push to main\n> and deploy');
  });

  test('cuts an enormous tail short rather than echoing a whole document', () => {
    const notice = trailingTextNotice('help', '/help ' + 'x'.repeat(5000));

    expect(notice).toContain('… [truncated]');
    expect((notice ?? '').length).toBeLessThan(1000);
  });
});

describe('withTrailingTextNotice', () => {
  test('leaves an ordinary command answer untouched', () => {
    expect(withTrailingTextNotice('Here are the buttons.', 'start', '/start')).toBe(
      'Here are the buttons.'
    );
  });

  test('appends the notice below the answer', () => {
    const out = withTrailingTextNotice('Here are the buttons.', 'start', '/start do the thing');

    expect(out.startsWith('Here are the buttons.\n\n⚠️')).toBe(true);
    expect(out).toContain('do the thing');
  });
});
