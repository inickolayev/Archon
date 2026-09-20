import { describe, expect, test } from 'bun:test';
import {
  ADVERTISED_COMMANDS,
  MAIN_KEYBOARD,
  PAGE_SIZE,
  clampPage,
  buildChatsKeyboard,
  buildMainMenu,
  buildProjectsKeyboard,
  commandForLabel,
  encodeAction,
  handleTelegramCallback,
  handleTelegramMenuCommand,
  isMenuCommand,
  isStopCommand,
  parseAction,
  STOP_COMMAND,
} from './telegram-menu';
import {
  numberConversations,
  type TelegramChatRow,
  type TelegramChatStore,
} from './telegram-chats';

const CHAT = '123456789';

const row = (
  over: Partial<TelegramChatRow> & { platform_conversation_id: string }
): TelegramChatRow => ({ title: null, last_activity_at: null, ...over });

function fakeStore(initial: TelegramChatRow[]): TelegramChatStore & {
  touched: string[];
  created: string[];
  /** What each created conversation was told to inherit from. */
  inherited: (string | undefined)[];
  rows: TelegramChatRow[];
} {
  const state = {
    rows: [...initial],
    touched: [] as string[],
    created: [] as string[],
    inherited: [] as (string | undefined)[],
    list: async (): Promise<readonly TelegramChatRow[]> => state.rows,
    create: async (id: string, inheritFrom?: string): Promise<void> => {
      state.created.push(id);
      state.inherited.push(inheritFrom);
      if (!state.rows.some(r => r.platform_conversation_id === id)) {
        state.rows.push(row({ platform_conversation_id: id }));
      }
    },
    touch: async (id: string): Promise<void> => {
      state.touched.push(id);
      state.rows = state.rows.map(r =>
        r.platform_conversation_id === id
          ? { ...r, last_activity_at: '2026-09-20 12:00:00', updated_at: '2026-09-20 12:00:00' }
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

describe('advertised commands', () => {
  test('only the few worth typing are published to Telegram', () => {
    expect(ADVERTISED_COMMANDS.map(c => c.command)).toEqual(['start', 'help', 'menu', 'stop']);
  });

  test('start and menu are handled as menu commands', () => {
    expect(isMenuCommand('start')).toBe(true);
    expect(isMenuCommand('menu')).toBe(true);
    expect(isMenuCommand('workflow')).toBe(false);
  });

  test('stop is NOT a menu command — it must never reach the orchestrator', () => {
    // Everything the orchestrator routes has already passed the conversation
    // lock, which is where a stop would sit waiting for the turn it means to
    // interrupt. The surface that receives the update acts on it instead.
    expect(isMenuCommand(STOP_COMMAND)).toBe(false);
  });
});

describe('persistent keyboard labels', () => {
  test('a tapped label becomes the command it stands for', () => {
    expect(commandForLabel('⏹ Stop')).toBe('/stop');
    expect(commandForLabel('Chats')).toBe('/chats');
    expect(commandForLabel('New chat')).toBe('/new');
    expect(commandForLabel('Project')).toBe('/projects');
    expect(commandForLabel('Status')).toBe('/status');
    expect(commandForLabel(' Chats ')).toBe('/chats');
  });

  test('anything else is left alone — it is what the operator typed', () => {
    expect(commandForLabel('chats please')).toBeNull();
    expect(commandForLabel('deploy the thing')).toBeNull();
  });
});

describe('callback tokens', () => {
  test('round-trip', () => {
    for (const action of [
      { kind: 'chats', page: 1 },
      { kind: 'projects', page: 1 },
      { kind: 'menu' },
      { kind: 'new' },
      { kind: 'switch', index: 3 },
      { kind: 'project', name: 'chesswin' },
    ] as const) {
      expect(parseAction(encodeAction(action))).toEqual(action);
    }
  });

  test("every token fits Telegram's 64-byte cap", () => {
    const longest = encodeAction({ kind: 'project', name: 'x'.repeat(200) });
    expect(Buffer.byteLength(longest, 'utf8')).toBeLessThanOrEqual(64);
  });

  test('garbage, oversized and out-of-range data is refused', () => {
    expect(parseAction('')).toBeNull();
    expect(parseAction('drop table users')).toBeNull();
    expect(parseAction('s:0')).toBeNull();
    expect(parseAction('s:abc')).toBeNull();
    expect(parseAction('s:99999')).toBeNull();
    expect(parseAction('p:')).toBeNull();
    expect(parseAction(`p:${'x'.repeat(200)}`)).toBeNull();
  });

  test('carries no chat or user id — those come from the update itself', () => {
    const tokens = [
      encodeAction({ kind: 'switch', index: 2 }),
      encodeAction({ kind: 'project', name: 'chesswin' }),
      encodeAction({ kind: 'new' }),
    ];
    for (const token of tokens) expect(token).not.toContain(CHAT);
  });
});

describe('keyboards', () => {
  const conversations = numberConversations(
    [
      row({
        platform_conversation_id: CHAT,
        title: 'Deploy checklist',
        last_activity_at: '2026-09-20 10:00:00',
      }),
      row({
        platform_conversation_id: `${CHAT}:2`,
        title: 'Bot calibration',
        last_activity_at: '2026-09-20 11:00:00',
      }),
    ],
    CHAT
  );

  test('one button per chat, the active one marked, then new chat', () => {
    const keyboard = buildChatsKeyboard(conversations);
    const labels = keyboard.inline?.flat().map(b => b.label) ?? [];
    expect(labels).toEqual([
      '1. Deploy checklist',
      '● 2. Bot calibration',
      '+ New chat',
      // Every list carries a way back: in clients that fold the reply keyboard
      // behind an icon, this is the only one-tap route to the menu.
      '☰ Menu',
    ]);
    expect(keyboard.inline?.flat().map(b => b.action)).toEqual(['s:1', 's:2', 'n', 'm']);
  });

  test('one button per project, the bound one marked', () => {
    const keyboard = buildProjectsKeyboard([{ name: 'chesswin' }, { name: 'notes' }], 'notes');
    expect(keyboard.inline?.flat().map(b => b.label)).toEqual(['chesswin', '● notes', '☰ Menu']);
  });

  test('the main menu offers both lists and keeps the persistent keyboard', () => {
    const menu = buildMainMenu();
    expect(menu.keyboard.inline?.flat().map(b => b.action)).toEqual(['l:c', 'l:p', 'n', 'x', 'lk']);
    expect(menu.keyboard.persistent?.flat()).toEqual(['☰ Menu', '⏹ Stop']);
  });

  test('the persistent keyboard carries no LIST — those would pile up messages', () => {
    // A keyboard label is sent as a MESSAGE: each tap of a list label added a
    // new list under the last one. Inline buttons edit the message they belong
    // to, so every list lives inline. What stays here is the one entry point
    // and the one action that is wanted mid-turn and answers in a single line.
    expect(MAIN_KEYBOARD.persistent).toEqual([['☰ Menu', '⏹ Stop']]);
  });

  test('a client still showing the older keyboard keeps working', () => {
    // Its labels must not fall through to the agent as questions.
    for (const label of ['Chats', 'New chat', 'Project', 'Status']) {
      expect(commandForLabel(label)).not.toBeNull();
    }
  });
});

describe('handleTelegramCallback', () => {
  test('tapping a chat switches to it and returns the refreshed list', async () => {
    const store = fakeStore([
      row({
        platform_conversation_id: CHAT,
        title: 'First',
        last_activity_at: '2026-09-20 10:00:00',
      }),
      row({
        platform_conversation_id: `${CHAT}:2`,
        title: 'Second',
        last_activity_at: '2026-09-20 11:00:00',
      }),
    ]);

    const reply = await handleTelegramCallback({ data: 's:1', chatId: CHAT, store });

    expect(store.touched).toEqual([CHAT]);
    expect(reply?.text).toContain('Now on chat 1: First.');
    // The edited message carries the list again, with the marker moved.
    expect(reply?.keyboard?.inline?.flat().map(b => b.label)).toEqual([
      '● 1. First',
      '2. Second',
      '+ New chat',
      '☰ Menu',
    ]);
    expect(reply?.toast).toBe('Chat 1');
  });

  test('tapping the chat you are already in changes nothing', async () => {
    const store = fakeStore([
      row({
        platform_conversation_id: CHAT,
        title: 'Only',
        last_activity_at: '2026-09-20 11:00:00',
      }),
    ]);
    const reply = await handleTelegramCallback({ data: 's:1', chatId: CHAT, store });
    expect(store.touched).toEqual([]);
    expect(reply?.text).toContain('Now on chat 1');
  });

  test('new chat creates the next one and shows it as active', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT, title: 'First' })]);

    const reply = await handleTelegramCallback({ data: 'n', chatId: CHAT, store });

    expect(store.created).toEqual([`${CHAT}:2`]);
    expect(reply?.text).toContain('Chat 2 created and active');
    expect(reply?.keyboard?.inline?.flat().map(b => b.label)).toContain('● 2.');
  });

  test('a chat that no longer exists says so instead of failing', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT })]);
    const reply = await handleTelegramCallback({ data: 's:7', chatId: CHAT, store });
    expect(reply?.text).toBe('That chat is gone.');
    expect(store.touched).toEqual([]);
  });

  test('tapping a project binds it through the injected binder', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT })]);
    const bound: string[] = [];

    const reply = await handleTelegramCallback({
      data: 'p:chesswin',
      chatId: CHAT,
      store,
      bindProject: async name => {
        bound.push(name);
        return `Bound to ${name}.`;
      },
    });

    expect(bound).toEqual(['chesswin']);
    expect(reply?.text).toBe('Bound to chesswin.');
    expect(reply?.keyboard?.inline?.flat().map(b => b.label)).toContain('● chesswin');
  });

  test('a project name that is not registered is refused, binder untouched', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT })]);
    let called = false;

    const reply = await handleTelegramCallback({
      data: 'p:../../etc/passwd',
      chatId: CHAT,
      store,
      bindProject: async () => {
        called = true;
        return 'should not happen';
      },
    });

    expect(called).toBe(false);
    expect(reply?.text).toBe('That project is no longer registered.');
  });

  test('an unknown token is null — the caller tells the operator, changes nothing', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT })]);
    expect(await handleTelegramCallback({ data: 'nonsense', chatId: CHAT, store })).toBeNull();
    expect(store.touched).toEqual([]);
  });
});

