/**
 * Unit tests for Telegram adapter
 *
 * Note: We use the real telegram-markdown module instead of mocking it.
 * Mocking internal modules with mock.module() causes test isolation issues
 * since the mock persists across test files.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import type { Mock } from 'bun:test';
import type { Api } from 'grammy';
import { mkdtempSync } from 'node:fs';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';

// Mock logger to suppress noisy output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { TelegramAdapter, isStructuralCategory } from './adapter';

type SendMessage = Api['sendMessage'];

describe('TelegramAdapter', () => {
  describe('streaming mode configuration', () => {
    test('should return batch mode when configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'batch');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should default to stream mode', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      expect(adapter.getStreamingMode()).toBe('stream');
    });

    test('should return stream mode when explicitly configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'stream');
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('message formatting', () => {
    let adapter: TelegramAdapter;
    let mockSendMessage: Mock<SendMessage>;

    beforeEach(() => {
      adapter = new TelegramAdapter('fake-token-for-testing');
      mockSendMessage = mock<SendMessage>(async (chatId, text) => ({
        message_id: 1,
        date: 0,
        chat: {
          id: typeof chatId === 'number' ? chatId : 0,
          type: 'private',
          first_name: 'Test',
        },
        text,
      }));
      adapter.getBot().api.sendMessage = mockSendMessage;
    });

    test('should send with MarkdownV2 parse_mode', async () => {
      await adapter.sendMessage('12345', '**test**');

      // Should send with MarkdownV2 parse_mode
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should fallback to plain text when MarkdownV2 fails', async () => {
      mockSendMessage.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));

      await adapter.sendMessage('12345', '**test**');

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call with MarkdownV2
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        1,
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      // Second call plain text fallback (no parse_mode)
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 12345, expect.any(String));
    });

    test('should split long messages into multiple chunks', async () => {
      // Create a message that will be split (>4096 chars)
      const paragraph1 = 'a'.repeat(3000);
      const paragraph2 = 'b'.repeat(3000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await adapter.sendMessage('12345', message);

      // Should have sent multiple chunks
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Each chunk should be sent with MarkdownV2
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should handle single paragraph longer than MAX_LENGTH', async () => {
      // A single paragraph (no \n\n breaks) longer than MAX_LENGTH
      const longLine = 'x'.repeat(5000);
      await adapter.sendMessage('12345', longLine);
      // Should still send successfully via sendFormattedChunk fallback
      expect(mockSendMessage).toHaveBeenCalled();
    });

    test('should send each paragraph-split chunk independently', async () => {
      // Two large paragraphs (double-newline separated) that together exceed MAX_LENGTH.
      // splitIntoParagraphChunks breaks them apart so each chunk is under the limit.
      const para1 = 'A'.repeat(3000);
      const para2 = 'B'.repeat(3000);
      const message = `${para1}\n\n${para2}`;

      await adapter.sendMessage('55555', message);

      // Two separate sendMessage calls — one per paragraph chunk
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call has parse_mode: MarkdownV2
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        1,
        55555,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        2,
        55555,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should fall back to plain text and use line-based batching when MarkdownV2 fails on chunk', async () => {
      // First MarkdownV2 attempt fails; second call is plain-text fallback
      mockSendMessage.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));

      await adapter.sendMessage('77777', 'plain fallback text');

      // 2 calls: 1 failed MarkdownV2 + 1 plain text fallback
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Second call has no parse_mode (plain text)
      const secondCall = mockSendMessage.mock.calls[1];
      expect(secondCall.length).toBe(2); // (id, text) — no options object
    });
  });

  describe('getConversationId', () => {
    test('should return chat.id as string for private chat', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: 12345 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('12345');
    });

    test('should return chat.id as string for group chat', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: -987654321 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('-987654321');
    });

    test('should return chat.id as string for supergroup', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: -1001234567890 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('-1001234567890');
    });

    test('should throw when ctx.chat is undefined', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: undefined,
      } as unknown as import('grammy').Context;

      expect(() => adapter.getConversationId(ctx)).toThrow('No chat in context');
    });

    test('should throw when ctx.chat is null', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: null,
      } as unknown as import('grammy').Context;

      expect(() => adapter.getConversationId(ctx)).toThrow('No chat in context');
    });
  });

  describe('ensureThread', () => {
    test('should return the original conversation ID unchanged', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const result = await adapter.ensureThread('12345');
      expect(result).toBe('12345');
    });

    test('should return original ID even when messageContext is supplied', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const result = await adapter.ensureThread('99999', { some: 'context' });
      expect(result).toBe('99999');
    });
  });

  describe('platform type and streaming mode', () => {
    test('should return telegram as platform type', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      expect(adapter.getPlatformType()).toBe('telegram');
    });
  });

  describe('stop()', () => {
    test('should call bot.stop()', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const mockStop = mock(() => undefined);
      (adapter.getBot() as unknown as { stop: typeof mockStop }).stop = mockStop;
      adapter.stop();
      expect(mockStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('start()', () => {
    // Every start() case needs a whitelist: this fork refuses to launch an open
    // bot (see the 'refuses an open bot' block at the end).
    const previousWhitelist = process.env.TELEGRAM_ALLOWED_USER_IDS;
    beforeEach(() => {
      process.env.TELEGRAM_ALLOWED_USER_IDS = '111';
    });
    afterAll(() => {
      if (previousWhitelist === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
      else process.env.TELEGRAM_ALLOWED_USER_IDS = previousWhitelist;
    });

    beforeEach(() => {
      mockLogger.warn.mockClear();
      mockLogger.info.mockClear();
    });

    test('should retry on 409 and succeed on second attempt', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      // grammY's start() resolves when bot stops, not when started — onStart fires on startup
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(new Error('409: Conflict: terminated by other getUpdates request'))
        .mockImplementationOnce(opts => {
          opts?.onStart?.();
          return new Promise(() => {});
        });
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await adapter.start({ retryDelayMs: 0 });

      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
        'telegram.start_conflict_retrying'
      );
      expect(mockLogger.info).toHaveBeenCalledWith('telegram.bot_started');
    });

    test('should throw immediately on non-409 error', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >().mockRejectedValueOnce(new Error('401: Unauthorized'));
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await expect(adapter.start({ retryDelayMs: 0 })).rejects.toThrow('401: Unauthorized');
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    test('should retry twice on 409 and succeed on third attempt', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const conflictError = new Error('409: Conflict: terminated by other getUpdates request');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError)
        .mockImplementationOnce(opts => {
          opts?.onStart?.();
          return new Promise(() => {});
        });
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await adapter.start({ retryDelayMs: 0 });

      expect(mockStart).toHaveBeenCalledTimes(3);
      // Count the retry warnings specifically: publishing the command list runs
      // in the background after a successful start and may warn on its own.
      const retryWarnings = (mockLogger.warn.mock.calls as unknown[][]).filter(
        call => call[1] === 'telegram.start_conflict_retrying'
      );
      expect(retryWarnings).toHaveLength(2);
    });

    test('should throw after exhausting all 409 retry attempts', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const conflictError = new Error('409: Conflict: terminated by other getUpdates request');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError);
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await expect(adapter.start({ retryDelayMs: 0 })).rejects.toThrow('409');
      expect(mockStart).toHaveBeenCalledTimes(3);
    });
  });
  describe('refuses an open bot', () => {
    const previousWhitelist = process.env.TELEGRAM_ALLOWED_USER_IDS;
    afterAll(() => {
      if (previousWhitelist === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
      else process.env.TELEGRAM_ALLOWED_USER_IDS = previousWhitelist;
    });

    test('start() refuses when the whitelist is empty, and never polls', async () => {
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
      delete process.env.TELEGRAM_ALLOWED_USERS;
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >(async () => undefined);
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await expect(adapter.start({ retryDelayMs: 0 })).rejects.toThrow(
        /TELEGRAM_ALLOWED_USER_IDS is empty/
      );
      // The reason is logged, and no polling was attempted.
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ envVar: 'TELEGRAM_ALLOWED_USER_IDS' }),
        'telegram.refusing_to_start_open_bot'
      );
      expect(mockStart).not.toHaveBeenCalled();
    });

    test('start() proceeds when the whitelist names someone', async () => {
      process.env.TELEGRAM_ALLOWED_USER_IDS = '4242';
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >().mockImplementationOnce(opts => {
        opts?.onStart?.();
        return new Promise(() => {});
      });
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await adapter.start({ retryDelayMs: 0 });
      expect(mockStart).toHaveBeenCalledTimes(1);
    });
  });
  describe('inbound handler (fake grammY context)', () => {
    const previousWhitelist = process.env.TELEGRAM_ALLOWED_USER_IDS;
    afterAll(() => {
      if (previousWhitelist === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
      else process.env.TELEGRAM_ALLOWED_USER_IDS = previousWhitelist;
    });

    /** Start the adapter with polling stubbed out and capture its message handler. */
    /** Start with polling stubbed out and capture the handler of one update type. */
    async function handlerOf(
      adapter: TelegramAdapter,
      event = 'message:text'
    ): Promise<(ctx: unknown) => void> {
      const captured = new Map<string, (ctx: unknown) => void>();
      const bot = adapter.getBot() as unknown as {
        on: (event: string | string[], fn: (ctx: unknown) => void) => void;
        start: (opts?: { onStart?: () => void }) => Promise<void>;
      };
      bot.on = (registered, fn) => {
        for (const name of Array.isArray(registered) ? registered : [registered]) {
          captured.set(name, fn);
        }
      };
      bot.start = async opts => {
        opts?.onStart?.();
        await new Promise(() => undefined);
      };
      await adapter.start({ retryDelayMs: 0 });
      const handler = captured.get(event);
      if (handler === undefined) throw new Error(`no handler registered for ${event}`);
      return handler;
    }

    const ctxFrom = (chatId: number, userId: number, text: string): unknown => ({
      chat: { id: chatId },
      from: { id: userId, first_name: 'Ada', last_name: 'Lovelace' },
      message: { text },
    });

    test('passes the chat id and sender on to the message handler', async () => {
      process.env.TELEGRAM_ALLOWED_USER_IDS = '4242';
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const received: { conversationId: string; message: string; displayName?: string }[] = [];
      adapter.onMessage(async ctx => {
        received.push({
          conversationId: ctx.conversationId,
          message: ctx.message,
          displayName: ctx.displayName,
        });
      });

      const handler = await handlerOf(adapter);
      handler(ctxFrom(-1001234567890, 4242, '/chats'));
      await new Promise(resolve => setTimeout(resolve, 0));

      // The adapter hands over the CHAT id; the server resolves which of that
      // chat's conversations the message belongs to.
      expect(received).toEqual([
        { conversationId: '-1001234567890', message: '/chats', displayName: 'Ada Lovelace' },
      ]);
    });

    test('a sender outside the whitelist is dropped silently', async () => {
      process.env.TELEGRAM_ALLOWED_USER_IDS = '4242';
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const received: string[] = [];
      adapter.onMessage(async ctx => {
        received.push(ctx.message);
      });

      const handler = await handlerOf(adapter);
      handler(ctxFrom(999, 777_000_111, 'let me in'));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(received).toEqual([]);
    });
  });
  describe('photos and documents', () => {
    const previousWhitelist = process.env.TELEGRAM_ALLOWED_USER_IDS;
    afterAll(() => {
      if (previousWhitelist === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
      else process.env.TELEGRAM_ALLOWED_USER_IDS = previousWhitelist;
    });

    /** Start with polling stubbed out; return the handlers and what was dispatched. */
    interface Inbound {
      message: string;
      files?: { fileName?: string }[];
      platformMessageId?: number;
      voiceDurationSec?: number;
    }

    async function startCapturing(waitMs = 20): Promise<{
      handlers: Map<string, (ctx: never) => void>;
      received: Inbound[];
    }> {
      process.env.TELEGRAM_ALLOWED_USER_IDS = '4242';
      const adapter = new TelegramAdapter('fake-token-for-testing', 'stream', waitMs);
      const received: Inbound[] = [];
      adapter.onMessage(async ctx => {
        received.push({
          message: ctx.message,
          files: ctx.files,
          platformMessageId: ctx.platformMessageId,
          voiceDurationSec: ctx.voiceDurationSec,
        });
      });
      const handlers = new Map<string, (ctx: never) => void>();
      const bot = adapter.getBot() as unknown as {
        on: (event: string | string[], fn: (ctx: never) => void) => void;
        start: (opts?: { onStart?: () => void }) => Promise<void>;
      };
      bot.on = (event, fn) => {
        for (const name of Array.isArray(event) ? event : [event]) handlers.set(name, fn);
      };
      bot.start = async opts => {
        opts?.onStart?.();
        await new Promise(() => undefined);
      };
      await adapter.start({ retryDelayMs: 0 });
      return { handlers, received };
    }

    const ctxWith = (message: Record<string, unknown>, replies?: string[]): never =>
      ({
        chat: { id: 555 },
        from: { id: 4242, first_name: 'Ada' },
        message,
        reply: async (text: string) => {
          replies?.push(text);
        },
      }) as never;

    test('a document arrives as a file, with its caption as the message', async () => {
      const { handlers, received } = await startCapturing();
      handlers.get('message:document')?.(
        ctxWith({
          caption: 'look at this log',
          document: {
            file_id: 'doc-1',
            file_name: 'run.log',
            mime_type: 'text/plain',
            file_size: 12,
          },
        })
      );
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(received).toHaveLength(1);
      expect(received[0]?.message).toBe('look at this log');
      expect(received[0]?.files?.[0]?.fileName).toBe('run.log');
    });

    test('a photo with no caption still says something the agent can act on', async () => {
      const { handlers, received } = await startCapturing();
      handlers.get('message:photo')?.(
        ctxWith({
          photo: [
            { file_id: 'small', width: 90 },
            { file_id: 'big', width: 1280 },
          ],
        })
      );
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(received).toHaveLength(1);
      expect(received[0]?.message.length).toBeGreaterThan(0);
      expect(received[0]?.files).toHaveLength(1);
    });

    test('an album of three photos becomes ONE message with three files', async () => {
      const { handlers, received } = await startCapturing(20);
      const photo = handlers.get('message:photo');
      photo?.(ctxWith({ media_group_id: 'g1', caption: 'three shots', photo: [{ file_id: 'a' }] }));
      photo?.(ctxWith({ media_group_id: 'g1', photo: [{ file_id: 'b' }] }));
      photo?.(ctxWith({ media_group_id: 'g1', photo: [{ file_id: 'c' }] }));
      await new Promise(resolve => setTimeout(resolve, 80));

      expect(received).toHaveLength(1);
      expect(received[0]?.message).toBe('three shots');
      expect(received[0]?.files).toHaveLength(3);
    });

    test('video notes and stickers get one line back instead of silence', async () => {
      const { handlers } = await startCapturing();
      const replies: string[] = [];
      handlers.get('message:video_note')?.(ctxWith({ video_note: { file_id: 'n' } }, replies));
      handlers.get('message:sticker')?.(ctxWith({ sticker: { file_id: 's' } }, replies));
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(replies).toHaveLength(2);
      expect(replies[0]).toContain('video note');
      expect(replies[1]).toContain('sticker');
    });

    test('a voice note arrives as a file with NO words of its own', async () => {
      const { handlers, received } = await startCapturing();
      handlers.get('message:voice')?.(
        ctxWith({ message_id: 77, voice: { file_id: 'v-1', duration: 42, file_size: 9_000 } })
      );
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(received).toHaveLength(1);
      // Empty on purpose: the transcript is what the operator said, and the
      // server fills it in once the recording has been downloaded. A generated
      // caption here would end up in front of their own words.
      expect(received[0]?.message).toBe('');
      expect(received[0]?.files).toHaveLength(1);
      // What the transcript is posted back as a reply to, and how long it is.
      expect(received[0]?.platformMessageId).toBe(77);
      expect(received[0]?.voiceDurationSec).toBe(42);
    });

    test('a voice note WITH a caption keeps the caption', async () => {
      const { handlers, received } = await startCapturing();
      handlers.get('message:audio')?.(
        ctxWith({ caption: 'the standup', audio: { file_id: 'a-1', file_name: 'x.mp3' } })
      );
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(received[0]?.message).toBe('the standup');
    });

    test('a file from a sender outside the whitelist is dropped', async () => {
      const { handlers, received } = await startCapturing();
      handlers.get('message:document')?.({
        chat: { id: 555 },
        from: { id: 111_222_333, first_name: 'Nobody' },
        message: { document: { file_id: 'd', file_name: 'x.txt' } },
        reply: async () => undefined,
      } as never);
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(received).toEqual([]);
    });
  });
  describe('buttons', () => {
    const previousWhitelist = process.env.TELEGRAM_ALLOWED_USER_IDS;
    afterAll(() => {
      if (previousWhitelist === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
      else process.env.TELEGRAM_ALLOWED_USER_IDS = previousWhitelist;
    });

    interface Captured {
      handlers: Map<string, (ctx: never) => void>;
      commandsPublished: unknown[];
      adapter: TelegramAdapter;
    }

    async function startCapturing(): Promise<Captured> {
      process.env.TELEGRAM_ALLOWED_USER_IDS = '4242';
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const handlers = new Map<string, (ctx: never) => void>();
      const commandsPublished: unknown[] = [];
      const bot = adapter.getBot() as unknown as {
        on: (event: string | string[], fn: (ctx: never) => void) => void;
        start: (opts?: { onStart?: () => void }) => Promise<void>;
        api: { setMyCommands: (commands: unknown) => Promise<void> };
      };
      bot.on = (event, fn) => {
        for (const name of Array.isArray(event) ? event : [event]) handlers.set(name, fn);
      };
      bot.start = async opts => {
        opts?.onStart?.();
        await new Promise(() => undefined);
      };
      bot.api.setMyCommands = async commands => {
        commandsPublished.push(commands);
      };
      await adapter.start({ retryDelayMs: 0 });
      return { handlers, commandsPublished, adapter };
    }

    interface CallbackCalls {
      edits: { text: string; markup?: unknown }[];
      answers: (unknown | undefined)[];
    }

    const callbackCtx = (data: string, calls: CallbackCalls, userId = 4242): never =>
      ({
        chat: { id: 555 },
        from: { id: userId, first_name: 'Ada' },
        callbackQuery: { data },
        editMessageText: async (text: string, options?: { reply_markup?: unknown }) => {
          calls.edits.push({ text, markup: options?.reply_markup });
        },
        answerCallbackQuery: async (options?: unknown) => {
          calls.answers.push(options);
        },
      }) as never;

    test('only the few worth typing are published to Telegram', async () => {
      const { commandsPublished } = await startCapturing();
      await new Promise(resolve => setTimeout(resolve, 5));
      const published = commandsPublished[0] as { command: string }[] | undefined;
      expect(published?.map(c => c.command)).toEqual(['start', 'help', 'menu', 'stop']);
    });

    test('a tap edits the message in place and answers the query', async () => {
      const { handlers, adapter } = await startCapturing();
      adapter.onCallback(async request => ({
        text: `handled ${request.data} in chat ${request.chatId}`,
        keyboard: { inline: [[{ label: 'Chats', action: 'l:c' }]] },
        toast: 'done',
      }));
      const calls: CallbackCalls = { edits: [], answers: [] };

      handlers.get('callback_query:data')?.(callbackCtx('s:2', calls));
      await new Promise(resolve => setTimeout(resolve, 5));

      // Edited, not re-sent — a phone screen fills up fast.
      expect(calls.edits).toHaveLength(1);
      expect(calls.edits[0]?.text).toBe('handled s:2 in chat 555');
      expect(calls.edits[0]?.markup).toEqual({
        inline_keyboard: [[{ text: 'Chats', callback_data: 'l:c' }]],
      });
      expect(calls.answers).toEqual([{ text: 'done' }]);
    });

    test('the chat id comes from the update, never from the button payload', async () => {
      const { handlers, adapter } = await startCapturing();
      const seen: { data: string; chatId: string }[] = [];
      adapter.onCallback(async request => {
        seen.push({ data: request.data, chatId: request.chatId });
        return { text: 'ok' };
      });
      const calls: CallbackCalls = { edits: [], answers: [] };

      // A forged payload naming another chat changes nothing.
      handlers.get('callback_query:data')?.(callbackCtx('s:1:999999', calls));
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(seen[0]?.chatId).toBe('555');
    });

    test('a tap from outside the whitelist does nothing but is still answered', async () => {
      const { handlers, adapter } = await startCapturing();
      let handled = false;
      adapter.onCallback(async () => {
        handled = true;
        return { text: 'should not happen' };
      });
      const calls: CallbackCalls = { edits: [], answers: [] };

      handlers.get('callback_query:data')?.(callbackCtx('s:1', calls, 777_000_111));
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(handled).toBe(false);
      expect(calls.edits).toEqual([]);
      // Always answered — otherwise the client spins forever.
      expect(calls.answers).toHaveLength(1);
    });

    test('an unknown token is answered with a note and edits nothing', async () => {
      const { handlers, adapter } = await startCapturing();
      adapter.onCallback(async () => null);
      const calls: CallbackCalls = { edits: [], answers: [] };

      handlers.get('callback_query:data')?.(callbackCtx('nonsense', calls));
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(calls.edits).toEqual([]);
      expect(calls.answers).toEqual([{ text: 'That button is no longer valid' }]);
    });

    test('a handler that throws still answers the query', async () => {
      const { handlers, adapter } = await startCapturing();
      adapter.onCallback(async () => {
        throw new Error('boom');
      });
      const calls: CallbackCalls = { edits: [], answers: [] };

      handlers.get('callback_query:data')?.(callbackCtx('s:1', calls));
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(calls.answers).toEqual([{ text: 'Something went wrong' }]);
    });

    test('a message with a keyboard sends it as Telegram markup', async () => {
      process.env.TELEGRAM_ALLOWED_USER_IDS = '4242';
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const sent: { options?: { reply_markup?: unknown } }[] = [];
      (adapter.getBot() as unknown as { api: { sendMessage: unknown } }).api.sendMessage = (async (
        _chatId: number,
        _text: string,
        options?: { reply_markup?: unknown }
      ) => {
        sent.push({ options });
        return { message_id: 1 };
      }) as never;

      await adapter.sendMessage('555', 'pick one', {
        keyboard: { persistent: [['Chats', 'New chat']] },
      });

      expect(sent[0]?.options?.reply_markup).toEqual({
        keyboard: [[{ text: 'Chats' }, { text: 'New chat' }]],
        resize_keyboard: true,
        is_persistent: true,
      });
    });
  });
});

