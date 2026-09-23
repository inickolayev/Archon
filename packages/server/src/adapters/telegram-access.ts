/**
 * Who may drive the agent from Telegram, and what a stranger gets instead.
 *
 * The rule is the account link, not a list of ids: a sender is allowed when
 * their Telegram identity resolves to an Archon user that also has a `web`
 * identity — a real console account, created through a signup the email
 * allowlist let through. Both halves matter. The telegram row on its own is
 * what the adapter mints for anybody who writes, so it proves nothing; the web
 * row is what makes it a person we know.
 *
 * An unlinked sender is not ignored. They get the same one-time link the ☰ menu
 * issues (ADR 0003), and nothing else happens — no turn, no conversation, no
 * cost. The link is safe to hand to a stranger because it is bound to the
 * Telegram id it was issued for: whoever spends it links THAT phone to the
 * account that confirms, never someone else's.
 *
 * Why this replaced the whitelist, and what it costs:
 * `docs/adr/0004-telegram-access-by-account-link.md` in the Factory.
 */

import * as accountLinks from '@archon/core/db/account-links';
import { createLogger } from '@archon/paths';
import type { TelegramAccess, TelegramSender } from '@archon/adapters';
import { LINK_TOKEN_TTL_MS, linkTokens } from '../auth/link-tokens';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.telegram.access');
  return cachedLog;
}

/**
 * One offer per sender per token lifetime. Without this the bot is an echo
 * anyone can make speak by writing to it, and a way to spend our send quota.
 * In memory on purpose: the window is minutes, and a restart re-offering a
 * link is the harmless direction.
 */
const lastOfferAt = new Map<string, number>();

/** The console origin a browser actually reaches, never a guess at a hostname. */
export function consoleOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return (env.BETTER_AUTH_URL ?? `http://127.0.0.1:${env.PORT ?? '3090'}`).replace(/\/+$/, '');
}

/** The message that carries a fresh one-time link for this Telegram sender. */
export function accountLinkMessage(claim: {
  platformUserId: string;
  chatId: string;
  displayName?: string;
}): string {
  const issued = linkTokens.issue(claim);
  const minutes = Math.round(LINK_TOKEN_TTL_MS / 60000);
  const url = `${consoleOrigin()}/console/link/${issued.token}`;
  return [
    'Open this once in the browser where you are signed in to the console:',
    '',
    url,
    '',
    `It works once and expires in ${String(minutes)} minutes.`,
  ].join('\n');
}

/** True when this Telegram identity resolves to an account with a web login. */
export async function isLinkedToAccount(telegramUserId: string): Promise<boolean> {
  const user = await accountLinks.findUserByIdentity('telegram', telegramUserId);
  if (user === null) return false;
  return (await accountLinks.findWebAccountForUser(user.id)) !== null;
}

/**
 * The authorizer the adapter asks on every inbound update. A linked sender is
 * allowed; anyone else is refused, and offered the link at most once per token
 * lifetime — the adapter decides whether to actually send that offer, and does
 * not for taps and stickers.
 */
export function telegramAccess(options?: {
  readonly now?: () => number;
  /** Test seam: the real one asks the database. */
  readonly isLinked?: (telegramUserId: string) => Promise<boolean>;
}) {
  const now = options?.now ?? ((): number => Date.now());
  const isLinked = options?.isLinked ?? isLinkedToAccount;

  return async function decide(sender: TelegramSender): Promise<TelegramAccess> {
    if (sender.userId === undefined) return { allow: false };
    const telegramUserId = String(sender.userId);

    try {
      if (await isLinked(telegramUserId)) return { allow: true };
    } catch (err) {
      // A database that cannot answer is not permission to proceed.
      getLog().error({ err }, 'telegram.access_check_failed');
      return { allow: false };
    }

    const previous = lastOfferAt.get(telegramUserId);
    if (previous !== undefined && now() - previous < LINK_TOKEN_TTL_MS) {
      return { allow: false };
    }
    lastOfferAt.set(telegramUserId, now());

    return {
      allow: false,
      reply: [
        'This chat is not connected to a Factory account yet.',
        '',
        accountLinkMessage({
          platformUserId: telegramUserId,
          chatId: sender.chatId,
          ...(sender.displayName === undefined ? {} : { displayName: sender.displayName }),
        }),
      ].join('\n'),
    };
  };
}

/** Test seam: forget who has been offered a link. */
export function resetOfferHistory(): void {
  lastOfferAt.clear();
}
