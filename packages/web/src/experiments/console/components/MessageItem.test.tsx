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
  files: [],
  ...over,
});

describe('MessageItem — a message that was spoken', () => {
  const spoken = (note: string, words: string): Message =>
    message({ content: `🎙 **Dictated** — ${note}\n\n${words}` });

  test('draws the recording and the words it was turned into', () => {
    const html = renderToStaticMarkup(
      <MessageItem message={spoken('0:42, transcribed and tidied up', 'посмотри деплой')} />
    );

    expect(html).toContain('0:42, transcribed and tidied up');
    // Open by default: the transcript IS the message, and a chat of folded rows
    // could not be read back.
    expect(html).toContain('посмотри деплой');
    expect(html).toContain('aria-expanded="true"');
    // The marker itself never reaches the screen as text.
    expect(html).not.toContain('Dictated');
  });

  test('a recording nothing could be made of shows the reason and nothing to open', () => {
    const html = renderToStaticMarkup(
      <MessageItem message={spoken('0:42, not transcribed: speech recognition failed', '')} />
    );

    expect(html).toContain('not transcribed');
    expect(html).not.toContain('aria-expanded');
  });

  test('a typed message is untouched by any of it', () => {
    const html = renderToStaticMarkup(<MessageItem message={message()} />);

    expect(html).toContain('ship it');
    expect(html).not.toContain('aria-expanded');
  });
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

describe('MessageItem — pictures an answer names', () => {
  const answer = message({
    role: 'assistant',
    content: 'Готово. Файлы: /tmp/devshot/desktop.png',
  });

  test('renders the picture, and a way to open it full screen', () => {
    const html = renderToStaticMarkup(<MessageItem message={answer} conversationId="web-1" />);
    expect(html).toContain('/api/conversations/web-1/image?path=%2Ftmp%2Fdevshot%2Fdesktop.png');
    expect(html).toContain('Open desktop.png full screen');
  });

  test('the run log, which has no conversation, still reads as plain text', () => {
    const html = renderToStaticMarkup(<MessageItem message={answer} variant="log" />);
    expect(html).not.toContain('<img');
    expect(html).toContain('/tmp/devshot/desktop.png');
  });
});

describe('MessageItem — something the writer quoted', () => {
  const quoted = (body: string): string =>
    `> **Quoted context — forwarded from the channel "Ops"**\n> staging is down\n\n${body}`;

  test('draws the quote as a quote, with where it came from', () => {
    const html = renderToStaticMarkup(
      <MessageItem message={message({ content: quoted('look') })} />
    );

    expect(html).toContain('<blockquote');
    expect(html).toContain('forwarded from the channel &quot;Ops&quot;');
    expect(html).toContain('staging is down');
    // The markup itself never reaches the screen — it is drawn, not printed.
    expect(html).not.toContain('Quoted context —');
  });

  test("the operator's own words stay outside the quote", () => {
    const html = renderToStaticMarkup(
      <MessageItem message={message({ content: quoted('what do you make of this') })} />
    );
    const afterQuote = html.slice(html.lastIndexOf('</blockquote>'));

    expect(afterQuote).toContain('what do you make of this');
    expect(afterQuote).not.toContain('staging is down');
  });

  test('an agent reply that quotes something renders it the same way', () => {
    const html = renderToStaticMarkup(
      <MessageItem message={message({ role: 'assistant', content: quoted('reading it now') })} />
    );

    expect(html).toContain('<blockquote');
    expect(html).toContain('reading it now');
  });

  test('a message with no quote is drawn exactly as before', () => {
    const html = renderToStaticMarkup(<MessageItem message={message({ content: 'ship it' })} />);

    expect(html).not.toContain('<blockquote');
    expect(html).toContain('ship it');
  });

  test('the reply affordance appears only where a reply can be taken', () => {
    const withReply = renderToStaticMarkup(
      <MessageItem message={message()} onReply={() => undefined} />
    );
    const without = renderToStaticMarkup(<MessageItem message={message()} />);

    expect(withReply).toContain('Reply to this message');
    expect(without).not.toContain('Reply to this message');
  });
});