describe('handleTelegramMenuCommand', () => {
  const runChatCommand = async (): Promise<string> => 'list text';

  test('/start greets and shows the buttons', async () => {
    const store = fakeStore([]);
    const reply = await handleTelegramMenuCommand({
      command: 'start',
      args: [],
      chatId: CHAT,
      store,
      runChatCommand,
    });
    expect(reply?.text).toContain('Factory console');
    // Only the persistent keyboard: Telegram allows one markup per message and
    // an inline keyboard would win, so a /start carrying both would never
    // install the keyboard it exists to install.
    expect(reply?.keyboard?.persistent?.flat()).toEqual(['☰ Menu', '⏹ Stop']);
    expect(reply?.keyboard?.inline).toBeUndefined();
  });

  test('/chats keeps its text and gains the chat buttons', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT, title: 'First' })]);
    const reply = await handleTelegramMenuCommand({
      command: 'chats',
      args: [],
      chatId: CHAT,
      store,
      runChatCommand,
    });
    expect(reply?.text).toBe('list text');
    expect(reply?.keyboard?.inline?.flat().map(b => b.action)).toEqual(['s:1', 'n', 'm']);
  });

  test('/projects gains a button per project', async () => {
    const store = fakeStore([]);
    const reply = await handleTelegramMenuCommand({
      command: 'projects',
      args: [],
      chatId: CHAT,
      store,
      runChatCommand,
    });
    expect(reply?.keyboard?.inline?.flat().map(b => b.label)).toEqual([
      'chesswin',
      'notes',
      '☰ Menu',
    ]);
  });

  test('a command this module does not own is left to the others', async () => {
    const store = fakeStore([]);
    expect(
      await handleTelegramMenuCommand({
        command: 'workflow',
        args: [],
        chatId: CHAT,
        store,
        runChatCommand,
      })
    ).toBeNull();
  });
});

