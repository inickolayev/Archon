import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageItem } from './MessageItem';
import type { Message } from '../primitives/message';
import type { Directory } from '../primitives/author';

const directory: Directory = {
  me: 'user-me',
  users: [
    { id: 'user-me', displayName: 'Igor Nikolaev', email: 'igorabcpps@gmail.com' },
    { id: 'user-other', displayName: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 'user-nameless', displayName: null, email: 'someone@example.com' },
  ],
};

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  role: 'user',
  content: 'ship it',
  timestamp: '2026-09-19T10:00:00.000Z',
  userId: null,
  toolCalls: [],
  error: null,
  category: null,
  dispatch: null,
  workflowResult: null,
  ...over,
});

describe('MessageItem — who wrote it', () => {
  test('my own message says you, and which account that is', () => {
    const html = renderToStaticMarkup(
      <MessageItem message={message({ userId: 'user-me' })} directory={directory} />
    );
    expect(html).toContain('you (Igor Nikolaev)');
  });

  test("someone else's message is just their name — no you, no email", () => {
    const html = renderToStaticMarkup(
      <MessageItem message={message({ userId: 'user-other' })} directory={directory} />
    );
    expect(html).toContain('Ada Lovelace');
    expect(html).not.toContain('you (');
    expect(html).not.toContain('ada@example.com');
  });

  test('a nameless author falls back to their email', () => {
    const html = renderToStaticMarkup(
      <MessageItem message={message({ userId: 'user-nameless' })} directory={directory} />
    );
    expect(html).toContain('someone@example.com');
  });

  test('a message from before accounts existed keeps the plain "You" badge', () => {
    const html = renderToStaticMarkup(
      <MessageItem message={message({ userId: null })} directory={directory} />
    );
    expect(html).toContain('You');
    expect(html).not.toContain('you (');
  });

  test('with no directory loaded, nothing is invented', () => {
    const html = renderToStaticMarkup(<MessageItem message={message({ userId: 'user-me' })} />);
    expect(html).toContain('You');
    expect(html).not.toContain('Igor Nikolaev');
  });

  test('the agent is still the agent — author labels never apply to its replies', () => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={message({ role: 'assistant', userId: 'user-me', content: 'done' })}
        directory={directory}
      />
    );
    expect(html).toContain('Agent');
    expect(html).not.toContain('Igor Nikolaev');
  });
});
