/**
 * Quoting something into a message.
 *
 * The operator points at a thing and says "this one — do X about it": an
 * earlier reply of the agent's, a message forwarded in from somewhere else. The
 * thing they pointed at has to travel with their words, or the agent is left
 * guessing what "this" was.
 *
 * It travels INSIDE the message text, as a labelled markdown blockquote, rather
 * than in a column of its own. Two reasons. The conversation rows are a pinned
 * upstream engine's, and inventing a migration inside it is the thing ADR 0001
 * decided not to do. And both windows have to draw the quote anyway — a
 * blockquote is already what the console renders and what Telegram accepts, so
 * the one representation serves storage, both screens and the agent's prompt.
 *
 * The shape is fixed, and both windows produce exactly it:
 *
 *     > **Quoted context — the agent's earlier message**
 *     > the part of it being pointed at
 *
 *     rerun this against the mobile viewport
 *
 * Everything before the blank line is what was quoted; everything after is the
 * operator speaking. That boundary is the whole safety story: quoted material
 * can come from outside — another chat, a channel, a stranger — so it is DATA
 * the agent was shown, never an instruction it follows. Every line of it is
 * prefixed, blank lines included, so nothing inside a quote can close the block
 * early and pass itself off as the operator's own words.
 */

/** The fixed word that opens a quote block; the agent's prompt names it. */
export const QUOTE_HEADER = 'Quoted context';

/**
 * How much of a quoted message travels.
 *
 * A forwarded post can be arbitrarily long, and the quote is context, not the
 * task — past roughly this much the operator's own sentence stops being the
 * loudest thing in the turn. A thousand characters is a few paragraphs: enough
 * for a forwarded post's substance, and the file itself still arrives whole
 * when the forward carried one.
 */
export const QUOTE_MAX_CHARS = 1000;

/** Says the quote was cut, so the agent does not read the end as the end. */
const TRUNCATION_SUFFIX = '… [truncated]';

/** Longest label we render; a chat title is sender-supplied and unbounded. */
const MAX_LABEL_CHARS = 120;

export interface MessageQuote {
  /** Where it came from, in prose: "the agent's earlier message". */
  readonly label: string;
  /** What was quoted. Empty is legitimate — a forwarded photo has no text. */
  readonly text: string;
}

export interface QuotedMessage {
  readonly quotes: readonly MessageQuote[];
  /** What the operator themselves wrote, with the quotes taken off. */
  readonly body: string;
}

/**
 * A label safe to put in the header line.
 *
 * Labels are built from names and chat titles, which whoever owns them chose:
 * a title containing `**` or a newline would otherwise end the bold run early
 * and let sender-supplied text sit outside the marker the prompt relies on.
 */
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
  // Prefer a line boundary, but only when it does not throw most of the quote
  // away — a single long paragraph has no break to find.
  const cut = lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head;
  return `${cut.trimEnd()}${TRUNCATION_SUFFIX}`;
}

/** One quote as its blockquote. A quote with no text is its header alone. */
function quoteBlock(quote: MessageQuote): string {
  const header = `> **${QUOTE_HEADER} — ${safeLabel(quote.label)}**`;
  const text = truncateQuote(quote.text.trim());
  if (text.length === 0) return header;
  // Blank lines become a bare `>` so the block stays one blockquote: a real
  // blank line would end it, and the rest of the quoted text would render — and
  // read — as the operator's own.
  const body = text.split('\n').map(line => (line.length === 0 ? '>' : `> ${line}`));
  return [header, ...body].join('\n');
}

/**
 * Fold neighbouring quotes that share a label into one block.
 *
 * A forwarded album arrives as several parts from the same origin, at most one
 * of which carries the caption; repeating the same header three times, twice
 * with nothing under it, says nothing the first one did not.
 */
export function mergeAdjacentQuotes(quotes: readonly MessageQuote[]): MessageQuote[] {
  const merged: MessageQuote[] = [];
  for (const quote of quotes) {
    const previous = merged[merged.length - 1];
    if (previous?.label !== quote.label) {
      merged.push({ label: quote.label, text: quote.text.trim() });
      continue;
    }
    const joined = [previous.text, quote.text.trim()].filter(part => part.length > 0).join('\n\n');
    merged[merged.length - 1] = { label: previous.label, text: joined };
  }
  return merged;
}

/**
 * The stored text of a message that quotes something: the quote blocks, then a
 * blank line, then the operator's own words. With no quotes it is just their
 * words, byte for byte — a message that quotes nothing must not change shape.
 */
export function formatQuotedMessage(quotes: readonly MessageQuote[], body: string): string {
  const trimmedBody = body.trim();
  if (quotes.length === 0) return trimmedBody;
  return [...quotes.map(quoteBlock), trimmedBody].filter(part => part.length > 0).join('\n\n');
}

/**
 * Matches only a header we wrote ourselves, at the start of a line of its own.
 * Quoted text is re-prefixed on the way in (`> > …`), so a quote that contains
 * a header of its own can never match here and forge a second block.
 */
const HEADER_PATTERN = new RegExp(`^> \\*\\*${QUOTE_HEADER} — (.+)\\*\\*$`);

/**
 * Read a stored message back into its quotes and the operator's own words.
 *
 * Quotes live at the very start or not at all, so parsing stops at the first
 * line that is not one — a header-looking line further down is body text
 * somebody typed, and stays body text.
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
