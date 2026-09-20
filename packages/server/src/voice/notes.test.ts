import { describe, expect, test } from 'bun:test';
import { dictationNote, durationLabel, type NoteInput } from './notes';

const BASE: NoteInput = {
  outcome: 'transcribed',
  durationSec: 42,
  truncated: false,
  cleaned: true,
  maxDurationSec: 600,
  explainSetup: false,
};

describe('how long it was', () => {
  test('minutes and seconds, zero-padded', () => {
    expect(durationLabel(42)).toBe('0:42');
    expect(durationLabel(65)).toBe('1:05');
    expect(durationLabel(725)).toBe('12:05');
  });

  test('nothing at all when the platform never said', () => {
    expect(durationLabel(null)).toBe('');
    expect(durationLabel(Number.NaN)).toBe('');
  });
});

describe('what the marker says', () => {
  test('the ordinary case names the length and that it was tidied up', () => {
    expect(dictationNote(BASE)).toBe('0:42, transcribed and tidied up');
  });

  test('a failed tidy-up is admitted in the message itself', () => {
    expect(dictationNote({ ...BASE, cleaned: false })).toContain('raw transcript');
  });

  test('a truncated recording says how much of it was read, and where the rest is', () => {
    const note = dictationNote({ ...BASE, durationSec: 930, truncated: true });

    expect(note).toContain('15:30');
    expect(note).toContain('first 10:00');
    expect(note).toContain('attached recording');
  });

  test('silence says nothing was recognised, not that something broke', () => {
    expect(dictationNote({ ...BASE, outcome: 'silent', durationSec: 3 })).toBe(
      '0:03, nothing was recognised in it'
    );
  });

  test('missing keys are spelled out once, then named briefly', () => {
    const first = dictationNote({ ...BASE, outcome: 'no_credentials', explainSetup: true });
    const later = dictationNote({ ...BASE, outcome: 'no_credentials' });

    expect(first).toContain('YANDEX_STT_API_KEY');
    expect(first).toContain('YANDEX_STT_FOLDER_ID');
    expect(later).toContain('no speech-recognition keys');
    expect(later).not.toContain('YANDEX_STT_API_KEY');
  });

  test('a missing converter says what to do about it, once', () => {
    const first = dictationNote({ ...BASE, outcome: 'cannot_convert', explainSetup: true });

    expect(first).toContain('ffmpeg');
    expect(dictationNote({ ...BASE, outcome: 'cannot_convert' })).toContain('ffmpeg');
  });

  test('a recogniser failure never blames the operator', () => {
    expect(dictationNote({ ...BASE, outcome: 'failed' })).toBe(
      '0:42, not transcribed: speech recognition failed'
    );
  });

  test('an unknown length simply goes unmentioned', () => {
    expect(dictationNote({ ...BASE, durationSec: null })).toBe('transcribed and tidied up');
  });
});
