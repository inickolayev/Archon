import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatList } from './ChatList';
import { conversationLabel, type ConversationSummary } from '../primitives/conversation';

const conv = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'web-1',
  title: 'Status of the open PRs',
  platformType: 'web',
  lastActivityAt: '2026-09-19T10:00:00.000Z',
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
