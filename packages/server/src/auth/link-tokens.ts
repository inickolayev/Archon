/**
 * One-time links that bind a Telegram sender to a web account.
 *
 * The bot cannot know who is signed in to the console, and the console cannot
 * know who is holding the phone. The link is the handshake: the bot issues a
 * token for the Telegram user in front of it, the operator opens it in a
 * browser that already has a session, sees what is about to be linked, and
 * confirms.
 *
 * What makes a leaked link harmless:
 *  - it is unguessable (32 random bytes, base64url);
 *  - it expires in minutes;
 *  - it is single-use — consumed on confirmation and gone;
 *  - it is bound to the Telegram user it was issued for, so it can only ever
 *    link THAT account, never someone else's;
 *  - issuing a new one for the same Telegram user invalidates the previous one,
 *    so a link forwarded by mistake dies as soon as the operator asks again;
 *  - signing out drops every pending token.
 *
 * Deliberately in memory: the tokens live for minutes, a restart invalidating
 * them is the safe direction, and a table inside the pinned engine's schema is
 * a migration we would have to carry forever for a handshake.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface LinkTokenClaim {
  /** Telegram user id the token was issued for — the only account it can link. */
  readonly platformUserId: string;
  /** Name to show on the confirmation screen. */
  readonly displayName?: string;
  /** Telegram chat to confirm back into. */
  readonly chatId: string;
  readonly expiresAt: number;
}

interface StoredToken extends LinkTokenClaim {
  readonly token: string;
}

export class LinkTokenStore {
  readonly #byToken = new Map<string, StoredToken>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options?: { ttlMs?: number; now?: () => number }) {
    this.#ttlMs = options?.ttlMs ?? LINK_TOKEN_TTL_MS;
    this.#now = options?.now ?? Date.now;
  }

  /**
   * Issue a token for one Telegram user, replacing any token that user already
   * has: only the most recent link they asked for can be used.
   */
  issue(claim: { platformUserId: string; displayName?: string; chatId: string }): StoredToken {
    this.#sweep();
    for (const [token, stored] of this.#byToken) {
      if (stored.platformUserId === claim.platformUserId) this.#byToken.delete(token);
    }
    const token = randomBytes(32).toString('base64url');
    const entry: StoredToken = {
      token,
      platformUserId: claim.platformUserId,
      displayName: claim.displayName,
      chatId: claim.chatId,
      expiresAt: this.#now() + this.#ttlMs,
    };
    this.#byToken.set(token, entry);
    return entry;
  }

  /** Look at a token without spending it — what the confirmation screen shows. */
  peek(token: string): LinkTokenClaim | null {
    const stored = this.#find(token);
    if (stored === null) return null;
    return stored;
  }

  /** Spend a token. Returns null when it is unknown, expired or already used. */
  consume(token: string): LinkTokenClaim | null {
    const stored = this.#find(token);
    if (stored === null) return null;
    this.#byToken.delete(stored.token);
    return stored;
  }

  /** Drop everything pending — what signing out does. */
  clear(): void {
    this.#byToken.clear();
  }

  /** Pending count, for tests and diagnostics. */
  get size(): number {
    this.#sweep();
    return this.#byToken.size;
  }

  #find(token: string): StoredToken | null {
    this.#sweep();
    if (token.length === 0) return null;
    // Constant-time comparison against every live token: a token is a secret,
    // and `Map.get` would leak its presence through timing.
    const candidate = Buffer.from(token);
    for (const stored of this.#byToken.values()) {
      const known = Buffer.from(stored.token);
      if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
        return stored;
      }
    }
    return null;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, stored] of this.#byToken) {
      if (stored.expiresAt <= now) this.#byToken.delete(token);
    }
  }
}

/** The process-wide store; the server hands it to the routes and the bot. */
export const linkTokens = new LinkTokenStore();
