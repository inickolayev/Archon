import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatList } from './ChatList';
import { conversationLabel, type ConversationSummary } from '../primitives/conversation';

const conv = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'web-1',
  title: 'Status of the open PRs',
  platformType: 'web',
  lastActivityAt: '2026-09-19T10:00:00.000Z',
  userId: null,
  ...over,
});

describe('ChatList', () => {
  test('renders a row per chat, with its title', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[
          conv(),
          conv({ id: 'web-2', title: 'Bot calibration' }),
          conv({ id: 'web-3', title: 'Deploy checklist' }),
        ]}
        activeId="web-2"
        onSelect={() => undefined}
      />
    );
    expect(html.match(/<li>/g)?.length).toBe(3);
    expect(html).toContain('Status of the open PRs');
    expect(html).toContain('Bot calibration');
    expect(html).toContain('Deploy checklist');
  });

  test('marks the active row', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[conv(), conv({ id: 'web-2', title: 'Bot calibration' })]}
        activeId="web-2"
        onSelect={() => undefined}
      />
    );
    expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    // The marked row is the second one.
    expect(html.indexOf('aria-current="true"')).toBeGreaterThan(html.indexOf('Status of the open'));
  });

  test('an untitled chat still shows something useful, never a blank row', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[conv({ title: null })]}
        activeId={null}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain('Chat ·');
    expect(html).not.toContain('><span class="truncate text-[12px] text-text-secondary"></span>');
  });

  test('a chat that was never used says so instead of showing a stale time', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[conv({ title: null, lastActivityAt: null })]}
        activeId={null}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain('Untitled chat');
    expect(html).toContain('not started');
  });

  test('says the project has no chats rather than rendering an empty list', () => {
    const html = renderToStaticMarkup(
      <ChatList conversations={[]} activeId={null} onSelect={() => undefined} />
    );
    expect(html).toContain('No chats in this project yet.');
    expect(html).not.toContain('<li>');
  });
});

describe('conversationLabel', () => {
  const now = Date.parse('2026-09-19T10:05:00.000Z');

  test('prefers the server title', () => {
    expect(conversationLabel(conv(), now)).toBe('Status of the open PRs');
  });

  test('falls back to the last activity, then to a placeholder', () => {
    expect(conversationLabel(conv({ title: null }), now)).toBe('Chat · 5m ago');
    expect(conversationLabel(conv({ title: '   ' }), now)).toBe('Chat · 5m ago');
    expect(conversationLabel(conv({ title: null, lastActivityAt: null }), now)).toBe(
      'Untitled chat'
    );
  });
});

describe('ChatList platform markers', () => {
  test('a Telegram chat is recognisable at a glance', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[
          conv({ id: 'web-1', title: 'From the browser' }),
          conv({ id: '123456789:2', title: 'From the phone', platformType: 'telegram' }),
        ]}
        activeId={null}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain('telegram');
    expect(html).toContain('From the phone');
  });

  test('lists conversations of every platform, not just the console\u2019s own', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[
          conv({ id: '123:2', platformType: 'telegram', title: 'Phone thread' }),
          conv({ id: 'cli-9', platformType: 'cli', title: 'CLI run' }),
        ]}
        activeId="123:2"
        onSelect={() => undefined}
      />
    );
    expect(html.match(/<li>/g)?.length).toBe(2);
    expect(html).toContain('Phone thread');
    expect(html).toContain('CLI run');
    expect(html).toContain('cli');
  });
});

describe('ChatList — whose chat is this', () => {
  const directory = {
    me: 'user-me',
    users: [
      { id: 'user-me', displayName: 'Igor Nikolaev', email: 'igorabcpps@gmail.com' },
      { id: 'user-other', displayName: 'Ada Lovelace', email: 'ada@example.com' },
      { id: 'user-nameless', displayName: null, email: 'someone@example.com' },
    ],
  };

  test('my own chat reads "you", and says which account that is', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[conv({ userId: 'user-me' })]}
        activeId={null}
        onSelect={() => undefined}
        directory={directory}
      />
    );
    expect(html).toContain('you (Igor Nikolaev)');
  });

  test("someone else's chat reads as them, with no email when a name exists", () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[conv({ userId: 'user-other' })]}
        activeId={null}
        onSelect={() => undefined}
        directory={directory}
      />
    );
    expect(html).toContain('Ada Lovelace');
    expect(html).not.toContain('ada@example.com');
    expect(html).not.toContain('you (');
  });

  test('a nameless author falls back to their email', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[conv({ userId: 'user-nameless' })]}
        activeId={null}
        onSelect={() => undefined}
        directory={directory}
      />
    );
    expect(html).toContain('someone@example.com');
  });

  test('with no directory loaded the rows stay as they were — no invented author', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[conv({ userId: 'user-me' })]}
        activeId={null}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain('Status of the open PRs');
    expect(html).not.toContain('you (');
  });

  test('an unowned chat gets no author at all, rather than a guess', () => {
    const html = renderToStaticMarkup(
      <ChatList
        conversations={[conv({ userId: null })]}
        activeId={null}
        onSelect={() => undefined}
        directory={directory}
      />
    );
    expect(html).not.toContain('you');
    expect(html).not.toContain('Igor Nikolaev');
  });
});
