/**
 * What a Telegram update was pointing at.
 *
 * Two gestures reach the bot carrying something other than typed words. A
 * REPLY points at a message already in this chat — usually one of the agent's
 * own, meaning "this one, do X about it". A FORWARD carries a message in from
 * somewhere else entirely — "look at what I was just sent". Before this, both
 * arrived as nothing but whatever the operator typed alongside, and the thing
 * they were pointing at was simply lost.
 *
 * Everything here is pure: the shape of the update in, a labelled quote out.
 * Fetching a forwarded photo's bytes stays where the token is.
 *
 * A forward's own text becomes the QUOTE, never the message body. That is not a
 * presentation choice: a forward comes from outside — a channel, a stranger, a
 * group the operator is merely in — and text from outside must never arrive
 * where the agent reads its instructions.
 */

import { mergeAdjacentQuotes, type MessageQuote } from '@archon/core/messaging/quoted-context';

/**
 * What the operator is told the agent was given when they forward something and
 * add nothing of their own — which Telegram gives them no way to do. An empty
 * body would reach the orchestrator as a turn with no instruction in it.
 */
export const FORWARDED_WITHOUT_INSTRUCTION =
  'Forwarded this — no instruction of their own was attached.';

/** The parts of a Telegram `User` a label is built from. */
export interface QuoteUser {
  readonly id?: number;
  readonly is_bot?: boolean;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
}

/** The parts of a Telegram `Chat` a label is built from. */
export interface QuoteChat {
  readonly title?: string;
  readonly username?: string;
}

/**
 * Telegram's `MessageOrigin`, as the four shapes the Bot API documents. Read
 * structurally rather than through grammY's union so an origin type added later
 * degrades to a generic label instead of throwing.
 */
export interface ForwardOrigin {
  readonly type?: string;
  /** `user` — the sender is visible. */
  readonly sender_user?: QuoteUser;
  /** `hidden_user` — forwarding is restricted, only a name survives. */
  readonly sender_user_name?: string;
  /** `chat` — posted on behalf of a group. */
  readonly sender_chat?: QuoteChat;
  /** `channel` — a channel post. */
  readonly chat?: QuoteChat;
  readonly author_signature?: string;
}

/** The parts of a message this module reads; a superset of one it replies to. */
export interface QuotableMessage {
  readonly text?: string;
  readonly caption?: string;
  readonly from?: QuoteUser;
  readonly forward_origin?: ForwardOrigin;
  readonly reply_to_message?: QuotableMessage;
}

/** A person's name as Telegram gives it, preferring the one they chose. */
function personName(user: QuoteUser | undefined): string | null {
  if (user === undefined) return null;
  const full = [user.first_name, user.last_name].filter(part => part).join(' ');
  if (full.length > 0) return full;
  if (user.username !== undefined && user.username.length > 0) return `@${user.username}`;
  return null;
}

/** A chat's name, preferring its title over the handle it is reachable by. */
function chatName(chat: QuoteChat | undefined): string | null {
  if (chat === undefined) return null;
  if (chat.title !== undefined && chat.title.length > 0) return chat.title;
  if (chat.username !== undefined && chat.username.length > 0) return `@${chat.username}`;
  return null;
}

/** ", signed X" when a channel or group post carries an author signature. */
function signature(origin: ForwardOrigin): string {
  const signed = origin.author_signature;
  return signed !== undefined && signed.length > 0 ? `, signed ${signed}` : '';
}

/**
 * Where a forwarded message came from, in words.
 *
 * The four documented origins are handled explicitly — `forward_from` alone
 * would miss three of them, and an origin Telegram adds later has to say
 * something honest rather than silently claim the wrong source.
 */
export function forwardOriginLabel(origin: ForwardOrigin): string {
  switch (origin.type) {
    case 'user':
      return `forwarded from ${personName(origin.sender_user) ?? 'someone'}`;
    case 'hidden_user': {
      const name = origin.sender_user_name;
      const who = name !== undefined && name.length > 0 ? name : 'someone';
      // Telegram gives a name and nothing else when the sender forbids being
      // linked; saying so keeps the agent from treating it as an identity.
      return `forwarded from ${who} (account hidden)`;
    }
    case 'chat':
      return `forwarded from the group "${chatName(origin.sender_chat) ?? 'unnamed'}"${signature(origin)}`;
    case 'channel':
      return `forwarded from the channel "${chatName(origin.chat) ?? 'unnamed'}"${signature(origin)}`;
    default:
      return 'forwarded from somewhere Telegram would not name';
  }
}

/** The text a message carries, whichever field it carries it in. */
export function quotableText(message: QuotableMessage): string {
  return (message.text ?? message.caption ?? '').trim();
}

/** The quote a forwarded message is, or null when the message is not one. */
export function forwardQuoteOf(message: QuotableMessage): MessageQuote | null {
  const origin = message.forward_origin;
  if (origin === undefined) return null;
  return { label: forwardOriginLabel(origin), text: quotableText(message) };
}

/**
 * The quote a reply points at, or null when the message replies to nothing.
 *
 * Whose message it was matters to the agent: its own earlier answer is
 * something it said and can be held to, while anyone else's is just text it was
 * shown. A replied-to message that is itself a forward keeps its origin in the
 * label — the operator is pointing at something from outside either way.
 */
export function replyQuoteOf(
  message: QuotableMessage,
  senderId: number | undefined
): MessageQuote | null {
  const replied = message.reply_to_message;
  if (replied === undefined) return null;
  const text = quotableText(replied);
  const origin = replied.forward_origin;
  if (origin !== undefined) {
    return { label: `an earlier message in this chat, ${forwardOriginLabel(origin)}`, text };
  }
  if (replied.from?.is_bot === true) {
    return { label: "the agent's earlier message", text };
  }
  if (senderId !== undefined && replied.from?.id === senderId) {
    return { label: "the user's own earlier message", text };
  }
  return { label: `an earlier message from ${personName(replied.from) ?? 'someone'}`, text };
}

/** One piece of a batch of forwards: what it quoted and what it carried. */
export interface ForwardedPiece<TFile> {
  readonly quote: MessageQuote;
  readonly files: readonly TFile[];
}

/**
 * Several forwards arriving together, folded into the one turn they are.
 *
 * Forwarding four messages is one gesture, and answering it four times over is
 * not what the operator asked for. Quotes keep their order; repeats of the same
 * origin collapse, which is what a forwarded album looks like on the wire.
 */
export function batchedForward<TFile>(pieces: readonly ForwardedPiece<TFile>[]): {
  quotes: MessageQuote[];
  files: TFile[];
} {
  return {
    quotes: mergeAdjacentQuotes(pieces.map(piece => piece.quote)),
    files: pieces.flatMap(piece => [...piece.files]),
  };
}