describe('long lists', () => {
  const manyChats = numberConversations(
    Array.from({ length: 20 }, (_, i) =>
      row({
        platform_conversation_id: i === 0 ? CHAT : `${CHAT}:${String(i + 1)}`,
        title: `Chat ${String(i + 1)}`,
        last_activity_at: `2026-09-20 10:${String(i).padStart(2, '0')}:00`,
      })
    ),
    CHAT
  );

  test('a page holds at most PAGE_SIZE chats plus navigation and new chat', () => {
    const keyboard = buildChatsKeyboard(manyChats, 1);
    const rows = keyboard.inline ?? [];
    // 8 chats + a nav row + the new-chat row
    expect(rows).toHaveLength(PAGE_SIZE + 2);
    expect(
      rows
        .slice(0, PAGE_SIZE)
        .flat()
        .map(b => b.label)[0]
    ).toContain('1. Chat 1');
  });

  test('the first page has no Prev, the last has no Next', () => {
    const first =
      buildChatsKeyboard(manyChats, 1)
        .inline?.flat()
        .map(b => b.label) ?? [];
    expect(first).not.toContain('‹ Prev');
    expect(first).toContain('Next ›');

    const last =
      buildChatsKeyboard(manyChats, 3)
        .inline?.flat()
        .map(b => b.label) ?? [];
    expect(last).toContain('‹ Prev');
    expect(last).not.toContain('Next ›');
    expect(last).toContain('3/3');
  });

  test('a page number out of range is clamped, never an empty screen', () => {
    expect(clampPage(0, 20)).toBe(1);
    expect(clampPage(99, 20)).toBe(3);
    expect(clampPage(undefined, 20)).toBe(1);
    const beyond =
      buildChatsKeyboard(manyChats, 99)
        .inline?.flat()
        .map(b => b.label) ?? [];
    expect(beyond).toContain('3/3');
  });

  test('page tokens stay short and parse back', () => {
    const token = encodeAction({ kind: 'chats', page: 3 });
    expect(Buffer.byteLength(token, 'utf8')).toBeLessThanOrEqual(64);
    expect(parseAction(token)).toEqual({ kind: 'chats', page: 3 });
    expect(parseAction('l:c:0')).toBeNull();
    expect(parseAction('l:c:abc')).toBeNull();
    expect(parseAction('l:x:2')).toBeNull();
  });

  test('projects paginate the same way', () => {
    const projects = Array.from({ length: 11 }, (_, i) => ({ name: `project-${String(i + 1)}` }));
    const page2 =
      buildProjectsKeyboard(projects, null, 2)
        .inline?.flat()
        .map(b => b.label) ?? [];
    expect(page2).toContain('project-9');
    expect(page2).toContain('‹ Prev');
    expect(page2).toContain('2/2');
  });

  test('tapping Next asks for the next page of the same list', async () => {
    const store = fakeStore(
      Array.from({ length: 20 }, (_, i) =>
        row({
          platform_conversation_id: i === 0 ? CHAT : `${CHAT}:${String(i + 1)}`,
          title: `Chat ${String(i + 1)}`,
          last_activity_at: `2026-09-20 10:${String(i).padStart(2, '0')}:00`,
        })
      )
    );
    const reply = await handleTelegramCallback({ data: 'l:c:2', chatId: CHAT, store });
    const labels = reply?.keyboard?.inline?.flat().map(b => b.label) ?? [];
    expect(labels).toContain('2/3');
    expect(labels.some(l => l.includes('9. Chat 9'))).toBe(true);
  });

  test('switching keeps the operator on the page the chat is on', async () => {
    const store = fakeStore(
      Array.from({ length: 20 }, (_, i) =>
        row({
          platform_conversation_id: i === 0 ? CHAT : `${CHAT}:${String(i + 1)}`,
          title: `Chat ${String(i + 1)}`,
          last_activity_at: `2026-09-20 10:${String(i).padStart(2, '0')}:00`,
        })
      )
    );
    const reply = await handleTelegramCallback({ data: 's:17', chatId: CHAT, store });
    const labels = reply?.keyboard?.inline?.flat().map(b => b.label) ?? [];
    expect(labels).toContain('3/3');
    expect(reply?.text).toContain('Now on chat 17');
  });
});

