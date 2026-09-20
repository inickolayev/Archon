/**
 * What an audio file is, and whether it can be sent to the recogniser as it is.
 *
 * Yandex's short-recognition endpoint takes three containers — Ogg/Opus, MP3
 * and headerless little-endian PCM — one request at a time, up to thirty
 * seconds and a megabyte. Everything here answers two questions about a file
 * the operator sent: is this a recording at all, and can its bytes go straight
 * out, or does something have to convert them first.
 *
 * All of it is pure. Converting (which needs ffmpeg, which the image may not
 * have) lives next door in `ffmpeg.ts`; the fact that PCM can be cut into
 * chunks with nothing but arithmetic is what keeps a long dictation from the
 * browser working on a host with no ffmpeg at all.
 */

/** The three containers Yandex's short recognition accepts. */
export type YandexAudioFormat = 'oggopus' | 'lpcm' | 'mp3';

/** Yandex's ceiling for one short-recognition request. */
export const YANDEX_MAX_REQUEST_BYTES = 1024 * 1024;
/** Yandex's ceiling for one short-recognition request, in seconds. */
export const YANDEX_MAX_REQUEST_SECONDS = 30;
/** The sample rates Yandex accepts for raw PCM. */
const LPCM_SAMPLE_RATES = new Set([8000, 16000, 48000]);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

function baseMime(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * True for a file the operator sent as a recording rather than as a document.
 *
 * Deliberately wider than what the recogniser accepts: a `.m4a` from an iPhone
 * is a dictation whether or not this install can transcribe it, and saying so
 * is what lets the message admit it was spoken instead of arriving as a
 * nameless attachment.
 */
export function isVoiceUpload(mimeType: string, fileName: string): boolean {
  if (baseMime(mimeType).startsWith('audio/')) return true;
  return ['.ogg', '.oga', '.opus', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.webm'].includes(
    extensionOf(fileName)
  );
}

/**
 * The format to declare to Yandex for these bytes, or null when the container
 * has to be converted first.
 *
 * `.webm` is the interesting absence: it is what a Chrome `MediaRecorder`
 * produces, and Yandex will not take it. The console converts its recordings
 * to 16 kHz mono WAV before uploading precisely so this returns `lpcm`.
 */
export function yandexFormatOf(mimeType: string, fileName: string): YandexAudioFormat | null {
  const mime = baseMime(mimeType);
  const ext = extensionOf(fileName);
  if (mime === 'audio/ogg' || mime === 'audio/opus' || ['.ogg', '.oga', '.opus'].includes(ext)) {
    return 'oggopus';
  }
  if (mime === 'audio/mpeg' || mime === 'audio/mp3' || ext === '.mp3') return 'mp3';
  if (['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mime) || ext === '.wav') {
    return 'lpcm';
  }
  return null;
}

/** Raw samples lifted out of a WAV file, with what is needed to cut them up. */
export interface PcmAudio {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  /** The sample data alone — Yandex's `lpcm` wants no header in front of it. */
  readonly data: Uint8Array;
}

/**
 * Read a WAV file into the samples Yandex can be handed directly.
 *
 * Returns null for anything the recogniser would reject anyway — a compressed
 * payload wearing a WAV header, stereo, an unsupported sample rate, a truncated
 * file. Null means "this needs converting", never "this is broken": the caller
 * falls through to ffmpeg, and to an honest note when there is no ffmpeg.
 */
export function parseWav(bytes: Uint8Array): PcmAudio | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm: Uint8Array | null = null;

  // Chunks are walked rather than assumed at fixed offsets: recorders insert
  // `LIST`/`fact` chunks between `fmt ` and `data` often enough that a
  // hardcoded 44-byte header reads music as metadata.
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
      if (view.getUint16(body, true) !== 1) return null; // not uncompressed PCM
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      // A size field larger than the file is a truncated recording; take what
      // is actually there rather than reading past the end.
      pcm = bytes.subarray(body, Math.min(body + size, bytes.byteLength));
    }
    // Chunks are word-aligned: an odd size carries one padding byte.
    offset = body + size + (size % 2);
  }

  if (pcm === null || pcm.byteLength === 0) return null;
  if (channels !== 1 || bitsPerSample !== 16 || !LPCM_SAMPLE_RATES.has(sampleRate)) return null;
  return { sampleRate, channels, bitsPerSample, data: pcm };
}

/** Seconds of audio in a block of PCM. */
export function pcmDurationSec(pcm: PcmAudio): number {
  return pcm.data.byteLength / (pcm.sampleRate * pcm.channels * (pcm.bitsPerSample / 8));
}

export interface AudioChunks {
  readonly chunks: readonly Uint8Array[];
  /** The recording ran past the cap and only its start is in `chunks`. */
  readonly truncated: boolean;
  /** Length of the WHOLE recording, not of what was kept. */
  readonly totalDurationSec: number;
}

/**
 * Cut raw PCM into pieces the recogniser will take, one request each.
 *
 * Arithmetic, not ffmpeg: PCM has no frame structure to respect beyond the
 * sample boundary, so a chunk is a byte range. That is the whole reason the
 * console records WAV — a ten-minute dictation splits into twenty-odd requests
 * on a host with no media tooling installed at all.
 *
 * Anything past `maxTotalSeconds` is dropped and flagged rather than sent: the
 * operator is told what was kept, which is better than either a silent
 * truncation or losing the message for being too long.
 */
export function lpcmChunks(
  pcm: PcmAudio,
  chunkSeconds: number,
  maxTotalSeconds: number
): AudioChunks {
  const frameBytes = pcm.channels * (pcm.bitsPerSample / 8);
  const bytesPerSecond = pcm.sampleRate * frameBytes;
  const totalDurationSec = pcmDurationSec(pcm);

  // Never ask for more than one request can hold, whichever limit bites first.
  const perChunkSeconds = Math.max(
    1,
    Math.min(chunkSeconds, YANDEX_MAX_REQUEST_SECONDS, YANDEX_MAX_REQUEST_BYTES / bytesPerSecond)
  );
  const chunkBytes = Math.floor((perChunkSeconds * bytesPerSecond) / frameBytes) * frameBytes;

  const keptBytes = Math.min(
    pcm.data.byteLength,
    Math.floor((maxTotalSeconds * bytesPerSecond) / frameBytes) * frameBytes
  );
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < keptBytes; start += chunkBytes) {
    chunks.push(pcm.data.subarray(start, Math.min(start + chunkBytes, keptBytes)));
  }

  return { chunks, truncated: keptBytes < pcm.data.byteLength, totalDurationSec };
}
