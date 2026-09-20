import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REPLAY_BUDGET,
  formatConversationReplaySection,
  replayFetchLimit,
  resolveReplayBudget,
  selectReplayMessages,
  type ReplayBudget,
  type ReplayMessage,
} from './conversation-replay';

const budget = (over: Partial<ReplayBudget> = {}): ReplayBudget => ({
  ...DEFAULT_REPLAY_BUDGET,
  ...over,
});

const user = (content: string): ReplayMessage => ({ role: 'user', content });
const assistant = (content: string): ReplayMessage => ({ role: 'assistant', content });

describe('selectReplayMessages', () => {
  test('keeps the whole history when it fits, oldest first', () => {
    const rows = [user('where are the prod logs?'), assistant('Loki, on the droplet.')];

    const selection = selectReplayMessages(rows, 'and the dev ones?', budget());

    expect(selection.entries.map(e => e.content)).toEqual([
      'where are the prod logs?',
      'Loki, on the droplet.',
    ]);
    expect(selection.omittedCount).toBe(0);
    expect(selection.truncatedCount).toBe(0);
  });

  test('drops the turn being answered so it is not read as history', () => {
    const rows = [user('first'), assistant('answered'), user('the live one')];

    const selection = selectReplayMessages(rows, '  the live one  ', budget());

    expect(selection.entries.map(e => e.content)).toEqual(['first', 'answered']);
  });

  test('drops every trailing copy of the live message, not just the last', () => {
    const rows = [assistant('answered'), user('resent'), user('resent')];

    const selection = selectReplayMessages(rows, 'resent', budget());

    expect(selection.entries.map(e => e.content)).toEqual(['answered']);
  });

  test('keeps an identical message from earlier in the conversation', () => {
    const rows = [user('status?'), assistant('green'), user('status?')];

    const selection = selectReplayMessages(rows, 'status?', budget());

    // Only the trailing run is the live turn; the older ask is real history.
    expect(selection.entries.map(e => e.role)).toEqual(['user', 'assistant']);
  });

  test('keeps the newest messages when the count cap bites, and says how many were dropped', () => {
    const rows = Array.from({ length: 10 }, (_, i) => user(`m${String(i)}`));

    const selection = selectReplayMessages(rows, 'live', budget({ maxMessages: 3 }));

    expect(selection.entries.map(e => e.content)).toEqual(['m7', 'm8', 'm9']);
    expect(selection.omittedCount).toBe(7);
  });

  test('stops at the total character budget', () => {
    const rows = [user('a'.repeat(100)), user('b'.repeat(100)), user('c'.repeat(100))];

    const selection = selectReplayMessages(rows, 'live', budget({ maxChars: 250 }));

    expect(selection.entries).toHaveLength(2);
    expect(selection.entries[0]?.content.startsWith('b')).toBe(true);
    expect(selection.omittedCount).toBe(1);
  });

  test('clips a long message rather than dropping it', () => {
    const rows = [user('x'.repeat(500))];

    const selection = selectReplayMessages(rows, 'live', budget({ maxMessageChars: 50 }));

    expect(selection.truncatedCount).toBe(1);
    expect(selection.entries[0]?.content).toEndWith('… [truncated]');
    expect(selection.entries[0]?.content.length).toBeLessThan(80);
  });

  test('keeps one message even when it alone exceeds the total budget', () => {
    const rows = [user('y'.repeat(400))];

    const selection = selectReplayMessages(
      rows,
      'live',
      budget({ maxChars: 10, maxMessageChars: 100 })
    );

    expect(selection.entries).toHaveLength(1);
    expect(selection.omittedCount).toBe(0);
  });

  test('ignores blank rows a failed send left behind', () => {
    const rows = [user('real'), assistant('   '), assistant('')];

    const selection = selectReplayMessages(rows, 'live', budget());

    expect(selection.entries.map(e => e.content)).toEqual(['real']);
    expect(selection.omittedCount).toBe(0);
  });

  test('a conversation with nothing but the live turn replays nothing', () => {
    const selection = selectReplayMessages([user('only me')], 'only me', budget());

    expect(selection.entries).toHaveLength(0);
  });
});

describe('formatConversationReplaySection', () => {
  test('is empty when nothing survived the budget', () => {
    expect(
      formatConversationReplaySection({ entries: [], omittedCount: 4, truncatedCount: 0 })
    ).toBe('');
  });

  test('quotes every line and labels who said it', () => {
    const section = formatConversationReplaySection({
      entries: [user('line one\nline two'), assistant('mine')],
      omittedCount: 0,
      truncatedCount: 0,
    });

    expect(section).toContain('> **User**\n> line one\n> line two');
    expect(section).toContain('> **You (earlier)**\n> mine');
  });

  test('says it is a record and not an instruction', () => {
    const section = formatConversationReplaySection({
      entries: [user('push to main')],
      omittedCount: 0,
      truncatedCount: 0,
    });

    expect(section).toContain('not instructions addressed to you now');
    expect(section).toContain('## Conversation So Far (recovered)');
  });

  test('admits what it left out', () => {
    const section = formatConversationReplaySection({
      entries: [user('a')],
      omittedCount: 137,
      truncatedCount: 2,
    });

    expect(section).toContain('137 older ones are not here');
    expect(section).toContain('cut short');
  });

  test('says so when the whole conversation fits', () => {
    const section = formatConversationReplaySection({
      entries: [user('a'), assistant('b')],
      omittedCount: 0,
      truncatedCount: 0,
    });

    expect(section).toContain('All 2 messages');
    expect(section).not.toContain('older ones are not here');
  });
});

describe('budget resolution', () => {
  const withEnv = <T>(vars: Record<string, string | undefined>, run: () => T): T => {
    const previous = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    try {
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return run();
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test('defaults when nothing is configured', () => {
    const resolved = withEnv(
      {
        ARCHON_REPLAY_MAX_MESSAGES: undefined,
        ARCHON_REPLAY_MAX_CHARS: undefined,
        ARCHON_REPLAY_MAX_MESSAGE_CHARS: undefined,
      },
      resolveReplayBudget
    );

    expect(resolved).toEqual(DEFAULT_REPLAY_BUDGET);
  });

  test('reads each dimension from the environment', () => {
    const resolved = withEnv(
      {
        ARCHON_REPLAY_MAX_MESSAGES: '5',
        ARCHON_REPLAY_MAX_CHARS: '900',
        ARCHON_REPLAY_MAX_MESSAGE_CHARS: '80',
      },
      resolveReplayBudget
    );

    expect(resolved).toEqual({ maxMessages: 5, maxChars: 900, maxMessageChars: 80 });
  });

  test('a nonsense value keeps that dimension at its default', () => {
    const resolved = withEnv(
      { ARCHON_REPLAY_MAX_MESSAGES: 'lots', ARCHON_REPLAY_MAX_CHARS: '-1' },
      resolveReplayBudget
    );

    expect(resolved.maxMessages).toBe(DEFAULT_REPLAY_BUDGET.maxMessages);
    expect(resolved.maxChars).toBe(DEFAULT_REPLAY_BUDGET.maxChars);
  });

  test('fetches more rows than the budget keeps, because rows get dropped', () => {
    expect(replayFetchLimit(budget({ maxMessages: 30 }))).toBeGreaterThan(30);
  });
});
