/**
 * Who may drive the agent from Telegram.
 *
 * This fork does not keep a list of ids. A sender is allowed when their
 * Telegram identity is linked to a console account, and the adapter cannot
 * answer that on its own — the identities live in the database, which is the
 * server's side of the house. So it asks, through the function injected here,
 * and does what it is told: proceed, or send the reply it was handed and stop.
 *
 * The rule itself, and why it replaced the whitelist, is ADR 0004 in the
 * Factory (`docs/adr/0004-telegram-access-by-account-link.md`).
 *
 * Fail-closed is kept and moved: `TelegramAdapter.start()` refuses to poll when
 * no authorizer was injected. An adapter that cannot tell who is allowed is not
 * a bot with a permissive default — it is a bot that does not run.
 */

/** Everything the decision is allowed to depend on. */
export interface TelegramSender {
  /** Telegram's numeric user id. Absent on updates with no sender. */
  readonly userId: number | undefined;
  /** The chat the message arrived in, for a reply. */
  readonly chatId: string;
  /** First + last name as Telegram gave them, when it gave them. */
  readonly displayName?: string;
}

export type TelegramAccess =
  /** Linked to an account: the message becomes a turn. */
  | { readonly allow: true }
  /**
   * Not linked. `reply` is sent to the chat and nothing else happens — no
   * turn, no conversation, no cost. Absent means stay silent, which is what
   * repeat messages inside the rate-limit window get.
   */
  | { readonly allow: false; readonly reply?: string };

export type TelegramAuthorizer = (sender: TelegramSender) => Promise<TelegramAccess>;
