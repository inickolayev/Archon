/**
 * Buttons instead of commands.
 *
 * A phone is a bad place to remember a command set, so the day-to-day actions
 * are taps: a persistent keyboard under the input for the frequent ones, and
 * inline keyboards for the lists (which chat, which project). The text
 * commands all keep working — they are simply no longer the only way in, and
 * only `/start`, `/help` and `/menu` are advertised to Telegram.
 *
 * Everything here is data: labels, rows and `callback_data` strings. The
 * adapter turns them into Telegram markup, so this stays testable without a
 * bot.
 */

import {
  activeConversationId,
  isTelegramChatCommand,
  numberConversations,
  type NumberedConversation,
  type TelegramChatCommand,
  type TelegramChatStore,
} from './telegram-chats';

/** One inline button: what it says, and the opaque token it sends back. */
export interface MenuButton {
  readonly label: string;
  /** Goes into `callback_data` — at most 64 bytes, and untrusted on return. */
  readonly action: string;
}

/** Buttons attached to a message. Platforms that have none ignore this. */
export interface MenuKeyboard {
  /** Buttons under the message itself. */
  readonly inline?: readonly (readonly MenuButton[])[];
  /** Labels for the keyboard under the input field. */
  readonly persistent?: readonly (readonly string[])[];
}

/**
 * The persistent keyboard: the way in, and the way out.
 *
 * It used to carry LIST shortcuts too (Chats / New chat / Project / Status).
 * They were removed because a keyboard label is sent as an ordinary MESSAGE,
 * so each tap produced a fresh list underneath the last one — tap Chats five
 * times and there are five lists in the chat. Inline buttons edit the message
 * they are attached to, so the list the operator is looking at is the one that
 * changes. Telegram's own menu button cannot fire a command (only a command
 * list or a web app), which is why the keyboard, not that button, is what
 * makes the menu reachable at all.
 *
 * Stop is the exception that proves the rule, and it has to be here rather
 * than one tap deeper in the menu: it is wanted exactly when the operator is
 * watching the agent do the wrong thing, and it answers with one line instead
 * of a list, so tapping it twice costs nothing.
 */
export const MAIN_KEYBOARD: MenuKeyboard = {
  persistent: [['☰ Menu', '⏹ Stop']],
};

/**
 * Calling the agent off.
 *
 * Deliberately NOT one of the commands the orchestrator routes: by the time a
 * message reaches the orchestrator it has been through the conversation lock,
 * which is exactly where a stop would sit waiting for the turn it is meant to
 * interrupt. The surface that receives the update acts on it first and never
 * takes the lock — both the typed command and the button below.
 */
export const STOP_COMMAND = 'stop';

/**
 * True for the stop command however it was typed or tapped.
 *
 * Matched on the FIRST WORD, like every other command. An exact match read
 * `/stop и посмотри логи` as ordinary chat, so the stop silently did not
 * happen and the message queued behind the very turn it was meant to
 * interrupt — the opposite of what the operator asked for, with nothing said
 * about it. The words after the command are reported as ignored by the caller
 * (`command-trailing-text.ts`) rather than acted on: calling a turn off and
 * starting another in the same breath is not what "stop" means.
 */
export function isStopCommand(text: string): boolean {
  const normalized = (commandForLabel(text) ?? text).trim().toLowerCase();
  const [firstWord] = normalized.split(/\s/);
  return firstWord === `/${STOP_COMMAND}`;
}

/**
 * Labels the bot answers to. Wider than what MAIN_KEYBOARD shows on purpose: a
 * client that still has the older, larger keyboard cached must keep working
 * rather than sending the bot the word "Status" as a question for the agent.
 */
const LABEL_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['☰ Menu', '/menu'],
  ['Menu', '/menu'],
  ['⏹ Stop', `/${STOP_COMMAND}`],
  ['Stop', `/${STOP_COMMAND}`],
  ['Chats', '/chats'],
  ['New chat', '/new'],
  ['Project', '/projects'],
  ['Status', '/status'],
]);