describe('what does not belong in a chat', () => {
  test('a tool call is console structure, not a message to a person', () => {
    // It arrived in Telegram as
    //   ✏️READ  Reading: /Users/…/artifacts/uploads/…_photo-….jpg
    // — noise on a phone, and absolute host paths posted into a chat.
    expect(isStructuralCategory('tool_call_formatted')).toBe(true);
    expect(isStructuralCategory('isolation_context')).toBe(true);
  });

  test('anything the agent actually says still goes through', () => {
    expect(isStructuralCategory(undefined)).toBe(false);
    expect(isStructuralCategory('workflow_status')).toBe(false);
    expect(isStructuralCategory('')).toBe(false);
  });

  test('sendMessage drops them instead of posting them', async () => {
    const adapter = new TelegramAdapter('fake-token-for-testing');
    const sent: unknown[] = [];
    adapter.getBot().api.sendMessage = mock(async (chatId: unknown, text: unknown) => {
      sent.push(text);
      return {
        message_id: 1,
        date: 0,
        chat: { id: Number(chatId), type: 'private', first_name: 'Test' },
        text: String(text),
      };
    }) as unknown as Api['sendMessage'];

    await adapter.sendMessage('352328891', '✏️READ  Reading: /Users/someone/secret/path.jpg', {
      category: 'tool_call_formatted',
    });
    expect(sent).toEqual([]);

    await adapter.sendMessage('352328891', 'I read the screenshot: it shows the lobby.');
    expect(sent).toHaveLength(1);
  });
});

