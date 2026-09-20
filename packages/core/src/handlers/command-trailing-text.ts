/**
 * What happens to the words after a command that has no use for them.
 *
 * Observed live: a Telegram message read `/start подробный список всех файлов в
 * src/common…` — the composer had a leftover `/start` and the operator typed
 * their request after it. The bot showed the greeting and the whole request was
 * dropped without a word. The operator has no way to know the difference
 * between "the agent read this and had nothing to say" and "this never
 * happened", which is the worst of the three things that can be done with it.
 *
 * Of the three, this module picks REPORTING rather than acting. Acting on the
 * tail would mean deciding that a control gesture is also a prompt, and the
 * cases where that is wrong are the cases that matter: `/stop do X` would call
 * a turn off and immediately start another, and every mistyped command becomes
 * a way to smuggle an instruction past the operator's intent. The tail is
 * quoted back instead, verbatim, so resending it is a copy rather than retyping
 * a paragraph.
 *
 * Only for commands that genuinely take no arguments. `/setproject chesswin`
 * and `/workflow approve <id>` read theirs, and a notice there would be noise.
 */

/**
 * Commands whose whole meaning is the command. Anything typed after one of
 * these is not an argument that was misspelled — it is a different thought.
 *
 * Kept deliberately short and explicit rather than derived: a command that
 * gains an argument later must be REMOVED from here on purpose, and a
 * derivation would quietly get that wrong.
 */
export const ARGLESS_COMMANDS: ReadonlySet<string> = new Set([
  'chats',
  'commands',
  'help',
  'menu',
  'new',
  'projects',
  'reset',
  'start',
  'status',
  'stop',
]);

/** How much of the tail is quoted back before it is cut short. */
const MAX_QUOTED_CHARS = 500;

/**
 * The text after the command word, exactly as it was typed.
 *
 * Splits on the first run of whitespace rather than reusing `parseCommand`,
 * because the tail must come back to the operator the way they wrote it —
 * tokenising it would drop their quotes, collapse their line breaks and hand
 * them something they did not send.
 */
export function commandTrailingText(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  const firstBreak = trimmed.search(/\s/);
  if (firstBreak === -1) return '';
  return trimmed.slice(firstBreak).trim();
}

/**
 * The line to append to a command's answer, or `null` when there is nothing to
 * report — no tail, or a command that reads its own arguments.
 *
 * `command` is the parsed command word without its slash, as `parseCommand`
 * returns it.
 */
export function trailingTextNotice(command: string, rawMessage: string): string | null {
  if (!ARGLESS_COMMANDS.has(command)) return null;
  const tail = commandTrailingText(rawMessage);
  if (tail === '') return null;

  const quoted =
    tail.length > MAX_QUOTED_CHARS
      ? tail.slice(0, MAX_QUOTED_CHARS).trimEnd() + ' … [truncated]'
      : tail;

  const blockquote = quoted.replace(/\n/g, '\n> ');
  return (
    `⚠️ \`/${command}\` takes nothing after it, so the rest of that message was NOT ` +
    `passed to the agent:\n\n> ${blockquote}\n\n` +
    'Send it on its own if you meant it for the agent.'
  );
}

/**
 * A command's answer with the notice already attached. The common case —
 * nothing was dropped — returns the answer unchanged.
 */
export function withTrailingTextNotice(
  answer: string,
  command: string,
  rawMessage: string
): string {
  const notice = trailingTextNotice(command, rawMessage);
  return notice === null ? answer : `${answer}\n\n${notice}`;
}