/**
 * A tap on the persistent keyboard arrives as an ordinary text message, so the
 * label is translated back into the command it stands for. Anything else is
 * left alone — it is just what the operator typed.
 */
export function commandForLabel(text: string): string | null {
  return LABEL_COMMANDS.get(text.trim()) ?? null;
}

/** The only commands Telegram's own menu advertises. */
export const ADVERTISED_COMMANDS: readonly { command: string; description: string }[] = [
  { command: 'start', description: 'Show the buttons' },
  { command: 'help', description: 'What the buttons do' },
  { command: 'menu', description: 'Chats and projects' },
  { command: STOP_COMMAND, description: 'Call off what the agent is doing' },
];

// --- callback tokens --------------------------------------------------------
// `callback_data` is capped at 64 bytes by Telegram and is untrusted on the way
// back: it is whatever the client sends. Tokens are therefore short, parsed
// strictly, and carry NO chat or user id — the chat comes from the update and
// the sender is re-checked against the whitelist.

const MAX_CALLBACK_BYTES = 64;
const MAX_PROJECT_TOKEN = 48;

/** How many buttons one list page carries — a phone screen, not a desktop. */
export const PAGE_SIZE = 8;

export type CallbackAction =
  | { readonly kind: 'chats'; readonly page?: number }
  | { readonly kind: 'projects'; readonly page?: number }
  | { readonly kind: 'menu' }
  | { readonly kind: 'switch'; readonly index: number }
  | { readonly kind: 'new' }
  | { readonly kind: 'project'; readonly name: string }
  | { readonly kind: 'link' }
  | { readonly kind: 'stop' };

export function encodeAction(action: CallbackAction): string {
  switch (action.kind) {
    case 'chats':
      return action.page !== undefined && action.page > 1 ? `l:c:${String(action.page)}` : 'l:c';
    case 'projects':
      return action.page !== undefined && action.page > 1 ? `l:p:${String(action.page)}` : 'l:p';
    case 'menu':
      return 'm';
    case 'new':
      return 'n';
    case 'switch':
      return `s:${String(action.index)}`;
    case 'project':
      return `p:${action.name.slice(0, MAX_PROJECT_TOKEN)}`;
    case 'link':
      return 'lk';
    case 'stop':
      return 'x';
  }
}

/** Parse a `callback_data` string. Null for anything this build did not send. */
export function parseAction(data: string): CallbackAction | null {
  if (data.length === 0 || Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES) return null;
  const listMatch = /^l:([cp])(?::(\d{1,3}))?$/.exec(data);
  if (listMatch) {
    const page = listMatch[2] === undefined ? 1 : Number(listMatch[2]);
    if (page < 1) return null;
    return listMatch[1] === 'c' ? { kind: 'chats', page } : { kind: 'projects', page };
  }
  if (data === 'm') return { kind: 'menu' };
  if (data === 'n') return { kind: 'new' };
  if (data === 'lk') return { kind: 'link' };
  if (data === 'x') return { kind: 'stop' };
  const switchMatch = /^s:(\d{1,4})$/.exec(data);
  if (switchMatch) {
    const index = Number(switchMatch[1]);
    return index >= 1 ? { kind: 'switch', index } : null;
  }
  if (data.startsWith('p:')) {
    const name = data.slice(2).trim();
    // A project name is matched against the registered list later; it is never
    // used as a path or a query fragment on its own.
    return name.length > 0 ? { kind: 'project', name } : null;
  }
  return null;
}

// --- keyboards --------------------------------------------------------------

/** Total pages for a list of `total` items. At least one, so an empty list still renders. */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

/** Clamp a requested page into range — the number arrives from a button. */
export function clampPage(page: number | undefined, total: number): number {
  const pages = pageCount(total);
  if (page === undefined || !Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.trunc(page)), pages);
}

