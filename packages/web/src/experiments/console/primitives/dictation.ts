/**
 * Reading back a message the operator spoke.
 *
 * The server writes the marker into the message text — the same one Telegram
 * and the agent read — and the console takes it off again to draw the voice row
 * with the transcript folded under it. One conversation, two windows: what is
 * stored has to be the same thing on both.
 *
 * The rules are restated here rather than imported, for the reason
 * `quoted-context.ts` gives: `@archon/core` is a server package and the console
 * is a browser one. The authority is
 * `packages/core/src/messaging/dictation.ts`, and both sides have tests pinning
 * the same literal shape, so a drift shows up as two failing suites rather than
 * as a marker one window renders as raw text.
 *
 * The console only ever READS the marker. Nothing here writes one: a message is
 * dictated because a recording was transcribed, which happens on the server.
 */

/** The fixed word that opens the marker line. */
export const DICTATION_HEADER = 'Dictated';

export interface DictatedMessage {
  /** The note from the marker line, or null when the message was typed. */
  readonly note: string | null;
  /** What was said, with the marker taken off. */
  readonly body: string;
}

const MARKER_PATTERN = new RegExp(`^🎙 \\*\\*${DICTATION_HEADER}\\*\\* — (.+)$`);

/**
 * Split a stored message into its dictation note and the words themselves.
 *
 * Call it on what the quote parse left behind: quote blocks come first, and a
 * dictated reply carries both.
 */
export function parseDictatedMessage(content: string): DictatedMessage {
  const lines = content.split('\n');
  const marker = MARKER_PATTERN.exec(lines[0] ?? '');
  if (marker === null) return { note: null, body: content.trim() };
  let index = 1;
  while (index < lines.length && (lines[index] ?? '').trim().length === 0) index += 1;
  return { note: marker[1] ?? '', body: lines.slice(index).join('\n').trim() };
}
