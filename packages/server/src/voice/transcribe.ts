/**
 * A recording in, the words in it out.
 *
 * The shape is the manager-bot's: cut the audio into pieces the recogniser will
 * take, recognise them with bounded concurrency, keep the order, join. Two
 * things are different, and both come from this install rather than from that
 * one.
 *
 * There is no claim table and no idempotency key. That bot is driven by
 * webhooks, which retry; this one polls Telegram and serves one operator, so a
 * recording arrives exactly once and a row to deduplicate against would be a
 * schema addition buying nothing.
 *
 * And ffmpeg is optional. The engine is chosen per recording: raw PCM is cut up
 * with arithmetic, a short clip already in an accepted container goes out
 * untouched, and only the rest needs ffmpeg — so a host without it still
 * transcribes everything the console records and every short voice note.
 */

import { createLogger } from '@archon/paths';
import {
  YANDEX_MAX_REQUEST_BYTES,
  YANDEX_MAX_REQUEST_SECONDS,
  lpcmChunks,
  parseWav,
  pcmDurationSec,
  yandexFormatOf,
  type AudioChunks,
  type YandexAudioFormat,
} from './audio-format';
import { ffmpegAvailable, splitIntoOggChunks } from './ffmpeg';
import { recognizeShort, type YandexSttOptions } from './yandex-stt';
import { sttCredentials, voiceConfig, type VoiceConfig } from './config';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.voice.transcribe');
  return cachedLog;
}

export interface Recording {
  readonly bytes: Uint8Array;
  /** As the sender reported it; may be empty. */
  readonly mimeType: string;
  readonly fileName: string;
  /** Length in seconds when the platform reported one (Telegram does). */
  readonly durationSec?: number;
}

export type TranscribeOutcome =
  | {
      readonly kind: 'transcribed';
      readonly text: string;
      /** Only the start was transcribed; the rest ran past the cap. */
      readonly truncated: boolean;
      readonly totalDurationSec: number | null;
    }
  | { readonly kind: 'silent'; readonly totalDurationSec: number | null }
  /** Nothing was attempted, and the reason is not the operator's fault. */
  | { readonly kind: 'unavailable'; readonly reason: 'no_credentials' | 'cannot_convert' }
  | { readonly kind: 'failed'; readonly error: string };

/** Everything the transcriber needs from outside, injected so tests stay pure. */
export interface TranscribeDeps {
  readonly recognize?: typeof recognizeShort;
  readonly convert?: typeof splitIntoOggChunks;
  readonly hasFfmpeg?: () => Promise<boolean>;
  readonly config?: VoiceConfig;
  readonly credentials?: { apiKey: string; folderId: string } | null;
}

/** One request's worth of audio, with the format to declare for it. */
interface Plan {
  readonly format: YandexAudioFormat;
  readonly sampleRateHertz?: number;
  readonly audio: AudioChunks;
}

/**
 * Decide how to get this recording into requests the endpoint accepts.
 *
 * Returns null when the only route is a conversion this host cannot perform.
 */
async function planChunks(
  recording: Recording,
  config: VoiceConfig,
  deps: TranscribeDeps
): Promise<Plan | null> {
  const format = yandexFormatOf(recording.mimeType, recording.fileName);

  if (format === 'lpcm') {
    const pcm = parseWav(recording.bytes);
    // A WAV that is really something else (compressed, stereo, an odd rate)
    // falls through to the converter rather than being sent as garbage.
    if (pcm !== null) {
      return {
        format: 'lpcm',
        sampleRateHertz: pcm.sampleRate,
        audio: lpcmChunks(pcm, config.VOICE_CHUNK_SECONDS, config.VOICE_MAX_DURATION_SEC),
      };
    }
  } else if (format !== null) {
    // Already in an accepted container. When it fits one request, send the
    // bytes exactly as they arrived — no conversion, no ffmpeg, no re-encode.
    // An unknown duration is taken as "probably short": the recogniser refuses
    // anything longer, which is a clear failure rather than a wrong answer.
    const withinDuration =
      recording.durationSec === undefined || recording.durationSec <= YANDEX_MAX_REQUEST_SECONDS;
    if (withinDuration && recording.bytes.byteLength <= YANDEX_MAX_REQUEST_BYTES) {
      return {
        format,
        audio: {
          chunks: [recording.bytes],
          truncated: false,
          totalDurationSec: recording.durationSec ?? 0,
        },
      };
    }
  }

  const hasFfmpeg = deps.hasFfmpeg ?? ffmpegAvailable;
  if (!(await hasFfmpeg())) return null;
  const convert = deps.convert ?? splitIntoOggChunks;
  return {
    format: 'oggopus',
    audio: await convert(recording.bytes, {
      chunkSeconds: config.VOICE_CHUNK_SECONDS,
      maxTotalSeconds: config.VOICE_MAX_DURATION_SEC,
    }),
  };
}