/** `‹ Prev · 2/5 · Next ›`, or nothing when everything fits on one page. */
function navRow(kind: 'chats' | 'projects', page: number, total: number): MenuButton[] {
  const pages = pageCount(total);
  if (pages <= 1) return [];
  const row: MenuButton[] = [];
  if (page > 1) {
    row.push({ label: '‹ Prev', action: encodeAction({ kind, page: page - 1 }) });
  }
  row.push({
    label: `${String(page)}/${String(pages)}`,
    action: encodeAction({ kind, page }),
  });
  if (page < pages) {
    row.push({ label: 'Next ›', action: encodeAction({ kind, page: page + 1 }) });
  }
  return row;
}

/**
 * One button per chat (the active one marked), then "new chat". Long lists are
 * paginated: Telegram caps how many buttons a message may carry, and a phone
 * screen caps it lower.
 */
export function buildChatsKeyboard(
  conversations: readonly NumberedConversation[],
  page = 1
): MenuKeyboard {
  const current = clampPage(page, conversations.length);
  const start = (current - 1) * PAGE_SIZE;
  const rows = conversations.slice(start, start + PAGE_SIZE).map(conversation => [
    {
      label: `${conversation.active ? '● ' : ''}${String(conversation.index)}. ${
        conversation.title?.trim() ?? ''
      }`.trim(),
      action: encodeAction({ kind: 'switch', index: conversation.index }),
    },
  ]);
  const nav = navRow('chats', current, conversations.length);
  return {
    inline: [
      ...rows,
      ...(nav.length > 0 ? [nav] : []),
      [{ label: '+ New chat', action: encodeAction({ kind: 'new' }) }, MENU_BUTTON],
    ],
  };
}

/** One button per registered project, the bound one marked, paginated the same way. */
export function buildProjectsKeyboard(
  projects: readonly { name: string }[],
  activeName?: string | null,
  page = 1
): MenuKeyboard {
  const current = clampPage(page, projects.length);
  const start = (current - 1) * PAGE_SIZE;
  const rows = projects.slice(start, start + PAGE_SIZE).map(project => [
    {
      label: `${project.name === activeName ? '● ' : ''}${project.name}`,
      action: encodeAction({ kind: 'project', name: project.name }),
    },
  ]);
  const nav = navRow('projects', current, projects.length);
  return { inline: [...rows, ...(nav.length > 0 ? [nav] : []), [MENU_BUTTON]] };
}

/** The page a 1-based position falls on. */
export function pageOf(index: number): number {
  return Math.max(1, Math.ceil(index / PAGE_SIZE));
}

/**
 * Back to the menu, as an inline button.
 *
 * Every list carries one. In Telegram Web the reply keyboard is folded behind
 * an icon next to the input, so `☰ Menu` down there is two taps, not one; an
 * inline button on the message the operator is already looking at is one tap
 * in every client.
 */
const MENU_BUTTON: MenuButton = { label: '☰ Menu', action: 'm' };

/** The menu shown by /menu and by the Menu button. */
export function buildMainMenu(): { text: string; keyboard: MenuKeyboard } {
  return {
    text: 'What would you like to do?',
    keyboard: {
      inline: [
        [
          { label: 'Chats', action: encodeAction({ kind: 'chats' }) },
          { label: 'Projects', action: encodeAction({ kind: 'projects' }) },
        ],
        [{ label: '+ New chat', action: encodeAction({ kind: 'new' }) }],
        [{ label: '⏹ Stop the agent', action: encodeAction({ kind: 'stop' }) }],
        [{ label: 'Link this chat to my account', action: encodeAction({ kind: 'link' }) }],
      ],
      persistent: MAIN_KEYBOARD.persistent,
    },
  };
}

/** Label of a chat button, used in confirmations. */
function titleOf(conversation: NumberedConversation | undefined): string {
  const title = conversation?.title?.trim() ?? '';
  return title.length > 0 ? title : 'untitled';
}

// --- handling a tap ---------------------------------------------------------

