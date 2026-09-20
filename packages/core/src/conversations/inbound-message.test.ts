import { describe, expect, mock, test, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({ createLogger: mock(() => mockLogger) }));

const mockGetOrAdoptConversation = mock(async (..._args: unknown[]) => ({ id: 'conv-db-1' }));
mock.module('../db/conversations', () => ({
  getOrAdoptConversation: mockGetOrAdoptConversation,
}));

const mockAddMessage = mock(async (..._args: unknown[]) => ({ id: 'msg-1' }));
mock.module('../db/messages', () => ({ addMessage: mockAddMessage }));

const { persistInboundMessage } = await import('./inbound-message');

describe('persistInboundMessage', () => {
  beforeEach(() => {
    mockAddMessage.mockClear();
    mockGetOrAdoptConversation.mockClear();
    mockGetOrAdoptConversation.mockImplementation(async () => ({ id: 'conv-db-1' }));
    mockAddMessage.mockImplementation(async () => ({ id: 'msg-1' }));
  });

  test('writes the row against the conversation the turn will use', async () => {
    const landed = await persistInboundMessage({
      platformType: 'telegram',
      platformConversationId: '4242:2',
      text: 'what changed on main?',
      userId: 'user-1',
      sentAtMs: Date.parse('2026-09-20T13:35:00.000Z'),
    });

    expect(landed).toBe(true);
    // Adopted, never forked: `handleMessage` resolves the same row a moment
    // later through the same call, so asking twice costs a lookup and nothing
    // else.
    expect(mockGetOrAdoptConversation).toHaveBeenCalledWith(
      'telegram',
      '4242:2',
      undefined,
      undefined,
      'user-1'
    );
    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-1',
      'user',
      'what changed on main?',
      undefined,
      'user-1',
      { sentAtMs: Date.parse('2026-09-20T13:35:00.000Z') }
    );
  });

  test('without a reported send time the row is stamped as it is written', async () => {
    await persistInboundMessage({
      platformType: 'cli',
      platformConversationId: 'conv-1',
      text: 'hello',
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-1',
      'user',
      'hello',
      undefined,
      undefined,
      undefined
    );
  });

  test('attachment descriptions ride along', async () => {
    const metadata = { files: [{ name: 'shot.png', mimeType: 'image/png', size: 1234 }] };
    await persistInboundMessage({
      platformType: 'telegram',
      platformConversationId: '4242',
      text: 'what is wrong here?',
      metadata,
    });

    expect(mockAddMessage.mock.calls[0]?.[3]).toEqual(metadata);
  });

  test('a failed write costs the history, never the message', async () => {
    mockAddMessage.mockImplementationOnce(() => Promise.reject(new Error('db down')));

    const landed = await persistInboundMessage({
      platformType: 'telegram',
      platformConversationId: '4242',
      text: 'still goes to the agent',
    });

    // The caller carries on into the turn, and answering `false` is what tells
    // the orchestrator to write its own row later rather than skip it.
    expect(landed).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('a conversation lookup that throws is answered, not propagated', async () => {
    mockGetOrAdoptConversation.mockImplementationOnce(() => Promise.reject(new Error('no db')));

    await expect(
      persistInboundMessage({
        platformType: 'telegram',
        platformConversationId: '4242',
        text: 'hello',
      })
    ).resolves.toBe(false);
  });
});
