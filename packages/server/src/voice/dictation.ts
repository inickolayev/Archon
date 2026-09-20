/**
 * A recording the operator sent, turned into the message they meant.
 *
 * One road for both windows. A voice note from the phone and a clip recorded in
 * the console arrive as the same thing by this point — an attachment that has
 * already been validated and written to disk by the shared upload path — so
 * they are transcribed, tidied up and worded identically, and the console shows
 * the same transcript whichever window it was spoken into.
 *
 * What comes out is the text of the message: a marker saying it was dictated,
 * then the words. That text is what is persisted, what both windows render and
 * what the agent is given, which is the whole point of putting it in the text
 * rather than in a column (see `@archon/core/messaging/dictation`).
 *
 * The recording itself stays attached in every branch, including the ones where
 * nothing could be transcribed. Losing the operator's message because this
 * install has no keys, or no ffmpeg, or because a model timed out, is never an
 * acceptable outcome.
 */

import { readFile } from 'node:fs/promises';
import { createLogger } from '@archon/paths';
import type { AttachedFile } from '@archon/core';
import { formatDictatedMessage } from '@archon/core/messaging/dictation';
import {
  formatQuotedMessage,
  parseQuotedMessage,
} from '@archon/core/messaging/quoted-context';
import { isVoiceUpload } from './audio-format';
import { cleanTranscript } from './clean-transcript';
import { voiceConfig } from './config';
import { dictationNote, type DictationOutcome } from './notes';
import { transcribe, type Recording, type TranscribeOutcome } from './transcribe';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.voice.dictation');
  return cachedLog;
}

/**
 * Whether this process has already spelled out how to turn transcription on.
 *
 * The operator is told what is missing once; after that the note keeps saying
 * the recording was not transcribed, without repeating the setup line on every
 * message. Per process, not per conversation: it is one install and one person
 * configuring it.
 */
let setupExplained = false;

/** Test seam: forget that the setup notice was given. */
export function resetDictationNoticeForTests(): void {
  setupExplained = false;
}

export interface DictationRequest {
  /**
   * The message as it arrived: what the operator typed alongside the recording
   * (usually nothing), quote blocks and all. Quotes are lifted off and put back
   * in front, because they have to stay on the first line for both windows and
   * the agent to find them.
   */
  readonly typed: string;
  /** Everything attached to this message, audio and not. */
  readonly files: readonly AttachedFile[];
  /** The conversation's provider, for the tidy-up pass. */
  readonly assistantType: string;
  readonly userId?: string;
  /** Length the platform reported, when it reported one. */
  readonly durationSec?: number;
}

export interface Dictation {
  /** The message text: marker, words, and anything the operator typed. */
  readonly text: string;
  /** The words alone. Empty when nothing was transcribed. */
  readonly transcript: string;
  /** The marker's note, for a window that shows it separately. */
  readonly note: string;
  /**
   * What to show back in the chat the recording came from: the marker and the
   * words, and nothing else. Not `text`, which also carries the quote blocks and
   * anything typed — a chat app already draws the quoted original above a reply
   * and the operator can see their own caption, so repeating both under their
   * voice note would be three copies of the same screen.
   */
  readonly echo: string;
}

/** The first attached file that is a recording, or null when none is. */
export function voiceAttachmentOf(files: readonly AttachedFile[]): AttachedFile | null {
  return files.find(file => isVoiceUpload(file.mimeType, file.name)) ?? null;
}

function outcomeOf(result: TranscribeOutcome): DictationOutcome {
  switch (result.kind) {
    case 'transcribed':
      return 'transcribed';
    case 'silent':
      return 'silent';
    case 'failed':
      return 'failed';
    case 'unavailable':
      return result.reason === 'no_credentials' ? 'no_credentials' : 'cannot_convert';
  }
}

/**
 * Transcribe the recording in this message, if there is one.
 *
 * Returns null when the message carried no audio — nothing about an ordinary
 * message changes, and the caller keeps the text it already had.
 *
 * NEVER THROWS: a failure to read the file back off disk is another outcome
 * with a note, not a lost message.
 */
export async function dictationFor(request: DictationRequest): Promise<Dictation | null> {
  const file = voiceAttachmentOf(request.files);
  if (file === null) return null;

  const config = voiceConfig();
  // A dictated reply carries both: the thing pointed at, and the words. The
  // quote parse runs first here exactly as it does when the message is read
  // back, so the two agree about where one ends and the other begins.
  const quoted = parseQuotedMessage(request.typed.trim());
  const typed = quoted.body;

  let result: TranscribeOutcome;
  try {
    const recording: Recording = {
      bytes: new Uint8Array(await readFile(file.path)),
      mimeType: file.mimeType,
      fileName: file.name,
      ...(request.durationSec === undefined ? {} : { durationSec: request.durationSec }),
    };
    result = await transcribe(recording);
  } catch (err) {
    getLog().warn({ err, fileName: file.name }, 'voice.recording_unreadable');
    result = { kind: 'failed', error: 'the recording could not be read back' };
  }

  let transcript = '';
  let cleaned = false;
  if (result.kind === 'transcribed') {
    if (config.VOICE_CLEANUP_ENABLED) {
      const repaired = await cleanTranscript(result.text, {
        assistantType: request.assistantType,
        ...(request.userId === undefined ? {} : { userId: request.userId }),
        lang: config.YANDEX_STT_LANG,
        timeoutMs: config.VOICE_CLEANUP_TIMEOUT_MS,
      });
      transcript = repaired.text;
      cleaned = repaired.cleaned;
    } else {
      transcript = result.text;
    }
  }

  const outcome = outcomeOf(result);
  // The long form of "here is what to configure" is owed once per process; the
  // flag is set even when this particular note came out short, because the two
  // unconfigured outcomes are one setup story from the operator's side.
  const explainSetup =
    !setupExplained && (outcome === 'no_credentials' || outcome === 'cannot_convert');
  if (explainSetup) setupExplained = true;

  const note = dictationNote({
    outcome,
    durationSec:
      request.durationSec ??
      (result.kind === 'transcribed' || result.kind === 'silent' ? result.totalDurationSec : null),
    truncated: result.kind === 'transcribed' && result.truncated,
    cleaned,
    maxDurationSec: config.VOICE_MAX_DURATION_SEC,
    explainSetup,
  });

  // Typed words come after what was said, so the marker stays on the first
  // line where both windows and the agent look for it. Usually there are none
  // — a voice note carries no caption at all.
  const body = [transcript, typed].filter(part => part.length > 0).join('\n\n');
  const spoken = formatDictatedMessage(note, transcript);
  return {
    text: formatQuotedMessage(quoted.quotes, formatDictatedMessage(note, body)),
    transcript,
    note,
    echo: spoken,
  };
}