export interface TelegramCallbackInput {
  /** Raw `callback_data` — untrusted. */
  readonly data: string;
  /** The chat the tap came from, taken from the update, never from the data. */
  readonly chatId: string;
  readonly store: TelegramChatStore;
  /** Binds the chat's active conversation to a project; returns what to show. */
  readonly bindProject?: (projectName: string) => Promise<string>;
  /**
   * Issues the one-time link that connects this Telegram sender to a web
   * account, and returns what to show. Injected because the token lives in the
   * server, and because a build without it should simply not offer the button.
   */
  readonly issueAccountLink?: () => Promise<string>;
  /**
   * Calls off whatever this chat's active conversation is doing and returns
   * what to show. Injected like the two above: the registry of running turns
   * lives with the process that started them, not with this keyboard.
   */
  readonly stopTurn?: () => Promise<string>;
  readonly now?: number;
}

export interface TelegramCallbackReply {
  /** New text for the message the button belongs to — edited in place. */
  readonly text: string;
  readonly keyboard?: MenuKeyboard;
  /** Short confirmation shown on the button itself. */
  readonly toast?: string;
}

/**
 * Act on a tap and describe what the message should become. The caller edits
 * the existing message rather than sending another one: a phone screen fills
 * up fast, and the list the operator is looking at is the one that should
 * change.
 */
export async function handleTelegramCallback(
  input: TelegramCallbackInput
): Promise<TelegramCallbackReply | null> {
  const action = parseAction(input.data);
  if (action === null) return null;
  const { chatId, store } = input;

  if (action.kind === 'menu') {
    const menu = buildMainMenu();
    return { text: menu.text, keyboard: menu.keyboard };
  }

  if (action.kind === 'stop') {
    if (input.stopTurn === undefined) {
      return { text: 'Stopping is not available on this install.' };
    }
    // The menu stays put under the answer: after a stop the next thing the
    // operator usually wants is another chat or another project, and a stop
    // that swallowed the menu would cost them a tap to get it back.
    const menu = buildMainMenu();
    return { text: await input.stopTurn(), keyboard: menu.keyboard, toast: 'Stopped' };
  }

  if (action.kind === 'link') {
    if (input.issueAccountLink === undefined) {
      return { text: 'Account linking is not available on this install.' };
    }
    // The link itself is issued by the server — this only asks for it and
    // shows it. Nothing about the account is decided here.
    const text = await input.issueAccountLink();
    return { text, toast: 'Link ready' };
  }

  if (action.kind === 'projects' || action.kind === 'project') {
    const projects = await store.listProjects();
    if (action.kind === 'projects') {
      return projects.length === 0
        ? { text: 'No projects registered.\n/register-project <name> <path> adds one.' }
        : {
            text: 'Pick a project for this chat:',
            keyboard: buildProjectsKeyboard(projects, null, action.page),
          };
    }
    // Only a project that is actually registered can be bound — the tapped
    // name is untrusted and may be stale.
    const match = projects.find(p => p.name === action.name);
    if (match === undefined) {
      return {
        text: 'That project is no longer registered.',
        keyboard: buildProjectsKeyboard(projects),
        toast: 'Not found',
      };
    }
    // Stay on the page the tapped project is on, so the list does not jump.
    const projectPage = pageOf(projects.findIndex(p => p.name === match.name) + 1);
    const outcome = input.bindProject
      ? await input.bindProject(match.name)
      : `Bound this chat to ${match.name}.`;
    return {
      text: outcome,
      keyboard: buildProjectsKeyboard(projects, match.name, projectPage),
      toast: match.name,
    };
  }

  // Everything below is about this chat's conversations.
  const rows = await store.list(chatId);
  const conversations = numberConversations(rows, chatId);

  if (action.kind === 'chats') {
    return {
      text: 'Chats in this Telegram chat:',
      keyboard: buildChatsKeyboard(conversations, action.page),
    };
  }

  if (action.kind === 'new') {
    const highest = conversations.reduce((max, c) => Math.max(max, c.index), 0);
    const next = highest + 1;
    const id = next <= 1 ? chatId : `${chatId}:${String(next)}`;
    const newest = conversations.reduce(
      (max, c) =>
        Math.max(max, c.lastActivityAt === null ? 0 : Date.parse(String(c.lastActivityAt))),
      0
    );
    // Inherits the project, the cwd and the owner from the chat's current
    // conversation — a new chat, not a new context.
    await store.create(id, activeConversationId(rows, chatId));
    await store.touch(id, Number.isNaN(newest) ? undefined : newest);
    const refreshed = numberConversations(await store.list(chatId), chatId);
    return {
      text: `Chat ${String(next)} created and active. Send a message to start it.`,
      keyboard: buildChatsKeyboard(refreshed, pageOf(next)),
      toast: `Chat ${String(next)}`,
    };
  }

  const target = conversations.find(c => c.index === action.index);
  if (target === undefined) {
    return {
      text: 'That chat is gone.',
      keyboard: buildChatsKeyboard(conversations),
      toast: 'Not found',
    };
  }
  if (!target.active) {
    const newest = conversations.reduce(
      (max, c) =>
        Math.max(max, c.lastActivityAt === null ? 0 : Date.parse(String(c.lastActivityAt))),
      0
    );
    await store.touch(target.id, Number.isNaN(newest) ? undefined : newest);
  }
  const refreshed = numberConversations(await store.list(chatId), chatId);
  return {
    text: `Now on chat ${String(target.index)}: ${titleOf(target)}. Anything you type goes here.`,
    keyboard: buildChatsKeyboard(refreshed, pageOf(target.index)),
    toast: `Chat ${String(target.index)}`,
  };
}

