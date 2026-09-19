import { describe, expect, test } from 'bun:test';
import {
  activeConversationId,
  formatAgo,
  formatChatList,
  handleTelegramChatCommand,
  isTelegramChatCommand,
  nextConversationId,
  numberConversations,
  type TelegramChatRow,
  type TelegramChatStore,
} from './telegram-chats';

const CHAT = '123456789';
const NOW = Date.parse('2026-09-19T12:00:00.000Z');

const row = (
  over: Partial<TelegramChatRow> & { platform_conversation_id: string }
): TelegramChatRow => ({
  title: null,
  last_activity_at: null,
  ...over,
});

describe('numberConversations', () => {
  test('a legacy row with no suffix is conversation 1 of its chat', () => {
    const numbered = numberConversations(
      [row({ platform_conversation_id: CHAT, title: 'The original thread' })],
      CHAT
    );
    expect(numbered).toHaveLength(1);
    expect(numbered[0]?.index).toBe(1);
    expect(numbered[0]?.id).toBe(CHAT);
    expect(numbered[0]?.active).toBe(true);
  });

  test('numbers a legacy row and its suffixed siblings, in order', () => {
    const numbered = numberConversations(
      [
        row({ platform_conversation_id: `${CHAT}:3` }),
        row({ platform_conversation_id: CHAT }),
        row({ platform_conversation_id: `${CHAT}:2` }),
      ],
      CHAT
    );
    expect(numbered.map(c => c.index)).toEqual([1, 2, 3]);
    expect(numbered.map(c => c.id)).toEqual([CHAT, `${CHAT}:2`, `${CHAT}:3`]);
  });

  test('the newest activity is the active one', () => {
    const numbered = numberConversations(
      [
        row({ platform_conversation_id: CHAT, last_activity_at: '2026-09-19 10:00:00' }),
        row({ platform_conversation_id: `${CHAT}:2`, last_activity_at: '2026-09-19 11:59:00' }),
        row({ platform_conversation_id: `${CHAT}:3`, last_activity_at: '2026-09-18 23:00:00' }),
      ],
      CHAT
    );
    expect(numbered.find(c => c.active)?.index).toBe(2);
  });

  test('updated_at breaks a same-second tie in favour of the switch', () => {
    // SQLite stores last_activity_at to the second, so a /switch made in the
    // same second as the previous turn ties; markConversationActive also bumps
    // updated_at, which decides it.
    const numbered = numberConversations(
      [
        row({
          platform_conversation_id: `${CHAT}:3`,
          last_activity_at: '2026-09-19 12:00:00',
          updated_at: '2026-09-19 08:00:00',
        }),
        row({
          platform_conversation_id: CHAT,
          last_activity_at: '2026-09-19 12:00:00',
          updated_at: '2026-09-19 12:00:00',
        }),
      ],
      CHAT
    );
    expect(numbered.find(c => c.active)?.index).toBe(1);
  });

  test('accepts hydrated Date timestamps as well as raw strings', () => {
    const numbered = numberConversations(
      [
        row({ platform_conversation_id: CHAT, last_activity_at: new Date(NOW - 60_000) }),
        row({ platform_conversation_id: `${CHAT}:2`, last_activity_at: new Date(NOW) }),
      ],
      CHAT
    );
    expect(numbered.find(c => c.active)?.index).toBe(2);
  });

  test('ignores rows of a different chat, including a longer id with the same prefix', () => {
    const numbered = numberConversations(
      [
        row({ platform_conversation_id: CHAT }),
        row({ platform_conversation_id: `${CHAT}0:2` }),
        row({ platform_conversation_id: 'web-1789838461700-mkhqnq' }),
      ],
      CHAT
    );
    expect(numbered).toHaveLength(1);
  });
});

describe('activeConversationId', () => {
  test('a chat with no rows starts at the bare, legacy-shaped id', () => {
    expect(activeConversationId([], CHAT)).toBe(CHAT);
  });

  test('otherwise it is the most recently active row', () => {
    const rows = [
      row({ platform_conversation_id: CHAT, last_activity_at: '2026-09-19 10:00:00' }),
      row({ platform_conversation_id: `${CHAT}:2`, last_activity_at: '2026-09-19 11:00:00' }),
    ];
    expect(activeConversationId(rows, CHAT)).toBe(`${CHAT}:2`);
  });
});

