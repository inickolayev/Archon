/**
 * Cutting a recording into pieces the recogniser will take, with ffmpeg.
 *
 * The approach is the manager-bot's, including the part that is easy to get
 * wrong: the input is written to a seekable temp file first, because piping a
 * container that needs seeking (ogg, mp4, webm) through stdin makes ffprobe
 * report no duration at all, and a chunk loop with no duration to stop at runs
 * until the cap.
 *
 * ffmpeg is OPTIONAL here, which it is not in the manager-bot. This image ships
 * without it, so every entry point asks `ffmpegAvailable()` first and the
 * caller degrades to what needs no conversion — a short clip sent as it is, or
 * raw PCM cut up with arithmetic. A recording that genuinely needs ffmpeg on a
 * host without it is attached and said to be untranscribed, never silently
 * dropped.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import type { AudioChunks } from './audio-format';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.voice.ffmpeg');
  return cachedLog;
}

/** Runs one ffmpeg/ffprobe invocation. Injected so tests never spawn anything. */
export interface FfmpegRunner {
  run(binary: 'ffmpeg' | 'ffprobe', args: readonly string[]): Promise<Uint8Array>;
}

export const defaultFfmpegRunner: FfmpegRunner = {
  run(binary, args) {
    return new Promise<Uint8Array>((resolve, reject) => {
      const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) {
          resolve(new Uint8Array(Buffer.concat(out)));
          return;
        }
        reject(
          new Error(
            `${binary} exited with code ${String(code)}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`
          )
        );
      });
    });
  },
};

/**
 * Whether this host can convert audio at all, asked once per process.
 *
 * Cached because the answer cannot change without a restart (the binary is part
 * of the image) and because the question is on the path of every voice message.
 */
let availability: Promise<boolean> | null = null;
export function ffmpegAvailable(runner: FfmpegRunner = defaultFfmpegRunner): Promise<boolean> {
  availability ??= runner
    .run('ffmpeg', ['-hide_banner', '-version'])
    .then(() => true)
    .catch(() => {
      getLog().info('voice.ffmpeg_absent');
      return false;
    });
  return availability;
}

/** Test seam: forget what was probed. Never called in production. */
export function resetFfmpegAvailabilityForTests(): void {
  availability = null;
}

const OGG_OPUS_ARGS = (inputPath: string, startSec: number, durationSec: number): string[] => [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  // Before `-i`, so the seek happens on the input and ffmpeg does not decode
  // everything up to `startSec` for each chunk.
  '-ss',
  String(startSec),
  '-t',
  String(durationSec),
  '-i',
  inputPath,
  '-vn',
  // A video note carries a camera and a location in its metadata; none of that
  // belongs in a request to a transcription service.
  '-map_metadata',
  '-1',
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'libopus',
  '-b:a',
  '24k',
  '-f',
  'ogg',
  'pipe:1',
];

const PROBE_ARGS = (inputPath: string): string[] => [
  '-hide_banner',
  '-loglevel',
  'error',
  '-print_format',
  'json',
  '-show_format',
  '-i',
  inputPath,
];

async function probeDurationSec(
  inputPath: string,
  runner: FfmpegRunner
): Promise<number | null> {
  try {
    const out = await runner.run('ffprobe', PROBE_ARGS(inputPath));
    const parsed = JSON.parse(Buffer.from(out).toString('utf8')) as {
      format?: { duration?: string };
    };
    const seconds = Number(parsed.format?.duration ?? NaN);
    return Number.isFinite(seconds) ? seconds : null;
  } catch (err) {
    getLog().warn({ err }, 'voice.ffprobe_failed');
    return null;
  }
}

async function withTempFile<T>(
  input: Uint8Array,
  fn: (path: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-voice-'));
  const file = join(dir, `${randomUUID()}.bin`);
  await writeFile(file, input);
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      getLog().warn({ err }, 'voice.temp_cleanup_failed');
    });
  }
}

/**
 * Re-encode a recording into mono 16 kHz Ogg/Opus chunks of `chunkSeconds`.
 *
 * Anything past `maxTotalSeconds` is left behind and flagged rather than sent.
 * When ffprobe cannot say how long the input is, the cap becomes the length —
 * the loop then stops on the first empty chunk, which is what running off the
 * end of the file produces.
 */
export async function splitIntoOggChunks(
  input: Uint8Array,
  options: { chunkSeconds: number; maxTotalSeconds: number },
  runner: FfmpegRunner = defaultFfmpegRunner
): Promise<AudioChunks> {
  return withTempFile(input, async inputPath => {
    const probed = await probeDurationSec(inputPath, runner);
    const effectiveTotal = probed === null ? options.maxTotalSeconds : Math.min(probed, options.maxTotalSeconds);
    const truncated = probed !== null && probed > options.maxTotalSeconds;

    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < effectiveTotal) {
      const take = Math.min(options.chunkSeconds, effectiveTotal - offset);
      const chunk = await runner.run('ffmpeg', OGG_OPUS_ARGS(inputPath, offset, take));
      if (chunk.byteLength > 0) chunks.push(chunk);
      offset += take;
      if (probed === null && chunk.byteLength === 0) break;
    }

    return { chunks, truncated, totalDurationSec: probed ?? offset };
  });
}