describe('the menu is one tap away', () => {
  test('the persistent keyboard always carries a menu entry', () => {
    expect(MAIN_KEYBOARD.persistent?.[0]).toContain('☰ Menu');
  });

  test('tapping it is understood as /menu', () => {
    expect(commandForLabel('☰ Menu')).toBe('/menu');
    expect(commandForLabel('Menu')).toBe('/menu');
  });

  test('/menu answers with everything reachable, no ids to type', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT, title: 'First' })]);
    const reply = await handleTelegramMenuCommand({
      command: 'menu',
      args: [],
      chatId: CHAT,
      store,
      runChatCommand: async () => 'unused',
    });
    expect(reply?.keyboard?.inline?.flat().map(b => b.label)).toEqual([
      'Chats',
      'Projects',
      '+ New chat',
      '⏹ Stop the agent',
      'Link this chat to my account',
    ]);
    expect(reply?.keyboard?.persistent?.flat()).toContain('☰ Menu');
  });
});

describe('linking this chat to a web account', () => {
  test('the menu offers it as a button, not a command to remember', () => {
    const labels =
      buildMainMenu()
        .keyboard.inline?.flat()
        .map(b => b.label) ?? [];
    expect(labels).toContain('Link this chat to my account');
  });

  test('tapping it asks the server for a one-time link and shows it', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT })]);
    let asked = 0;
    const reply = await handleTelegramCallback({
      data: 'lk',
      chatId: CHAT,
      store,
      issueAccountLink: async () => {
        asked += 1;
        return 'Open this once while signed in: http://127.0.0.1:3090/console/link/TOKEN';
      },
    });

    expect(asked).toBe(1);
    expect(reply?.text).toContain('/console/link/');
    expect(reply?.toast).toBe('Link ready');
  });

  test('a build without linking says so instead of failing', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT })]);
    const reply = await handleTelegramCallback({ data: 'lk', chatId: CHAT, store });
    expect(reply?.text).toContain('not available');
  });

  test('the token is never part of the callback payload', () => {
    // The button asks for a link; it does not carry one. A callback payload is
    // client-supplied on the way back and must not be able to name a secret.
    expect(encodeAction({ kind: 'link' })).toBe('lk');
    expect(parseAction('lk')).toEqual({ kind: 'link' });
    expect(parseAction('lk:some-token')).toBeNull();
  });
});