/**
 * Recognise every chunk, in order, a few at a time.
 *
 * The workers share one AbortController: when one chunk fails for good, the
 * others stop rather than finishing their own retry ladders against a service
 * that has already said no.
 */
async function recognizeInOrder(
  chunks: readonly Uint8Array[],
  concurrency: number,
  recognize: typeof recognizeShort,
  base: YandexSttOptions
): Promise<string[]> {
  const results = new Array<string>(chunks.length).fill('');
  const controller = new AbortController();
  const options: YandexSttOptions = { ...base, signal: controller.signal };
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const chunk = chunks[index];
      if (chunk === undefined) return;
      try {
        results[index] = await recognize(chunk, options);
      } catch (err) {
        controller.abort();
        throw err;
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, chunks.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function joinChunks(parts: readonly string[]): string {
  return parts
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Transcribe one recording.
 *
 * NEVER THROWS: every outcome is a value the caller turns into a note on the
 * message, because the recording is attached either way and the turn has to
 * carry on.
 */
export async function transcribe(
  recording: Recording,
  deps: TranscribeDeps = {}
): Promise<TranscribeOutcome> {
  const config = deps.config ?? voiceConfig();
  const credentials = deps.credentials === undefined ? sttCredentials() : deps.credentials;
  if (credentials === null) return { kind: 'unavailable', reason: 'no_credentials' };

  try {
    const plan = await planChunks(recording, config, deps);
    if (plan === null) return { kind: 'unavailable', reason: 'cannot_convert' };

    const duration = recording.durationSec ?? (plan.audio.totalDurationSec || null);
    if (plan.audio.chunks.length === 0) return { kind: 'silent', totalDurationSec: duration };

    const recognize = deps.recognize ?? recognizeShort;
    const parts = await recognizeInOrder(
      plan.audio.chunks,
      config.VOICE_CHUNK_CONCURRENCY,
      recognize,
      {
        apiKey: credentials.apiKey,
        folderId: credentials.folderId,
        lang: config.YANDEX_STT_LANG,
        format: plan.format,
        ...(plan.sampleRateHertz === undefined ? {} : { sampleRateHertz: plan.sampleRateHertz }),
        timeoutMs: config.VOICE_STT_TIMEOUT_MS,
        retryAttempts: config.VOICE_STT_RETRY_ATTEMPTS,
        retryInitialDelayMs: config.VOICE_STT_RETRY_DELAY_MS,
      }
    );

    const text = joinChunks(parts);
    if (text.length === 0) return { kind: 'silent', totalDurationSec: duration };
    return {
      kind: 'transcribed',
      text,
      truncated: plan.audio.truncated,
      totalDurationSec: duration,
    };
  } catch (err) {
    // The message, never the audio and never the key: the client's errors are
    // already written to name neither.
    const error = err instanceof Error ? err.message : String(err);
    getLog().warn({ err }, 'voice.transcribe_failed');
    return { kind: 'failed', error };
  }
}

/** Seconds of audio in a WAV, for callers that only want the length. */
export function wavDurationSec(bytes: Uint8Array): number | null {
  const pcm = parseWav(bytes);
  return pcm === null ? null : pcmDurationSec(pcm);
}
