import { describe, expect, test } from 'bun:test';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import type { MessageChunk } from '@archon/providers/types';
import { TurnStatus, type StatusTransport } from '@archon/adapters';
import { MirrorBuffer, withOutboundMirror } from './mirror';
import { createTurnStatus, telegramStatusConfig, withTurnStatus } from './telegram-status';

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

class FakeAdapter implements IPlatformAdapter {
  readonly sent: { conversationId: string; message: string; metadata?: MessageMetadata }[] = [];
  #secret = 'private field — a proxy must not break access to it';

  async sendMessage(
    conversationId: string,
    message: string,
    metadata?: MessageMetadata
  ): Promise<void> {
    this.sent.push({ conversationId, message, metadata });
  }
  async ensureThread(originalConversationId: string): Promise<string> {
    return originalConversationId;
  }
  getStreamingMode(): 'stream' | 'batch' {
    return 'stream';
  }
  getPlatformType(): string {
    return 'telegram';
  }
  async start(): Promise<void> {
    /* nothing to start */
  }
  stop(): void {
    /* nothing to stop */
  }
  secret(): string {
    return this.#secret;
  }
}

/** Records what the bot would have posted, edited and deleted. */
class FakeTransport implements StatusTransport {
  readonly sent: string[] = [];
  readonly edited: string[] = [];
  readonly removed: number[] = [];
  #nextId = 1;

  async send(text: string): Promise<number | null> {
    this.sent.push(text);
    return this.#nextId++;
  }
  async edit(_messageId: number, text: string): Promise<void> {
    this.edited.push(text);
  }
  async remove(messageId: number): Promise<boolean> {
    this.removed.push(messageId);
    return true;
  }
  async typing(): Promise<void> {
    /* nothing to record */
  }
}

const toolEvent = (toolName: string, toolInput?: Record<string, unknown>): MessageChunk => ({
  type: 'tool',
  toolName,
  ...(toolInput === undefined ? {} : { toolInput }),
});

describe('telegramStatusConfig', () => {
  test('defaults: on, and one edit every three seconds', () => {
    const config = telegramStatusConfig({} as NodeJS.ProcessEnv);
    expect(config.TELEGRAM_STATUS_ENABLED).toBe(true);
    expect(config.TELEGRAM_STATUS_THROTTLE_MS).toBe(3000);
  });

  test('an install can switch the line off entirely', () => {
    const env = { TELEGRAM_STATUS_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv;
    expect(telegramStatusConfig(env).TELEGRAM_STATUS_ENABLED).toBe(false);
  });

  test('a mistyped throttle takes the documented default rather than flooding', () => {
    const env = { TELEGRAM_STATUS_THROTTLE_MS: 'soon' } as unknown as NodeJS.ProcessEnv;
    expect(telegramStatusConfig(env).TELEGRAM_STATUS_THROTTLE_MS).toBe(3000);
  });
});

describe('createTurnStatus', () => {
  test('hands back nothing when the install has the line switched off', () => {
    const status = createTurnStatus(() => new FakeTransport(), '4242', {
      TELEGRAM_STATUS_ENABLED: false,
      TELEGRAM_STATUS_THROTTLE_MS: 3000,
    });
    expect(status).toBeNull();
  });

  test('a transport that cannot be built costs the line, not the turn', () => {
    const status = createTurnStatus(
      () => {
        throw new Error('Not a Telegram conversation id');
      },
      'web-conversation',
      { TELEGRAM_STATUS_ENABLED: true, TELEGRAM_STATUS_THROTTLE_MS: 3000 }
    );
    expect(status).toBeNull();
  });
});

describe('withTurnStatus', () => {
  test('a tool event moves the line on, in plain words', async () => {
    const transport = new FakeTransport();
    const status = new TurnStatus(transport, { throttleMs: 20 });
    const adapter: IPlatformAdapter = withTurnStatus(new FakeAdapter(), status);

    status.begin();
    await tick(5);
    await adapter.sendStructuredEvent?.('4242', toolEvent('Bash', { command: 'bun test' }));
    await tick(50);

    expect(transport.sent).toEqual(['⏳ Thinking…']);
    expect(transport.edited).toEqual(['⏳ Running tests…']);
  });

  test('the line never travels through sendMessage — so it is never written down', async () => {
    const transport = new FakeTransport();
    const status = new TurnStatus(transport, { throttleMs: 20 });
    const primary = new FakeAdapter();
    const adapter: IPlatformAdapter = withTurnStatus(primary, status);

    status.begin();
    await tick(5);
    await adapter.sendStructuredEvent?.(
      '4242',
      toolEvent('Read', { file_path: '/Users/op/repo/src/app/server.js' })
    );
    await tick(50);
    await status.clear();

    // `withPersistedOutbound` and `withOutboundMirror` both work by wrapping
    // `sendMessage`; a message that never goes through it cannot become a row
    // and cannot reach the console. Nothing here did.
    expect(primary.sent).toHaveLength(0);
    expect(transport.sent.length + transport.edited.length).toBeGreaterThan(0);
  });

  test('and nothing of it reaches the console through the outbound mirror', async () => {
    const buffer = new MirrorBuffer();
    const transport = new FakeTransport();
    const status = new TurnStatus(transport, { throttleMs: 20 });
    const primary = new FakeAdapter();
    // The real chain: the status wrap is outermost, the mirror inside it.
    const adapter: IPlatformAdapter = withTurnStatus(
      withOutboundMirror(primary, (text, metadata) => {
        buffer.capture(text, metadata);
      }),
      status
    );

    status.begin();
    await tick(5);
    await adapter.sendStructuredEvent?.('4242', toolEvent('Grep', { pattern: 'TODO' }));
    await tick(50);
    await adapter.sendMessage('4242', 'Found three of them.');
    await status.clear();

    // Only the real answer is mirrored; the console draws its own indicator.
    expect(buffer.take().map(m => m.text)).toEqual(['Found three of them.']);
    expect(transport.removed).toHaveLength(1);
  });

  test('a non-tool event is left alone', async () => {
    const transport = new FakeTransport();
    const status = new TurnStatus(transport, { throttleMs: 20 });
    const adapter: IPlatformAdapter = withTurnStatus(new FakeAdapter(), status);

    status.begin();
    await tick(5);
    await adapter.sendStructuredEvent?.('4242', { type: 'system', content: 'Sync failed' });
    await tick(50);

    expect(transport.edited).toHaveLength(0);
  });

  test('everything else is forwarded, private fields included', async () => {
    const primary = new FakeAdapter();
    const adapter = withTurnStatus(
      primary,
      new TurnStatus(new FakeTransport(), { throttleMs: 20 })
    );

    await adapter.sendMessage('4242', 'hello');
    expect(primary.sent.map(s => s.message)).toEqual(['hello']);
    expect(adapter.getPlatformType()).toBe('telegram');
    expect((adapter as FakeAdapter).secret()).toContain('private field');
  });

  test('with the line switched off the adapter is handed back untouched', () => {
    const primary = new FakeAdapter();
    expect(withTurnStatus(primary, null)).toBe(primary);
    expect((primary as IPlatformAdapter).sendStructuredEvent).toBeUndefined();
  });
});
