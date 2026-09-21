/**
 * The last link in the chain: the adapter's own Bot API calls.
 *
 * `turn-status.test.ts` proves the lifecycle against a fake transport, which
 * leaves exactly one thing unproven — that the transport the adapter hands out
 * calls the right grammY methods with the right arguments. That gap matters
 * more here than it usually would: the transport swallows its own failures, so
 * a wrong call would not throw, would not reach the operator, and would make
 * the whole feature look switched off rather than broken.
 */
import { describe, test, expect, mock } from 'bun:test';
import type { Api } from 'grammy';

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

import { TelegramAdapter } from './adapter';

type SendMessage = Api['sendMessage'];
type EditMessageText = Api['editMessageText'];
type DeleteMessage = Api['deleteMessage'];
type SendChatAction = Api['sendChatAction'];

function adapterWithStubbedApi(): {
  adapter: TelegramAdapter;
  sendMessage: ReturnType<typeof mock<SendMessage>>;
  editMessageText: ReturnType<typeof mock<EditMessageText>>;
  deleteMessage: ReturnType<typeof mock<DeleteMessage>>;
  sendChatAction: ReturnType<typeof mock<SendChatAction>>;
} {
  const adapter = new TelegramAdapter('fake-token-for-testing');
  const sendMessage = mock<SendMessage>(async (chatId, text) => ({
    message_id: 777,
    date: 0,
    chat: { id: typeof chatId === 'number' ? chatId : 0, type: 'private', first_name: 'Test' },
    text,
  }));
  const editMessageText = mock<EditMessageText>(async () => true as never);
  const deleteMessage = mock<DeleteMessage>(async () => true);
  const sendChatAction = mock<SendChatAction>(async () => true);
  adapter.getBot().api.sendMessage = sendMessage;
  adapter.getBot().api.editMessageText = editMessageText;
  adapter.getBot().api.deleteMessage = deleteMessage;
  adapter.getBot().api.sendChatAction = sendChatAction;
  return { adapter, sendMessage, editMessageText, deleteMessage, sendChatAction };
}

describe('TelegramAdapter.statusTransport', () => {
  test('posts the line as plain text and hands back the message id', async () => {
    const { adapter, sendMessage } = adapterWithStubbedApi();

    const messageId = await adapter.statusTransport('12345').send('⏳ Thinking…');

    expect(messageId).toBe(777);
    // Two arguments exactly: no MarkdownV2, because a line can carry a file
    // name and `plan_b.md` would make the formatter a source of failures.
    expect(sendMessage).toHaveBeenCalledWith(12345, '⏳ Thinking…');
  });

  test('a chat holding several conversations still resolves to its chat id', async () => {
    const { adapter, sendMessage } = adapterWithStubbedApi();

    await adapter.statusTransport('12345:3').send('⏳ Thinking…');

    expect(sendMessage).toHaveBeenCalledWith(12345, '⏳ Thinking…');
  });

  test('rewrites in place through editMessageText', async () => {
    const { adapter, editMessageText } = adapterWithStubbedApi();

    await adapter.statusTransport('12345').edit(777, '⏳ Running tests…');

    expect(editMessageText).toHaveBeenCalledWith(12345, 777, '⏳ Running tests…');
  });

  test('takes the line away through deleteMessage, and says it did', async () => {
    const { adapter, deleteMessage } = adapterWithStubbedApi();

    expect(await adapter.statusTransport('12345').remove(777)).toBe(true);
    expect(deleteMessage).toHaveBeenCalledWith(12345, 777);
  });

  test('the typing bubble is the cheap complement, not a message', async () => {
    const { adapter, sendChatAction, sendMessage } = adapterWithStubbedApi();

    await adapter.statusTransport('12345').typing();

    expect(sendChatAction).toHaveBeenCalledWith(12345, 'typing');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('none of it throws when Telegram refuses', async () => {
    const { adapter, sendMessage, editMessageText, deleteMessage, sendChatAction } =
      adapterWithStubbedApi();
    sendMessage.mockRejectedValue(new Error('429: Too Many Requests'));
    editMessageText.mockRejectedValue(new Error('400: message is not modified'));
    deleteMessage.mockRejectedValue(new Error("400: message can't be deleted"));
    sendChatAction.mockRejectedValue(new Error('403: bot was blocked'));
    const transport = adapter.statusTransport('12345');

    // Null, and logged at WARN rather than debug — the default LOG_LEVEL is
    // `info`, so "the line never appeared" must not be an event that leaves no
    // trace anywhere. Not asserted here: the module-level logger mock is shared
    // across this directory's test files, so whose mock `getLog` cached depends
    // on the order they ran in.
    expect(await transport.send('⏳ Thinking…')).toBeNull();
    expect(await transport.edit(777, '⏳ Running tests…')).toBeUndefined();
    // False, so the caller knows to leave a final line instead of nothing.
    expect(await transport.remove(777)).toBe(false);
    expect(await transport.typing()).toBeUndefined();
  });
});
