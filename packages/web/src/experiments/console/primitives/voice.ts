/**
 * Turning what the microphone heard into a file the server can transcribe.
 *
 * A browser's `MediaRecorder` produces Opus in a WebM container, which is not
 * one of the three the recogniser accepts — and converting it on the server
 * needs ffmpeg, which the image this runs in does not have. So the conversion
 * happens here instead, where a browser has a whole audio engine sitting idle:
 * the clip is decoded, resampled to the one rate the recogniser wants, and
 * written out as an ordinary WAV. Nothing on the server has to be installed for
 * a dictation from the console to work, and the attached file is something any
 * player can open.
 *
 * Everything in this file is arithmetic and is tested directly; the microphone
 * itself lives in `lib/recorder.ts`.
 */

/** What the recogniser wants: mono, 16 kHz, 16-bit — and what we encode. */
export const WAV_SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

/**
 * The longest clip the console will record, in seconds.
 *
 * Set by the attachment limit rather than by taste: mono 16 kHz PCM is 32 kB a
 * second, and an upload may not exceed 10 MB, so five minutes is very nearly
 * the whole budget (9.6 MB). Recording stops itself there rather than letting a
 * long dictation be refused at the end of it, which is the version of this that
 * loses the message.
 *
 * A UX hint like the rest of `file.ts`: the server enforces the real limits.
 */
export const MAX_RECORDING_SECONDS = 300;

/**
 * Containers to ask `MediaRecorder` for, best first.
 *
 * Ogg first because Firefox gives it and it needs no conversion at all if
 * anything ever sends it on untouched; WebM is what Chrome gives; an empty
 * string means "whatever you use by default", for Safari. Whatever comes back
 * is decoded and re-encoded here anyway, so this is a preference, not a
 * requirement.
 */
export const RECORDING_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const;

/** `0:42` — the same clock the marker note uses, so the two agree on screen. */
export function clockLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

/** A name that sorts by when it was said and survives `safeUploadName`. */
export function recordingFileName(at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `voice-${stamp}.wav`;
}

/**
 * Float samples (what the audio engine deals in) as signed 16-bit PCM.
 *
 * Clamped before scaling: a sample fractionally outside [-1, 1] — which a
 * resampler can produce — would otherwise wrap around and become a loud click
 * in the middle of a word.
 */
export function toPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff));
  }
  return pcm;
}

/**
 * One mono channel of samples as a complete WAV file.
 *
 * Deliberately the plainest possible header: 16-bit uncompressed PCM, one
 * channel, no extra chunks. The server's reader walks the chunks properly, but
 * the simplest file is the one least likely to be refused by anything else that
 * opens it.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = toPcm16(samples);
  const dataBytes = pcm.length * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // uncompressed PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE, pcm[i] ?? 0, true);
  }
  return bytes;
}

/** Seconds a WAV of this many samples will play for. */
export function wavSeconds(sampleCount: number, sampleRate = WAV_SAMPLE_RATE): number {
  return sampleCount / sampleRate;
}