// --- commands, with the buttons attached ------------------------------------

/**
 * The visible command set. Everything else still works when typed — it is just
 * not advertised, and the operator reaches it by tapping.
 */
export const MENU_COMMANDS = ['start', 'menu'] as const;

export function isMenuCommand(command: string): boolean {
  return (MENU_COMMANDS as readonly string[]).includes(command);
}

export interface TelegramCommandReply {
  readonly text: string;
  readonly keyboard?: MenuKeyboard;
}

const GREETING = [
  'This is the Factory console in Telegram.',
  '',
  'Tap ☰ Menu under the input to switch chats, start a new one, pick a project',
  'or link this chat to your web account.',
  '',
  'Anything else you type goes to the agent. /help lists what the buttons do.',
].join('\n');

/**
 * Run one of the chat-management commands and attach the buttons that belong
 * with its answer. `/start` and `/menu` are handled here; the rest delegate to
 * the plain-text handlers and gain a keyboard.
 */
export async function handleTelegramMenuCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly chatId: string;
  readonly store: TelegramChatStore;
  readonly now?: number;
  readonly runChatCommand: (
    command: TelegramChatCommand,
    args: readonly string[]
  ) => Promise<string>;
}): Promise<TelegramCommandReply | null> {
  const { command, args, chatId, store } = input;

  if (command === 'start') {
    // Deliberately the PERSISTENT keyboard alone, with no inline buttons.
    // Telegram allows one reply_markup per message and an inline keyboard wins
    // when both are offered — so a /start that carried both would never
    // actually install the keyboard under the input, which is the one thing
    // /start exists to do. The menu itself is one tap away from it.
    return { text: GREETING, keyboard: MAIN_KEYBOARD };
  }
  if (command === 'menu') {
    const menu = buildMainMenu();
    return { text: menu.text, keyboard: menu.keyboard };
  }
  if (!isTelegramChatCommand(command)) return null;

  const text = await input.runChatCommand(command, args);

  if (command === 'projects') {
    const projects = await store.listProjects();
    return projects.length === 0
      ? { text, keyboard: MAIN_KEYBOARD }
      : {
          text,
          keyboard: { ...buildProjectsKeyboard(projects), persistent: MAIN_KEYBOARD.persistent },
        };
  }

  const conversations = numberConversations(await store.list(chatId), chatId);
  return {
    text,
    keyboard: { ...buildChatsKeyboard(conversations), persistent: MAIN_KEYBOARD.persistent },
  };
}