describe('nextConversationId', () => {
  test('first /new in a chat that only has the legacy row is 2', () => {
    expect(nextConversationId([row({ platform_conversation_id: CHAT })], CHAT)).toBe(`${CHAT}:2`);
  });

  test('continues past the highest number in use, not the row count', () => {
    const rows = [
      row({ platform_conversation_id: CHAT }),
      row({ platform_conversation_id: `${CHAT}:5` }),
    ];
    expect(nextConversationId(rows, CHAT)).toBe(`${CHAT}:6`);
  });

  test('an empty chat starts at the bare id', () => {
    expect(nextConversationId([], CHAT)).toBe(CHAT);
  });
});

describe('formatAgo', () => {
  test('phone-sized relative times', () => {
    expect(formatAgo(null, NOW)).toBe('never used');
    expect(formatAgo('2026-09-19 11:59:30', NOW)).toBe('just now');
    expect(formatAgo('2026-09-19 11:45:00', NOW)).toBe('15m ago');
    expect(formatAgo('2026-09-19 09:00:00', NOW)).toBe('3h ago');
    expect(formatAgo('2026-09-17 12:00:00', NOW)).toBe('2d ago');
  });
});

describe('formatChatList', () => {
  test('numbers the rows, marks the active one and names the untitled', () => {
    const list = formatChatList(
      numberConversations(
        [
          row({
            platform_conversation_id: CHAT,
            title: 'Deploy checklist',
            last_activity_at: '2026-09-19 11:00:00',
          }),
          row({ platform_conversation_id: `${CHAT}:2`, last_activity_at: '2026-09-19 11:59:00' }),
        ],
        CHAT
      ),
      NOW
    );
    expect(list).toContain('1. Deploy checklist — 1h ago');
    expect(list).toContain('2. untitled — 1m ago ← active');
    expect(list).toContain('/switch <n>');
  });

  test('says so when the chat has nothing yet', () => {
    expect(formatChatList([], NOW)).toContain('No chats yet');
  });
});

// A fake store: no database, records what the commands asked it to do.
function fakeStore(initial: TelegramChatRow[]): TelegramChatStore & {
  created: string[];
  touched: string[];
  floors: (number | undefined)[];
  rows: TelegramChatRow[];
} {
  const state = {
    rows: [...initial],
    created: [] as string[],
    touched: [] as string[],
    floors: [] as (number | undefined)[],
    list: async (): Promise<readonly TelegramChatRow[]> => state.rows,
    create: async (id: string): Promise<void> => {
      state.created.push(id);
      if (!state.rows.some(r => r.platform_conversation_id === id)) {
        state.rows.push(row({ platform_conversation_id: id }));
      }
    },
    touch: async (id: string, notBeforeMs?: number): Promise<void> => {
      state.touched.push(id);
      state.floors.push(notBeforeMs);
      state.rows = state.rows.map(r =>
        r.platform_conversation_id === id
          ? { ...r, last_activity_at: '2026-09-19 12:00:00', updated_at: '2026-09-19 12:00:00' }
          : r
      );
    },
    listProjects: async (): Promise<readonly { name: string; default_cwd: string | null }[]> => [
      { name: 'chesswin', default_cwd: '/srv/chesswin' },
      { name: 'notes', default_cwd: null },
    ],
  };
  return state;
}

describe('isTelegramChatCommand', () => {
  test('claims only the chat-management commands', () => {
    expect(isTelegramChatCommand('new')).toBe(true);
    expect(isTelegramChatCommand('chats')).toBe(true);
    expect(isTelegramChatCommand('switch')).toBe(true);
    expect(isTelegramChatCommand('projects')).toBe(true);
    expect(isTelegramChatCommand('status')).toBe(false);
    expect(isTelegramChatCommand('workflow')).toBe(false);
  });
});

