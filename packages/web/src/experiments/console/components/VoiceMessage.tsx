import { ChevronDown, ChevronRight, Mic } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { formatBytes } from '../primitives/file';
import type { MessageFile } from '../primitives/message';

interface VoiceMessageProps {
  /** The marker's note: how long it was, and what happened to it. */
  note: string;
  /** What was said. Empty when nothing could be transcribed. */
  transcript: string;
  /** The recording itself, as the history remembers it. */
  recording?: MessageFile | undefined;
}

/**
 * A message the operator spoke: the recording named on top, the words under it.
 *
 * The transcript starts OPEN. The operator asked to be able to hide it, not to
 * have it hidden — and it is the message: it is what the agent was given and
 * what the answer below is answering, so a chat of folded rows would be a chat
 * nobody could read back. Folding it away is one click, and the note stays
 * visible either way, which is the part that says whether anything went wrong.
 *
 * There is no player. The audio is deleted once the agent has read it (as every
 * attachment is), so the row names the file rather than pretending it can still
 * be played — the words are the durable part, and they are right here.
 */
export function VoiceMessage({ note, transcript, recording }: VoiceMessageProps): ReactElement {
  const [open, setOpen] = useState(true);
  const hasWords = transcript.length > 0;

  return (
    <div className="flex flex-col gap-[6px]">
      <button
        type="button"
        onClick={() => {
          setOpen(current => !current);
        }}
        disabled={!hasWords}
        aria-expanded={hasWords ? open : undefined}
        title={hasWords ? (open ? 'Hide the transcript' : 'Show the transcript') : undefined}
        className="flex items-center gap-[7px] text-left font-mono text-[11px] leading-[1.45] text-text-tertiary transition-colors hover:text-text-secondary disabled:cursor-default disabled:hover:text-text-tertiary"
      >
        <Mic aria-hidden className="h-[13px] w-[13px] shrink-0" />
        <span className="min-w-0">
          {note}
          {recording === undefined ? null : (
            <span className="opacity-70"> · {formatBytes(recording.size)}</span>
          )}
        </span>
        {hasWords ? (
          open ? (
            <ChevronDown aria-hidden className="h-[13px] w-[13px] shrink-0" />
          ) : (
            <ChevronRight aria-hidden className="h-[13px] w-[13px] shrink-0" />
          )
        ) : null}
      </button>
      {hasWords && open ? <div className="whitespace-pre-wrap">{transcript}</div> : null}
    </div>
  );
}
