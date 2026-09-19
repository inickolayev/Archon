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
  /** Navigates to the sign-in page, replacing history. */
  readonly redirect: () => void;
}

export async function performSignOut(deps: SignOutDeps): Promise<void> {
  await deps.signOut();
  deps.clearAll();
  deps.redirect();
}