describe('calling the agent off', () => {
  test('stop is on the persistent keyboard, within reach of a running turn', () => {
    expect(MAIN_KEYBOARD.persistent?.flat()).toContain('⏹ Stop');
  });

  test('the menu carries it too, for clients showing an inline keyboard', () => {
    const labels =
      buildMainMenu()
        .keyboard.inline?.flat()
        .map(b => b.label) ?? [];
    expect(labels).toContain('⏹ Stop the agent');
  });

  test('typed, tapped or labelled, it is recognised as the same gesture', () => {
    expect(isStopCommand('/stop')).toBe(true);
    expect(isStopCommand(' /STOP ')).toBe(true);
    expect(isStopCommand('⏹ Stop')).toBe(true);
    expect(isStopCommand('stop doing that')).toBe(false);
    expect(isStopCommand('/status')).toBe(false);
    // Words after the command no longer hide the stop — it queued behind the
    // very turn it was meant to interrupt (the tail is reported, not run).
    expect(isStopCommand('/stop и посмотри логи')).toBe(true);
    expect(isStopCommand('/stopwatch')).toBe(false);
  });

  test('tapping it calls the injected stop and keeps the menu on screen', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT })]);
    let asked = 0;
    const reply = await handleTelegramCallback({
      data: encodeAction({ kind: 'stop' }),
      chatId: CHAT,
      store,
      stopTurn: async () => {
        asked += 1;
        return 'Stopping the agent — it will say so in the chat.';
      },
    });

    expect(asked).toBe(1);
    expect(reply?.text).toContain('Stopping the agent');
    expect(reply?.toast).toBe('Stopped');
    // The next thing wanted after a stop is usually another chat or project.
    expect(reply?.keyboard?.inline?.flat().map(b => b.label)).toContain('Chats');
  });

  test('a build without stopping says so instead of failing', async () => {
    const store = fakeStore([row({ platform_conversation_id: CHAT })]);
    const reply = await handleTelegramCallback({ data: 'x', chatId: CHAT, store });
    expect(reply?.text).toContain('not available');
  });

  test('the token carries no conversation id — the chat comes from the update', () => {
    expect(encodeAction({ kind: 'stop' })).toBe('x');
    expect(parseAction('x')).toEqual({ kind: 'stop' });
    expect(parseAction('x:99')).toBeNull();
  });
});

describe('a new chat is a new chat, not a new context', () => {
  test("the button starts it from the chat's current conversation", async () => {
    const store = fakeStore([
      row({
        platform_conversation_id: CHAT,
        title: 'First',
        last_activity_at: '2026-09-20 10:00:00',
      }),
      row({
        platform_conversation_id: `${CHAT}:2`,
        title: 'Second',
        last_activity_at: '2026-09-20 11:00:00',
      }),
    ]);

    await handleTelegramCallback({ data: 'n', chatId: CHAT, store });

    expect(store.created).toEqual([`${CHAT}:3`]);
    // The ACTIVE one (newest activity), not the first, not the newest number:
    // that is the conversation whose project and owner the operator means.
    expect(store.inherited).toEqual([`${CHAT}:2`]);
  });

  test('the very first chat of a Telegram chat has nothing to inherit', async () => {
    const store = fakeStore([]);
    await handleTelegramCallback({ data: 'n', chatId: CHAT, store });
    expect(store.created).toEqual([CHAT]);
    // Points at itself — there is no earlier conversation, and the DB layer
    // finds nothing to copy rather than inventing a parent.
    expect(store.inherited).toEqual([CHAT]);
  });
});
