/**
 * The knobs on voice input, and where its credentials come from.
 *
 * Everything has a default that works, so the only thing an install must
 * actually supply is the SpeechKit key pair — and without even that, voice
 * still arrives as an ordinary attachment (see `dictation.ts`). Values are
 * validated rather than trusted: a typo in `VOICE_MAX_DURATION_SEC` should
 * fall back to the documented default, not cut every recording to zero.
 */

import { z } from 'zod';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.voice.config');
  return cachedLog;
}

const schema = z.object({
  /**
   * Longest recording transcribed. Past this the START is transcribed and the
   * message says so: ten minutes of dictation with the tail missing is worth
   * more to the operator than a refusal, and the audio itself is attached
   * whole either way.
   */
  VOICE_MAX_DURATION_SEC: z.coerce.number().int().positive().max(3600).default(600),
  /** Seconds per recognition request. Yandex refuses anything over thirty. */
  VOICE_CHUNK_SECONDS: z.coerce.number().int().positive().max(28).default(25),
  /** Chunks recognised at once. Ordering is preserved regardless. */
  VOICE_CHUNK_CONCURRENCY: z.coerce.number().int().positive().max(16).default(4),
  VOICE_STT_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  VOICE_STT_RETRY_ATTEMPTS: z.coerce.number().int().nonnegative().max(10).default(2),
  VOICE_STT_RETRY_DELAY_MS: z.coerce.number().int().positive().default(500),
  /**
   * How long the tidy-up pass may take before the raw transcript is used
   * instead. Generous enough for a cold provider subprocess, short enough that
   * a hung model does not hold a turn the operator is waiting on.
   */
  VOICE_CLEANUP_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /** Off leaves the recogniser's raw output as the message. */
  VOICE_CLEANUP_ENABLED: z
    .string()
    .default('true')
    .transform(v => v !== 'false' && v !== '0'),
  YANDEX_STT_LANG: z.string().default('ru-RU'),
});

export type VoiceConfig = z.infer<typeof schema>;

/**
 * The configuration, re-read on every call.
 *
 * Not cached on purpose: this is off the hot path (once per voice message) and
 * a cached copy would be one more thing that disagrees with the environment
 * after `.env` is edited and the process reloaded.
 */
export function voiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  // Never fail a message over a malformed knob: report which one, take the
  // defaults, carry on.
  getLog().warn(
    { issues: parsed.error.issues.map(i => i.path.join('.')) },
    'voice.config_invalid_using_defaults'
  );
  return schema.parse({});
}

export interface SttCredentials {
  readonly apiKey: string;
  readonly folderId: string;
}

/**
 * The SpeechKit credentials, or null when this install has none.
 *
 * Null is a supported state, not an error: voice then arrives as an attachment
 * nobody transcribed, and the message says why. The values are returned, never
 * logged — a key in a log line is a leaked key.
 */
export function sttCredentials(env: NodeJS.ProcessEnv = process.env): SttCredentials | null {
  const apiKey = env.YANDEX_STT_API_KEY?.trim() ?? '';
  const folderId = env.YANDEX_STT_FOLDER_ID?.trim() ?? '';
  if (apiKey === '' || folderId === '') return null;
  return { apiKey, folderId };
}
