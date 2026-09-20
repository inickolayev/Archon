/**
 * Leaving the console.
 *
 * Signing out is three things that must happen in this order, which is why it
 * lives in one place instead of being retyped next to every button:
 *
 *  1. end the session on the server — Better Auth drops the row and clears the
 *     cookie, and Archon drops any one-time link token issued for the account,
 *     so a link mailed to Telegram a minute ago stops working too;
 *  2. wipe the console's store — whoever signs in next must not read this
 *     account's projects, chats and messages out of a warm cache;
 *  3. only then leave for the sign-in page.
 *
 * If step 1 fails nothing else happens: the session is still live, so pretending
 * otherwise (clearing the cache, showing the login form) would be a lie. The
 * caller surfaces the error and the operator stays where they were.
 */

export interface SignOutDeps {
  /** Ends the session server-side. */
  readonly signOut: () => Promise<void>;
  /** Empties the console's entity cache. */
  readonly clearAll: () => void;
  /** Leaves for the sign-in page, replacing history. */
  readonly redirect: () => void;
}

export async function performSignOut(deps: SignOutDeps): Promise<void> {
  await deps.signOut();
  deps.clearAll();
  deps.redirect();
}

/**
 * The default way out: a real page load of `/login`, replacing history.
 *
 * Not the router's `navigate`. The console mounts as a descendant route under
 * `/console/*`, and an in-app navigation left the operator on `/console` with
 * the shell still painted and `401` errors where their projects had been —
 * the flash of stale, authenticated-looking content this is supposed to
 * prevent. A document navigation throws the whole page away, so there is
 * nothing left to flash and nothing left in memory; `replace` keeps Back from
 * returning to it.
 */
export function leaveForSignIn(): void {
  window.location.replace('/login');
}
