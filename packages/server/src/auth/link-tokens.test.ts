import { describe, expect, test } from 'bun:test';
import { LinkTokenStore } from './link-tokens';

const claim = (
  over: Partial<{ platformUserId: string; displayName: string; chatId: string }> = {}
) => ({
  platformUserId: '4242',
  displayName: 'Ada',
  chatId: '4242',
  ...over,
});

describe('LinkTokenStore', () => {
  test('issues an unguessable token bound to the Telegram user', () => {
    const store = new LinkTokenStore();
    const issued = store.issue(claim());

    expect(issued.token.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    expect(issued.platformUserId).toBe('4242');
    expect(store.peek(issued.token)?.platformUserId).toBe('4242');
  });

  test('two tokens never collide', () => {
    const store = new LinkTokenStore();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(store.issue(claim({ platformUserId: String(i) })).token);
    }
    expect(seen.size).toBe(50);
  });

  test('a token is single-use', () => {
    const store = new LinkTokenStore();
    const { token } = store.issue(claim());

    expect(store.consume(token)?.platformUserId).toBe('4242');
    // Second attempt finds nothing — a forwarded link is already spent.
    expect(store.consume(token)).toBeNull();
    expect(store.peek(token)).toBeNull();
  });

  test('a token expires', () => {
    let now = 1_000_000;
    const store = new LinkTokenStore({ ttlMs: 60_000, now: () => now });
    const { token } = store.issue(claim());

    now += 59_000;
    expect(store.peek(token)).not.toBeNull();
    now += 2_000;
    expect(store.peek(token)).toBeNull();
    expect(store.consume(token)).toBeNull();
  });

  test('asking again invalidates the previous link for that Telegram user', () => {
    const store = new LinkTokenStore();
    const first = store.issue(claim());
    const second = store.issue(claim());

    expect(store.consume(first.token)).toBeNull();
    expect(store.consume(second.token)?.platformUserId).toBe('4242');
  });

  test('another Telegram user keeps their own token', () => {
    const store = new LinkTokenStore();
    const mine = store.issue(claim({ platformUserId: '111' }));
    const theirs = store.issue(claim({ platformUserId: '222' }));

    expect(store.consume(mine.token)?.platformUserId).toBe('111');
    expect(store.consume(theirs.token)?.platformUserId).toBe('222');
  });

  test('a token carries the Telegram user it may link — never one supplied later', () => {
    const store = new LinkTokenStore();
    const { token } = store.issue(claim({ platformUserId: '4242' }));
    const consumed = store.consume(token);
    // The caller links THIS id; nothing in the request can change it.
    expect(consumed?.platformUserId).toBe('4242');
  });

  test('garbage is refused without throwing', () => {
    const store = new LinkTokenStore();
    store.issue(claim());
    expect(store.peek('')).toBeNull();
    expect(store.peek('not-a-token')).toBeNull();
    expect(store.consume('../../etc/passwd')).toBeNull();
  });

  test('signing out drops everything pending', () => {
    const store = new LinkTokenStore();
    const a = store.issue(claim({ platformUserId: '1' }));
    const b = store.issue(claim({ platformUserId: '2' }));

    store.clear();

    expect(store.size).toBe(0);
    expect(store.consume(a.token)).toBeNull();
    expect(store.consume(b.token)).toBeNull();
  });

  test('expired tokens do not pile up', () => {
    let now = 0;
    const store = new LinkTokenStore({ ttlMs: 10, now: () => now });
    store.issue(claim({ platformUserId: '1' }));
    store.issue(claim({ platformUserId: '2' }));
    now = 100;
    expect(store.size).toBe(0);
  });
});
