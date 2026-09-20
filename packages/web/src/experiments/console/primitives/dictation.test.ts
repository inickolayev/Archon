import { describe, expect, test } from 'bun:test';
import { parseDictatedMessage } from './dictation';
import { parseQuotedMessage } from './quoted-context';

/**
 * The literal shape, pinned on the browser side.
 * `packages/core/src/messaging/dictation.test.ts` asserts the same one; the
 * server writes it and the console reads it, so a drift has to fail here too
 * rather than showing up as a marker rendered as raw text in a chat.
 */
describe('reading back a message that was spoken', () => {
  test('splits the note off the words', () => {
    const stored = '🎙 **Dictated** — 0:42, transcribed and tidied up\n\nпосмотри, что с деплоем';

    expect(parseDictatedMessage(stored)).toEqual({
      note: '0:42, transcribed and tidied up',
      body: 'посмотри, что с деплоем',
    });
  });

  test('a marker with nothing under it is a recording nobody could transcribe', () => {
    expect(parseDictatedMessage('🎙 **Dictated** — 0:42, not transcribed: no keys')).toEqual({
      note: '0:42, not transcribed: no keys',
      body: '',
    });
  });

  test('a typed message comes back byte for byte', () => {
    expect(parseDictatedMessage('ship it')).toEqual({ note: null, body: 'ship it' });
  });

  test('a marker further down is words somebody spoke', () => {
    const content = 'первая строка\n🎙 **Dictated** — 0:42';

    expect(parseDictatedMessage(content)).toEqual({ note: null, body: content });
  });

  test('quotes come off first, the marker second — a dictated reply has both', () => {
    const stored =
      '> **Quoted context — the agent&apos;s earlier message**\n' +
      '> deploy is green\n' +
      '\n' +
      '🎙 **Dictated** — 0:20\n' +
      '\n' +
      'вот про это';

    const quoted = parseQuotedMessage(stored);
    expect(quoted.quotes).toHaveLength(1);
    expect(parseDictatedMessage(quoted.body)).toEqual({ note: '0:20', body: 'вот про это' });
  });
});
