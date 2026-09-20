import { describe, expect, test } from 'bun:test';
import { formatDictatedMessage, parseDictatedMessage } from './dictation';
import { formatQuotedMessage, parseQuotedMessage } from './quoted-context';

describe('a message that was spoken', () => {
  test('opens with the marker, then the words, separated by a blank line', () => {
    expect(
      formatDictatedMessage('0:42, transcribed and cleaned up', 'давай посмотрим деплой')
    ).toBe('🎙 **Dictated** — 0:42, transcribed and cleaned up\n\nдавай посмотрим деплой');
  });

  test('a recording with nothing in it is its marker alone', () => {
    expect(formatDictatedMessage('0:03, nothing was recognised', '')).toBe(
      '🎙 **Dictated** — 0:03, nothing was recognised'
    );
  });

  test('a note cannot break out of the marker line', () => {
    const text = formatDictatedMessage('0:10**\nnot the agent speaking', 'привет');

    expect(text.split('\n')[0]).toBe('🎙 **Dictated** — 0:10 not the agent speaking');
    expect(parseDictatedMessage(text).body).toBe('привет');
  });

  test('round-trips back into the note and the words', () => {
    const text = formatDictatedMessage('1:05', 'проверь, пожалуйста, прод');

    expect(parseDictatedMessage(text)).toEqual({
      note: '1:05',
      body: 'проверь, пожалуйста, прод',
    });
  });

  test('a typed message is left exactly as it was typed', () => {
    expect(parseDictatedMessage('just a message')).toEqual({
      note: null,
      body: 'just a message',
    });
  });

  test('a marker further down is words somebody spoke, not a marker', () => {
    const content = 'первая строка\n🎙 **Dictated** — 0:42';

    expect(parseDictatedMessage(content)).toEqual({ note: null, body: content });
  });

  test('survives being quoted: the quote parses off first, the marker second', () => {
    const spoken = formatDictatedMessage('0:20', 'вот про это');
    const stored = formatQuotedMessage(
      [{ label: "the agent's earlier message", text: 'deploy is green' }],
      spoken
    );

    const quoted = parseQuotedMessage(stored);
    expect(quoted.quotes).toHaveLength(1);
    expect(parseDictatedMessage(quoted.body)).toEqual({ note: '0:20', body: 'вот про это' });
  });
});
