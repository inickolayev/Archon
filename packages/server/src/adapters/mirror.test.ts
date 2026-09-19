import { describe, expect, test } from 'bun:test';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { MirrorBuffer, withOutboundMirror } from './mirror';

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
    return `${originalConversationId}:thread`;
  }
  getStreamingMode(): 'stream' | 'batch' {
    return 'stream';
  }
  getPlatformType(): string {
    return 'web';
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

describe('MirrorBuffer', () => {
  test('joins the chunks of one streamed answer into one message', () => {
    const buffer = new MirrorBuffer();
    buffer.capture('The ');
    buffer.capture('answer ');
    buffer.capture('is 42.');
    expect(buffer.take()).toEqual([{ category: undefined, text: 'The answer is 42.' }]);
  });

  test('a new segment starts a new message', () => {
    const buffer = new MirrorBuffer();
    buffer.capture('first');
    buffer.capture('second', { segment: 'new' });
    expect(buffer.take().map(m => m.text)).toEqual(['first', 'second']);
  });

  test('a category change starts a new message (a workflow status is its own)', () => {
    const buffer = new MirrorBuffer();
    buffer.capture('plain text');
    buffer.capture('🚀 Started', { category: 'workflow_status' });
    buffer.capture(' the run', { category: 'workflow_status' });
    expect(buffer.take()).toEqual([
      { category: undefined, text: 'plain text' },
      { category: 'workflow_status', text: '🚀 Started the run' },
    ]);
  });

  test('drops what the web renders structurally rather than as text', () => {
    const buffer = new MirrorBuffer();
    buffer.capture('🔧 Read(file.ts)', { category: 'tool_call_formatted' });
    buffer.capture('context', { category: 'isolation_context' });
    expect(buffer.take()).toEqual([]);
  });

  test('take() empties the buffer, so a second turn does not resend the first', () => {
    const buffer = new MirrorBuffer();
    buffer.capture('once');
    expect(buffer.take()).toHaveLength(1);
    expect(buffer.take()).toEqual([]);
  });

  test('whitespace-only captures are not delivered', () => {
    const buffer = new MirrorBuffer();
    buffer.capture('   \n');
    expect(buffer.take()).toEqual([]);
  });
});

describe('withOutboundMirror', () => {
  test('the primary delivery still happens, unchanged', async () => {
    const primary = new FakeAdapter();
    const captured: string[] = [];
    const wrapped = withOutboundMirror(primary, text => captured.push(text));

    await wrapped.sendMessage('123:2', 'hello', { category: 'workflow_status' });

    expect(primary.sent).toEqual([
      { conversationId: '123:2', message: 'hello', metadata: { category: 'workflow_status' } },
    ]);
    expect(captured).toEqual(['hello']);
  });

  test('captures after delivery, so a mirror never precedes the real answer', async () => {
    const order: string[] = [];
    const primary = new FakeAdapter();
    const slow = withOutboundMirror(
      new Proxy(primary, {
        get(target, prop) {
          if (prop === 'sendMessage') {
            return async (id: string, text: string): Promise<void> => {
              await new Promise(resolve => setTimeout(resolve, 5));
              order.push('primary');
              await target.sendMessage(id, text);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
      () => order.push('mirror')
    );

    await slow.sendMessage('123', 'hi');
    expect(order).toEqual(['primary', 'mirror']);
  });

  test('every other member is forwarded, private fields included', async () => {
    const primary = new FakeAdapter();
    const wrapped = withOutboundMirror(primary, () => undefined);

    expect(wrapped.getPlatformType()).toBe('web');
    expect(wrapped.getStreamingMode()).toBe('stream');
    expect(await wrapped.ensureThread('c1')).toBe('c1:thread');
    // A hand-written wrapper would have to remember this one; the proxy cannot
    // forget it — and binding to the target is what keeps `#private` working.
    expect((wrapped as unknown as FakeAdapter).secret()).toContain('private field');
  });

  test('a failing primary is not swallowed, and nothing is mirrored', async () => {
    const captured: string[] = [];
    const failing = {
      ...new FakeAdapter(),
      sendMessage: async (): Promise<void> => {
        throw new Error('web delivery failed');
      },
    } as unknown as IPlatformAdapter;
    const wrapped = withOutboundMirror(failing, text => captured.push(text));

    await expect(wrapped.sendMessage('123', 'hi')).rejects.toThrow('web delivery failed');
    expect(captured).toEqual([]);
  });
});
