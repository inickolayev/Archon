/**
 * Quoting a message into the one you are about to send.
 *
 * The operator picks a message in the stream, the composer carries it as a
 * quote, and the sent message opens with it. Telegram does the same thing with
 * a reply or a forward — one conversation, two windows, so the two windows have
 * to produce and read the very same text.
 *
 * The rules are restated here rather than imported: `@archon/core` is a server
 * package and the console is a browser one, the same reason `MessageCategory`
 * is restated in `lib/types.ts`. The authority is
 * `packages/core/src/messaging/quoted-context.ts`, and both sides have tests
 * pinning the same literal shape — a drift shows up as two failing suites, not
 * as a quote one window silently renders as raw text.
 */

import type { MessageRole } from './message';

/** The fixed word that opens a quote block; the agent's prompt names it. */
export const QUOTE_HEADER = 'Quoted context';

/** How much of a quoted message travels. See the core module for the why. */
export const QUOTE_MAX_CHARS = 1000;

const TRUNCATION_SUFFIX = '… [truncated]';
const MAX_LABEL_CHARS = 120;

export interface MessageQuote {
  /** Where it came from, in prose: "the agent's earlier message". */
  readonly label: string;
  /** What was quoted; empty is legitimate (a message that was only a file). */
  readonly text: string;
}

export interface QuotedMessage {
  readonly quotes: readonly MessageQuote[];
  /** What the operator themselves wrote, with the quotes taken off. */
  readonly body: string;
}

function safeLabel(label: string): string {
  const flat = label
    .replace(/\s+/g, ' ')
    .replace(/[*`_[\]]/g, '')
    .trim();
  const clipped = flat.slice(0, MAX_LABEL_CHARS);
  return clipped.length > 0 ? clipped : 'an unnamed source';
}

/** Cut a quote to length on a whole line where one is near, else mid-text. */
export function truncateQuote(text: string, max: number = QUOTE_MAX_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastBreak = head.lastIndexOf('\n');
  const cut = lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head;
  return `${cut.trimEnd()}${TRUNCATION_SUFFIX}`;
}

function quoteBlock(quote: MessageQuote): string {
  const header = `> **${QUOTE_HEADER} — ${safeLabel(quote.label)}**`;
  const text = truncateQuote(quote.text.trim());
  if (text.length === 0) return header;
  // Blank lines become a bare `>`: a real blank line would end the blockquote,
  // and the rest of the quote would then read as the operator's own words.
  const body = text.split('\n').map(line => (line.length === 0 ? '>' : `> ${line}`));
  return [header, ...body].join('\n');
}

/**
 * The text to send for a message that quotes something: the quote block, a
 * blank line, then the operator's own words. With nothing quoted it is exactly
 * what they typed.
 */
export function formatQuotedMessage(quotes: readonly MessageQuote[], body: string): string {
  const trimmedBody = body.trim();
  if (quotes.length === 0) return trimmedBody;
  return [...quotes.map(quoteBlock), trimmedBody].filter(part => part.length > 0).join('\n\n');
}

const HEADER_PATTERN = new RegExp(`^> \\*\\*${QUOTE_HEADER} — (.+)\\*\\*$`);

/**
 * Read a stored message back into its quotes and the words around them, so the
 * stream can draw a quote as a quote instead of leaving markup on screen.
 *
 * Quotes live at the very start or not at all; a header-looking line further
 * down is body text somebody typed, and stays body text.
 */
export function parseQuotedMessage(content: string): QuotedMessage {
  const lines = content.split('\n');
  const quotes: MessageQuote[] = [];
  let index = 0;

  for (;;) {
    const header = HEADER_PATTERN.exec(lines[index] ?? '');
    if (header === null) break;
    index += 1;
    const text: string[] = [];
    for (;;) {
      const line = lines[index];
      if (line === undefined || (line !== '>' && !line.startsWith('> '))) break;
      text.push(line === '>' ? '' : line.slice(2));
      index += 1;
    }
    quotes.push({ label: header[1] ?? '', text: text.join('\n').trim() });
    while (index < lines.length && (lines[index] ?? '').trim().length === 0) index += 1;
  }

  return { quotes, body: lines.slice(index).join('\n').trim() };
}

/**
 * How a message in the stream describes itself once it is quoted.
 *
 * Deliberately the same vocabulary the Telegram side uses, because the agent
 * reads both and should not have to learn that two labels mean one thing. The
 * author is threaded through for a chat several people write in; `you (…)` is
 * how the console names the signed-in account, and "the user" is how the agent
 * is taught to read it, so the quote says the latter.
 */
export function quoteLabelFor(role: MessageRole, author: string | null, isMine: boolean): string {
  if (role === 'assistant') return "the agent's earlier message";
  if (role === 'system') return 'an earlier system message';
  if (isMine || author === null) return "the user's own earlier message";
  return `an earlier message from ${author}`;
}

/**
 * The quote a message in the stream becomes when it is replied to.
 *
 * Its own quotes are left behind: quoting a quote nests context that was
 * already answered, and the operator is pointing at what the message SAID.
 */
export function quoteOfMessage(
  content: string,
  role: MessageRole,
  author: string | null,
  isMine: boolean
): MessageQuote {
  return {
    label: quoteLabelFor(role, author, isMine),
    text: parseQuotedMessage(content).body,
  };
}
