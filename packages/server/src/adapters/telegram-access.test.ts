import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { telegramAccess, resetOfferHistory, consoleOrigin } from './telegram-access';

const LINKED = 4242;
const STRANGER = 777;

const isLinked = async (id: string): Promise<boolean> => id === String(LINKED);

const sender = (userId: number | undefined): Parameters<ReturnType<typeof telegramAccess>>[0] => ({
  userId,
  chatId: '1000',
  displayName: 'Ada Lovelace',
});

describe('who may drive the agent from Telegram', () => {
  const previousUrl = process.env.BETTER_AUTH_URL;

  beforeEach(() => {
    resetOfferHistory();
    process.env.BETTER_AUTH_URL = 'https://factory.example.com';
  });
  afterEach(() => {
    if (previousUrl === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previousUrl;
  });

  test('a linked sender is allowed, and is offered nothing', async () => {
    const decide = telegramAccess({ isLinked });
    expect(await decide(sender(LINKED))).toEqual({ allow: true });
  });

  test('a stranger is refused and handed a one-time link', async () => {
    const decide = telegramAccess({ isLinked });
    const decision = await decide(sender(STRANGER));

    expect(decision.allow).toBe(false);
    // The link points at the console the browser actually reaches, and carries
    // a token — not an invitation to guess a URL.
    expect(decision).toHaveProperty('reply');
    const reply = (decision as { reply: string }).reply;
    expect(reply).toContain('https://factory.example.com/console/link/');
    expect(reply).toContain('not connected to a Factory account');
  });

  test('the offer is made once per token lifetime, then silence', async () => {
    let clock = 0;
    const decide = telegramAccess({ isLinked, now: () => clock });

    const first = await decide(sender(STRANGER));
    expect(first).toHaveProperty('reply');

    // Writing again straight away gets nothing back: the bot is not an echo
    // anyone can make speak.
    clock += 60_000;
    const second = await decide(sender(STRANGER));
    expect(second).toEqual({ allow: false });

    // Once the previous link has expired, a fresh one is offered.
    clock += 10 * 60 * 1000;
    expect(await decide(sender(STRANGER))).toHaveProperty('reply');
  });

  test('an update with no sender is refused without an offer', async () => {
    const decide = telegramAccess({ isLinked });
    expect(await decide(sender(undefined))).toEqual({ allow: false });
  });

  test('a database that cannot answer refuses, and does not offer a link', async () => {
    const decide = telegramAccess({
      isLinked: async () => {
        throw new Error('connection refused');
      },
    });
    // Fail closed: an unanswerable question is not permission.
    expect(await decide(sender(LINKED))).toEqual({ allow: false });
  });

  test('without a public address the link points at the loopback console', () => {
    expect(consoleOrigin({ PORT: '3090' } as NodeJS.ProcessEnv)).toBe('http://127.0.0.1:3090');
    expect(consoleOrigin({ BETTER_AUTH_URL: 'https://x.test/' } as NodeJS.ProcessEnv)).toBe(
      'https://x.test'
    );
  });
});
