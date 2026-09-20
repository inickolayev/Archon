/**
 * What the marker line on a dictated message says.
 *
 * One sentence a person reads: how long the recording was, and what happened to
 * it. It is prose on purpose — nothing parses it back, the console shows it as
 * the header of the voice row and the agent reads it as the sentence it is —
 * but it is built here, from a closed set of outcomes, so the wording cannot
 * drift between the two windows.
 *
 * Every branch says what the operator gets to do about it. A recording that was
 * not transcribed is still attached, and the note says so rather than leaving
 * them to guess whether the message arrived at all.
 */

/** `0:42`, `12:05`. Empty when the platform never said how long it was. */
export function durationLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${String(minutes)}:${String(whole % 60).padStart(2, '0')}`;
}

export type DictationOutcome =
  | 'transcribed'
  | 'silent'
  | 'no_credentials'
  | 'cannot_convert'
  | 'failed';

export interface NoteInput {
  readonly outcome: DictationOutcome;
  /** Length of the whole recording, when known. */
  readonly durationSec: number | null;
  /** Only the first `maxDurationSec` of it was transcribed. */
  readonly truncated: boolean;
  /** The repair pass ran and its answer was accepted. */
  readonly cleaned: boolean;
  readonly maxDurationSec: number;
  /**
   * Spell out which keys are missing. True only the first time this process
   * meets a recording it cannot transcribe — after that the short form is
   * enough, and repeating a setup instruction on every message is noise.
   */
  readonly explainSetup: boolean;
}

function withDuration(label: string, rest: string): string {
  return label === '' ? rest : `${label}, ${rest}`;
}

export function dictationNote(input: NoteInput): string {
  const label = durationLabel(input.durationSec);
  switch (input.outcome) {
    case 'transcribed': {
      if (input.truncated) {
        const kept = durationLabel(input.maxDurationSec);
        return withDuration(
          label,
          `only the first ${kept} could be transcribed — the rest is in the attached recording`
        );
      }
      return withDuration(
        label,
        input.cleaned
          ? 'transcribed and tidied up'
          : 'transcribed; the tidy-up pass did not run, so this is the raw transcript'
      );
    }
    case 'silent':
      return withDuration(label, 'nothing was recognised in it');
    case 'no_credentials':
      return withDuration(
        label,
        input.explainSetup
          ? 'not transcribed: no speech-recognition keys are configured. Set YANDEX_STT_API_KEY and YANDEX_STT_FOLDER_ID to turn transcription on'
          : 'not transcribed: no speech-recognition keys are configured'
      );
    case 'cannot_convert':
      return withDuration(
        label,
        input.explainSetup
          ? 'not transcribed: this recording has to be converted first and ffmpeg is not installed on this host. Install ffmpeg, or record in the console, which needs none'
          : 'not transcribed: this recording needs ffmpeg, which is not installed'
      );
    case 'failed':
      return withDuration(label, 'not transcribed: speech recognition failed');
  }
}
