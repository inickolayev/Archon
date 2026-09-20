import { describe, expect, test } from 'bun:test';
import {
  isVoiceUpload,
  lpcmChunks,
  parseWav,
  pcmDurationSec,
  yandexFormatOf,
  type PcmAudio,
} from './audio-format';

/** A WAV header the console's recorder produces: mono, 16 kHz, 16-bit. */
function wav(sampleBytes: number, options: { channels?: number; rate?: number; bits?: number } = {}): Uint8Array {
  const channels = options.channels ?? 1;
  const rate = options.rate ?? 16_000;
  const bits = options.bits ?? 16;
  const blockAlign = channels * (bits / 8);
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
  view.setUint16(20, 1, true); // uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  ascii(36, 'data');
  view.setUint32(40, sampleBytes, true);
  return bytes;
}

const ONE_SECOND_BYTES = 16_000 * 2;

describe('what counts as a recording', () => {
  test('anything audio, whatever this install can do with it', () => {
    expect(isVoiceUpload('audio/ogg', 'voice-abc.ogg')).toBe(true);
    expect(isVoiceUpload('audio/webm;codecs=opus', 'clip.webm')).toBe(true);
    expect(isVoiceUpload('', 'note.m4a')).toBe(true);
    expect(isVoiceUpload('image/png', 'shot.png')).toBe(false);
    expect(isVoiceUpload('text/plain', 'run.log')).toBe(false);
  });
});

describe('what can go to the recogniser as it is', () => {
  test('the three containers it takes', () => {
    expect(yandexFormatOf('audio/ogg', 'voice.ogg')).toBe('oggopus');
    expect(yandexFormatOf('', 'voice.opus')).toBe('oggopus');
    expect(yandexFormatOf('audio/mpeg', 'note.mp3')).toBe('mp3');
    expect(yandexFormatOf('audio/wav', 'clip.wav')).toBe('lpcm');
  });

  test('a browser webm needs converting first — which is why the console sends WAV', () => {
    expect(yandexFormatOf('audio/webm;codecs=opus', 'clip.webm')).toBeNull();
    expect(yandexFormatOf('audio/mp4', 'memo.m4a')).toBeNull();
  });
});

describe('reading a WAV', () => {
  test('lifts out the samples alone, with the rate to declare for them', () => {
    const pcm = parseWav(wav(ONE_SECOND_BYTES));

    expect(pcm).not.toBeNull();
    expect(pcm?.sampleRate).toBe(16_000);
    expect(pcm?.data.byteLength).toBe(ONE_SECOND_BYTES);
    expect(pcmDurationSec(pcm as PcmAudio)).toBe(1);
  });

  test('walks the chunks, so a LIST between fmt and data changes nothing', () => {
    const base = wav(ONE_SECOND_BYTES);
    const list = new Uint8Array(12);
    for (const [i, ch] of [...'LIST'].entries()) list[i] = ch.charCodeAt(0);
    new DataView(list.buffer).setUint32(4, 4, true);
    const withList = new Uint8Array(base.byteLength + list.byteLength);
    withList.set(base.subarray(0, 36));
    withList.set(list, 36);
    withList.set(base.subarray(36), 36 + list.byteLength);

    expect(parseWav(withList)?.data.byteLength).toBe(ONE_SECOND_BYTES);
  });

  test('refuses what the recogniser would refuse, so the converter gets a turn', () => {
    expect(parseWav(wav(1000, { channels: 2 }))).toBeNull();
    expect(parseWav(wav(1000, { rate: 44_100 }))).toBeNull();
    expect(parseWav(wav(1000, { bits: 8 }))).toBeNull();
    expect(parseWav(new Uint8Array(10))).toBeNull();
    expect(parseWav(new TextEncoder().encode('not a wav file at all, honestly'))).toBeNull();
  });

  test('a truncated file gives up the bytes it actually has', () => {
    const full = wav(ONE_SECOND_BYTES);
    const cut = full.subarray(0, 44 + 4_000);

    expect(parseWav(cut)?.data.byteLength).toBe(4_000);
  });
});

describe('cutting PCM into requests', () => {
  const pcm = (seconds: number): PcmAudio => ({
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16,
    data: new Uint8Array(seconds * ONE_SECOND_BYTES),
  });

  test('one chunk per configured span, the last one shorter', () => {
    const cut = lpcmChunks(pcm(60), 25, 600);

    expect(cut.chunks).toHaveLength(3);
    expect(cut.chunks[0]?.byteLength).toBe(25 * ONE_SECOND_BYTES);
    expect(cut.chunks[1]?.byteLength).toBe(25 * ONE_SECOND_BYTES);
    expect(cut.chunks[2]?.byteLength).toBe(10 * ONE_SECOND_BYTES);
    expect(cut.truncated).toBe(false);
    expect(cut.totalDurationSec).toBe(60);
  });

  test('nothing is lost between chunk boundaries', () => {
    const cut = lpcmChunks(pcm(60), 25, 600);
    const total = cut.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

    expect(total).toBe(60 * ONE_SECOND_BYTES);
  });

  test("a chunk never exceeds one request, whatever the configuration says", () => {
    // 28 s of 16 kHz PCM16 is 896 000 bytes — under the megabyte. Ask for more
    // and the request limit, not the setting, decides.
    const cut = lpcmChunks(pcm(120), 60, 600);

    for (const chunk of cut.chunks) expect(chunk.byteLength).toBeLessThanOrEqual(1024 * 1024);
  });

  test('past the cap the start is kept and the fact is flagged', () => {
    const cut = lpcmChunks(pcm(90), 25, 60);

    expect(cut.truncated).toBe(true);
    expect(cut.totalDurationSec).toBe(90);
    const kept = cut.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(kept).toBe(60 * ONE_SECOND_BYTES);
  });

  test('silence of no length at all yields nothing to recognise', () => {
    expect(lpcmChunks(pcm(0), 25, 600).chunks).toHaveLength(0);
  });
});