/**
 * The adapter's half of outbound images: the text goes out as before, and the
 * pictures follow it. What may be shown is decided in `outbound-images.ts`,
 * which has its own tests — these are about the wiring.
 */
describe('images in a reply', () => {
  const trackTempRoot = trackTempRoots();
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function instrument(adapter: TelegramAdapter): { texts: string[]; photos: unknown[] } {
    const texts: string[] = [];
    const photos: unknown[] = [];
    adapter.getBot().api.sendMessage = mock(async (chatId: unknown, text: unknown) => {
      texts.push(String(text));
      return {
        message_id: 1,
        date: 0,
        chat: { id: Number(chatId), type: 'private', first_name: 'Test' },
        text: String(text),
      };
    }) as unknown as Api['sendMessage'];
    adapter.getBot().api.sendPhoto = mock(async (_chatId: unknown, photo: unknown) => {
      photos.push(photo);
      return { message_id: 2 };
    }) as unknown as Api['sendPhoto'];
    return { texts, photos };
  }

  test('a reply carries no picture until the install says which roots are allowed', async () => {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-tg-adapter-')));
    await writeFile(join(root, 'shot.png'), PNG);
    const adapter = new TelegramAdapter('fake-token-for-testing');
    const { texts, photos } = instrument(adapter);

    await adapter.sendMessage('352328891', `Готово: ${join(root, 'shot.png')}`);

    expect(texts).toHaveLength(1);
    expect(photos).toHaveLength(0);
  });

  test('with roots resolved, the picture follows the text', async () => {
    const root = await realpath(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-tg-adapter-'))));
    await writeFile(join(root, 'shot.png'), PNG);
    const adapter = new TelegramAdapter('fake-token-for-testing');
    adapter.onImageRoots(async () => [root]);
    const { texts, photos } = instrument(adapter);

    await adapter.sendMessage('352328891', `Готово: ${join(root, 'shot.png')}`);

    expect(texts).toHaveLength(1);
    expect(photos).toHaveLength(1);
  });

  test('a resolver that fails costs the picture, not the answer', async () => {
    const root = await realpath(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-tg-adapter-'))));
    await writeFile(join(root, 'shot.png'), PNG);
    const adapter = new TelegramAdapter('fake-token-for-testing');
    adapter.onImageRoots(async () => {
      throw new Error('the conversation row is gone');
    });
    const { texts, photos } = instrument(adapter);

    await adapter.sendMessage('352328891', `Готово: ${join(root, 'shot.png')}`);

    expect(texts).toHaveLength(1);
    expect(photos).toHaveLength(0);
  });

  test('a structural message is still dropped whole, pictures included', async () => {
    const root = await realpath(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-tg-adapter-'))));
    await writeFile(join(root, 'shot.png'), PNG);
    const adapter = new TelegramAdapter('fake-token-for-testing');
    adapter.onImageRoots(async () => [root]);
    const { texts, photos } = instrument(adapter);

    await adapter.sendMessage('352328891', `Reading: ${join(root, 'shot.png')}`, {
      category: 'tool_call_formatted',
    });

    expect(texts).toHaveLength(0);
    expect(photos).toHaveLength(0);
  });
});
