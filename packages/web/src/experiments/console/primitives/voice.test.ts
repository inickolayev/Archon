import { describe, expect, test } from 'bun:test';
import {
  MAX_RECORDING_SECONDS,
  WAV_SAMPLE_RATE,
  clockLabel,
  encodeWav,
  recordingFileName,
  toPcm16,
} from './voice';

describe('the recording limit', () => {
  test('fits inside the 10 MB an attachment may be', () => {
    // 16 kHz mono PCM16 is 32 000 bytes a second; the cap has to leave the
    // whole clip under the upload limit or a long dictation is refused at the
    // very end of being spoken.
    const bytes = 44 + MAX_RECORDING_SECONDS * WAV_SAMPLE_RATE * 2;

    expect(bytes).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('the clock', () => {
  test('reads the same way the message marker does', () => {
    expect(clockLabel(0)).toBe('0:00');
    expect(clockLabel(42)).toBe('0:42');
    expect(clockLabel(65)).toBe('1:05');
    expect(clockLabel(MAX_RECORDING_SECONDS)).toBe('5:00');
  });
});

describe('naming the clip', () => {
  test('sorts by when it was said and survives the server renaming it', () => {
    const name = recordingFileName(new Date('2026-09-20T12:34:56.789Z'));

    expect(name).toBe('voice-2026-09-20T12-34-56-789.wav');
    // The server keeps only [A-Za-z0-9._-]; anything else becomes an underscore.
    expect(name).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});

describe('samples as 16-bit PCM', () => {
  test('full scale in both directions, and silence in the middle', () => {
    const pcm = toPcm16(new Float32Array([0, 1, -1, 0.5]));

    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 16384]);
  });

  test('a sample past full scale is clamped, not wrapped into a click', () => {
    const pcm = toPcm16(new Float32Array([1.4, -1.4]));

    expect(Array.from(pcm)).toEqual([32767, -32768]);
  });
});

describe('the WAV that goes to the recogniser', () => {
  const wav = encodeWav(new Float32Array(WAV_SAMPLE_RATE), WAV_SAMPLE_RATE);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(...Array.from(wav.subarray(offset, offset + 4)));

  test('is a RIFF/WAVE file of uncompressed mono 16-bit samples', () => {
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(WAV_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
  });

  test('declares exactly the bytes it carries', () => {
    expect(tag(36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(WAV_SAMPLE_RATE * 2);
    expect(wav.byteLength).toBe(44 + WAV_SAMPLE_RATE * 2);
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
  });
});
