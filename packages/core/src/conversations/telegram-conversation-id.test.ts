import { describe, expect, test } from 'bun:test';
import {
  isTelegramConversationId,
  parseTelegramConversationId,
  telegramChatIdOf,
  telegramConversationId,
} from './telegram-conversation-id';

describe('parseTelegramConversationId', () => {
  test('a bare chat id is conversation 1 of that chat (legacy rows)', () => {
    expect(parseTelegramConversationId('123456789')).toEqual({
      chatId: 123456789,
      index: 1,
      legacy: true,
    });
  });

  test('a suffixed id carries its number', () => {
    expect(parseTelegramConversationId('123456789:4')).toEqual({
      chatId: 123456789,
      index: 4,
      legacy: false,
    });
  });

  test('group chat ids are negative and parse the same way', () => {
    expect(parseTelegramConversationId('-1001234567890:3')).toEqual({
      chatId: -1001234567890,
      index: 3,
      legacy: false,
    });
  });

  test('rejects ids that are not ours', () => {
    expect(parseTelegramConversationId('web-1789838461700-mkhqnq')).toBeNull();
    expect(parseTelegramConversationId('123:0')).toBeNull();
    expect(parseTelegramConversationId('123:')).toBeNull();
    expect(parseTelegramConversationId('123:2:3')).toBeNull();
    expect(parseTelegramConversationId('12a:2')).toBeNull();
    expect(parseTelegramConversationId('')).toBeNull();
  });
});

describe('telegramChatIdOf', () => {
  test('parses the chat id out explicitly, suffix or not', () => {
    expect(telegramChatIdOf('123456789')).toBe(123456789);
    expect(telegramChatIdOf('123456789:7')).toBe(123456789);
    expect(telegramChatIdOf('-1001234567890:2')).toBe(-1001234567890);
  });

  test('throws rather than delivering to NaN', () => {
    expect(() => telegramChatIdOf('web-123')).toThrow(/Not a Telegram conversation id/);
  });
});

describe('telegramConversationId', () => {
  test('conversation 1 keeps the bare, legacy-compatible form', () => {
    expect(telegramConversationId(123, 1)).toBe('123');
  });

  test('later conversations carry the suffix', () => {
    expect(telegramConversationId(123, 2)).toBe('123:2');
    expect(telegramConversationId('-100999', 12)).toBe('-100999:12');
  });

  test('round-trips through the parser', () => {
    const id = telegramConversationId(-1009, 5);
    expect(parseTelegramConversationId(id)).toEqual({ chatId: -1009, index: 5, legacy: false });
  });
});

describe('isTelegramConversationId', () => {
  test('separates Telegram ids from web ids', () => {
    expect(isTelegramConversationId('123:2')).toBe(true);
    expect(isTelegramConversationId('123')).toBe(true);
    expect(isTelegramConversationId('web-1789838461700-mkhqnq')).toBe(false);
  });
});
