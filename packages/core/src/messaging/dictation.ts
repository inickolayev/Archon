/**
 * Saying, inside the message, that it was spoken rather than typed.
 *
 * The operator dictates; what reaches the agent is the transcript. That is a
 * different thing from a typed line and has to admit it: a name can be misheard,
 * a sentence can end where the speaker paused rather than where the thought did.
 * An agent told none of that treats "поставь волт" as a typo it should correct,
 * or asks for a clarification the operator already gave.
 *
 * The marker travels INSIDE the message text, for the same two reasons the
 * quote blocks do (see `quoted-context.ts`): the conversation rows belong to a
 * pinned upstream engine, and both windows plus the agent's prompt all need the
 * same one representation. It sits at the start of the operator's own words —
 * after any quote blocks, which are parsed off first and always come first.
 *
 * The shape is fixed, and the server is the only thing that produces it:
 *
 *     🎙 **Dictated** — 0:42, transcribed and cleaned up
 *
 *     давай посмотрим, что с деплоем
 *
 * The note is prose for a person: how long the recording was, and anything that
 * went wrong on the way (the cleanup pass failed, the tail was too long to
 * transcribe, there are no keys at all). Nothing reads it back as data — the
 * console shows it as the header of the voice row, and the agent reads it as
 * the sentence it is.
 */

/** The fixed word that opens the marker line; the agent's prompt names it. */
export const DICTATION_HEADER = 'Dictated';

/** Longest note we render. A note is ours, but a bug should not blow up a row. */
const MAX_NOTE_CHARS = 200;

/**
 * A note safe to put on the marker line.
 *
 * Flattened to one line and stripped of the markdown that builds the line
 * itself: a note carrying `**` would close the bold run early and leave the
 * rest of it outside the marker the parser and the prompt rely on.
 */
function safeNote(note: string): string {
  const flat = note
    .replace(/\s+/g, ' ')
    .replace(/[*`_[\]]/g, '')
    .trim();
  const clipped = flat.slice(0, MAX_NOTE_CHARS);
  return clipped.length > 0 ? clipped : 'transcribed from a recording';
}

/**
 * The stored text of a dictated message: the marker line, a blank line, then
 * the transcript.
 *
 * An empty transcript is legitimate and keeps the marker alone — a recording
 * with nothing recognisable in it, or one that arrived with no way to
 * transcribe it. The note then says which, and the audio is attached either
 * way, so the turn still carries everything the operator sent.
 */
export function formatDictatedMessage(note: string, transcript: string): string {
  const marker = `🎙 **${DICTATION_HEADER}** — ${safeNote(note)}`;
  const body = transcript.trim();
  return body.length === 0 ? marker : `${marker}\n\n${body}`;
}

export interface DictatedMessage {
  /** The note from the marker line, or null when the message was typed. */
  readonly note: string | null;
  /** What was said, with the marker taken off. */
  readonly body: string;
}

/**
 * Matches only a marker we wrote ourselves, on a line of its own at the very
 * start. A dictated line that happens to contain the same words is body text
 * somebody spoke, and stays body text.
 */
const MARKER_PATTERN = new RegExp(`^🎙 \\*\\*${DICTATION_HEADER}\\*\\* — (.+)$`);

/**
 * Read a stored message back into its dictation note and the words themselves.
 *
 * Call it on the body a quote parse left behind, not on the raw row: quotes
 * come first, and a dictated reply carries both.
 */
export function parseDictatedMessage(content: string): DictatedMessage {
  const lines = content.split('\n');
  const marker = MARKER_PATTERN.exec(lines[0] ?? '');
  if (marker === null) return { note: null, body: content.trim() };
  let index = 1;
  while (index < lines.length && (lines[index] ?? '').trim().length === 0) index += 1;
  return { note: marker[1] ?? '', body: lines.slice(index).join('\n').trim() };
}