describe('handleTelegramChatCommand', () => {
  test('/new creates the next conversation eagerly and confirms it', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT, title: 'First' })]);
    const reply = await handleTelegramChatCommand({
      command: 'new',
      args: [],
      chatId: CHAT,
      store,
      now: NOW,
    });
    expect(store.created).toEqual([`${CHAT}:2`]);
    expect(store.touched).toEqual([`${CHAT}:2`]);
    expect(reply).toContain('Chat 2 created');
    // And it is now the one a message would land in.
    expect(activeConversationId(store.rows, CHAT)).toBe(`${CHAT}:2`);
  });

  test('/chats lists what exists, with the active one marked', async () => {
    const store = fakeStore([
      row({
        platform_conversation_id: CHAT,
        title: 'First',
        last_activity_at: '2026-09-19 11:00:00',
      }),
      row({
        platform_conversation_id: `${CHAT}:2`,
        title: 'Second',
        last_activity_at: '2026-09-19 11:59:00',
      }),
    ]);
    const reply = await handleTelegramChatCommand({
      command: 'chats',
      args: [],
      chatId: CHAT,
      store,
      now: NOW,
    });
    expect(reply).toContain('1. First — 1h ago');
    expect(reply).toContain('2. Second — 1m ago ← active');
    expect(store.touched).toEqual([]); // listing changes nothing
  });

  test('/switch touches the target — that is what makes it active', async () => {
    const store = fakeStore([
      row({
        platform_conversation_id: CHAT,
        title: 'First',
        last_activity_at: '2026-09-19 11:00:00',
      }),
      row({
        platform_conversation_id: `${CHAT}:2`,
        title: 'Second',
        last_activity_at: '2026-09-19 11:59:00',
      }),
    ]);
    const reply = await handleTelegramChatCommand({
      command: 'switch',
      args: ['1'],
      chatId: CHAT,
      store,
      now: NOW,
    });
    expect(store.touched).toEqual([CHAT]);
    expect(reply).toBe('Switched to chat 1: First.');
    expect(activeConversationId(store.rows, CHAT)).toBe(CHAT);
  });

  test('/switch to the current chat says so and touches nothing', async () => {
    const store = fakeStore([
      row({ platform_conversation_id: CHAT, last_activity_at: '2026-09-19 11:59:00' }),
    ]);
    const reply = await handleTelegramChatCommand({
      command: 'switch',
      args: ['1'],
      chatId: CHAT,
      store,
      now: NOW,
    });
    expect(reply).toContain('Already on chat 1');
    expect(store.touched).toEqual([]);
  });

  test('/switch to a number that does not exist says which do', async () => {
    const store = fakeStore([
      row({ platform_conversation_id: CHAT }),
      row({ platform_conversation_id: `${CHAT}:2` }),
    ]);
    const reply = await handleTelegramChatCommand({
      command: 'switch',
      args: ['7'],
      chatId: CHAT,
      store,
      now: NOW,
    });
    expect(reply).toBe('No chat 7. Existing: 1, 2.');
    expect(store.touched).toEqual([]);
  });

  test('/switch with no number shows the usage and the list', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT, title: 'First' })]);
    const reply = await handleTelegramChatCommand({
      command: 'switch',
      args: [],
      chatId: CHAT,
      store,
      now: NOW,
    });
    expect(reply).toContain('Usage: /switch <n>');
    expect(reply).toContain('1. First');
  });

  test('/projects lists the registered projects and how to bind one', async () => {
    const store = fakeStore([]);
    const reply = await handleTelegramChatCommand({
      command: 'projects',
      args: [],
      chatId: CHAT,
      store,
      now: NOW,
    });
    expect(reply).toContain('chesswin — /srv/chesswin');
    expect(reply).toContain('notes');
    expect(reply).toContain('/setproject <name>');
  });

  test('/projects with none registered points at /register-project', async () => {
    const store = fakeStore([]);
    store.listProjects = async () => [];
    const reply = await handleTelegramChatCommand({
      command: 'projects',
      args: [],
      chatId: CHAT,
      store,
      now: NOW,
    });
    expect(reply).toContain('No projects registered');
    expect(reply).toContain('/register-project');
  });
});

describe('a switch must not tie with the turn before it', () => {
  test('/switch tells the store to land strictly after the newest sibling', async () => {
    const store = fakeStore([
      row({
        platform_conversation_id: CHAT,
        title: 'First',
        last_activity_at: '2026-09-19 11:00:00',
      }),
      row({
        platform_conversation_id: `${CHAT}:2`,
        title: 'Second',
        last_activity_at: '2026-09-19 11:59:00',
      }),
    ]);

    await handleTelegramChatCommand({
      command: 'switch',
      args: ['1'],
      chatId: CHAT,
      store,
      now: NOW,
    });

    // The floor is the newest activity in the chat — the row being switched
    // away from — so a whole-second clock cannot produce a tie.
    expect(store.floors).toEqual([Date.parse('2026-09-19T11:59:00.000Z')]);
  });

  test('/new does the same for the conversation it creates', async () => {
    const store = fakeStore([
      row({ platform_conversation_id: CHAT, last_activity_at: '2026-09-19 11:59:00' }),
    ]);

    await handleTelegramChatCommand({
      command: 'new',
      args: [],
      chatId: CHAT,
      store,
      now: NOW,
    });

    expect(store.floors).toEqual([Date.parse('2026-09-19T11:59:00.000Z')]);
  });
});
