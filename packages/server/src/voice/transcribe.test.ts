import { describe, expect, test } from 'bun:test';
import { voiceConfig } from './config';
import { transcribe, type Recording, type TranscribeDeps } from './transcribe';
import type { AudioChunks } from './audio-format';

const CONFIG = voiceConfig({});
const CREDENTIALS = { apiKey: 'test-key', folderId: 'test-folder' };

/** Mono 16 kHz 16-bit WAV of `seconds` of silence. */
function wav(seconds: number): Uint8Array {
  const sampleBytes = seconds * 16_000 * 2;
  const bytes = new Uint8Array(44 + sampleBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + sampleBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, sampleBytes, true);
  return bytes;
}

const VOICE_NOTE: Recording = {
  bytes: new Uint8Array(40_000),
  mimeType: 'audio/ogg',
  fileName: 'voice-abc.ogg',
  durationSec: 12,
};

/** A recogniser that numbers the chunks it is handed, so order is provable. */
function counting(): { recognize: NonNullable<TranscribeDeps['recognize']>; calls: number[] } {
  const calls: number[] = [];
  let index = 0;
  const recognize: NonNullable<TranscribeDeps['recognize']> = async chunk => {
    const mine = index++;
    calls.push(chunk.byteLength);
    // Finish out of order on purpose: the joined text must still be in order.
    await new Promise(resolve => setTimeout(resolve, mine % 2 === 0 ? 4 : 1));
    return `part${String(mine)}`;
  };
  return { recognize, calls };
}

describe('with no speech-recognition keys', () => {
  test('nothing is attempted and the reason is said plainly', async () => {
    const result = await transcribe(VOICE_NOTE, {
      credentials: null,
      config: CONFIG,
      recognize: () => {
        throw new Error('must not be called without credentials');
      },
    });

    expect(result).toEqual({ kind: 'unavailable', reason: 'no_credentials' });
  });
});

describe('a clip that fits one request', () => {
  test('goes out as the bytes arrived — no conversion, no ffmpeg', async () => {
    const seen: { bytes: number; format: string }[] = [];
    const result = await transcribe(VOICE_NOTE, {
      credentials: CREDENTIALS,
      config: CONFIG,
      hasFfmpeg: () => {
        throw new Error('ffmpeg must not even be looked for');
      },
      recognize: async (chunk, options) => {
        seen.push({ bytes: chunk.byteLength, format: options.format });
        return 'привет';
      },
    });

    expect(result).toEqual({
      kind: 'transcribed',
      text: 'привет',
      truncated: false,
      totalDurationSec: 12,
    });
    expect(seen).toEqual([{ bytes: 40_000, format: 'oggopus' }]);
  });

  test('a recording with nothing in it is silent, not failed', async () => {
    const result = await transcribe(VOICE_NOTE, {
      credentials: CREDENTIALS,
      config: CONFIG,
      recognize: async () => '',
    });

    expect(result).toEqual({ kind: 'silent', totalDurationSec: 12 });
  });
});

describe('a long recording', () => {
  test('WAV is cut up and rejoined in order, with no ffmpeg anywhere', async () => {
    const { recognize, calls } = counting();
    const result = await transcribe(
      { bytes: wav(60), mimeType: 'audio/wav', fileName: 'recording.wav' },
      {
        credentials: CREDENTIALS,
        config: CONFIG,
        hasFfmpeg: () => {
          throw new Error('WAV must never need ffmpeg');
        },
        recognize,
      }
    );

    expect(calls).toHaveLength(3);
    expect(result).toEqual({
      kind: 'transcribed',
      text: 'part0 part1 part2',
      truncated: false,
      totalDurationSec: 60,
    });
  });

  test('past the cap, the start is transcribed and the fact travels with it', async () => {
    const result = await transcribe(
      { bytes: wav(90), mimeType: 'audio/wav', fileName: 'long.wav' },
      {
        credentials: CREDENTIALS,
        config: { ...CONFIG, VOICE_MAX_DURATION_SEC: 50 },
        recognize: async () => 'кусок',
      }
    );

    expect(result.kind).toBe('transcribed');
    if (result.kind !== 'transcribed') return;
    expect(result.truncated).toBe(true);
    expect(result.totalDurationSec).toBe(90);
  });

  test('one chunk failing for good stops its peers rather than burning quota', async () => {
    let started = 0;
    const result = await transcribe(
      { bytes: wav(120), mimeType: 'audio/wav', fileName: 'long.wav' },
      {
        credentials: CREDENTIALS,
        config: CONFIG,
        recognize: async () => {
          started++;
          await new Promise(resolve => setTimeout(resolve, 1));
          throw new Error('speech recognition refused the audio');
        },
      }
    );

    expect(result.kind).toBe('failed');
    // Five chunks, four workers: the fifth is never picked up once the first
    // failure aborts the shared signal.
    expect(started).toBeLessThan(5);
  });
});

describe('a recording that has to be converted', () => {
  test('is converted when ffmpeg is there', async () => {
    const converted: AudioChunks = {
      chunks: [new Uint8Array(10), new Uint8Array(10)],
      truncated: false,
      totalDurationSec: 40,
    };
    const result = await transcribe(
      { bytes: new Uint8Array(5_000), mimeType: 'audio/webm;codecs=opus', fileName: 'clip.webm' },
      {
        credentials: CREDENTIALS,
        config: CONFIG,
        hasFfmpeg: async () => true,
        convert: async () => converted,
        recognize: async () => 'слово',
      }
    );

    expect(result).toEqual({
      kind: 'transcribed',
      text: 'слово слово',
      truncated: false,
      totalDurationSec: 40,
    });
  });

  test('says so, rather than failing, when ffmpeg is not installed', async () => {
    const result = await transcribe(
      { bytes: new Uint8Array(5_000), mimeType: 'audio/webm;codecs=opus', fileName: 'clip.webm' },
      {
        credentials: CREDENTIALS,
        config: CONFIG,
        hasFfmpeg: async () => false,
        recognize: () => {
          throw new Error('nothing can be recognised without a conversion');
        },
      }
    );

    expect(result).toEqual({ kind: 'unavailable', reason: 'cannot_convert' });
  });

  test('a voice note longer than one request needs it too', async () => {
    const result = await transcribe(
      { ...VOICE_NOTE, durationSec: 95 },
      { credentials: CREDENTIALS, config: CONFIG, hasFfmpeg: async () => false }
    );

    expect(result).toEqual({ kind: 'unavailable', reason: 'cannot_convert' });
  });
});
