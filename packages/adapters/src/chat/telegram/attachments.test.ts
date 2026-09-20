import { describe, expect, test } from 'bun:test';
import {
  carriesRecording,
  defaultCaption,
  filesOf,
  largestPhoto,
  recordingDurationOf,
  unsupportedKindOf,
  unsupportedMessage,
  type TelegramMessageLike,
} from './attachments';

describe('largestPhoto', () => {
  test('takes the biggest size, not the first one listed', () => {
    const chosen = largestPhoto([
      { file_id: 'thumb', file_size: 1_200, width: 90 },
      { file_id: 'full', file_size: 240_000, width: 1280 },
      { file_id: 'medium', file_size: 40_000, width: 320 },
    ]);
    expect(chosen?.file_id).toBe('full');
  });

  test('falls back to width when Telegram omits the size', () => {
    const chosen = largestPhoto([
      { file_id: 'small', width: 90 },
      { file_id: 'big', width: 1280 },
    ]);
    expect(chosen?.file_id).toBe('big');
  });

  test('is null for no sizes at all', () => {
    expect(largestPhoto([])).toBeNull();
  });
});

describe('filesOf', () => {
  test('a document keeps its name and type', () => {
    const message: TelegramMessageLike = {
      document: {
        file_id: 'doc-1',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
        file_size: 4096,
      },
    };
    expect(filesOf(message)).toEqual([
      { fileId: 'doc-1', fileName: 'report.pdf', mimeType: 'application/pdf', size: 4096 },
    ]);
  });

  test('a photo has neither, so it gets a generated jpeg name', () => {
    const files = filesOf({ photo: [{ file_id: 'AgACAgIAAxk', file_size: 120_000, width: 1280 }] });
    expect(files).toHaveLength(1);
    expect(files[0]?.mimeType).toBe('image/jpeg');
    expect(files[0]?.fileName).toMatch(/^photo-[\w-]+\.jpg$/);
  });

  test('an image sent as a document stays a document', () => {
    const files = filesOf({
      document: { file_id: 'd', file_name: 'screenshot.png', mime_type: 'image/png' },
    });
    expect(files[0]?.fileName).toBe('screenshot.png');
    expect(files[0]?.mimeType).toBe('image/png');
  });

  test('a plain text message carries no files', () => {
    expect(filesOf({ text: 'hello' })).toEqual([]);
  });

  test('a voice note is a file, named for what its bytes actually are', () => {
    const files = filesOf({ voice: { file_id: 'AwACAgIAAx', file_size: 9_400, duration: 7 } });
    expect(files).toHaveLength(1);
    expect(files[0]?.mimeType).toBe('audio/ogg');
    // The extension is what tells the transcriber the bytes can go to the
    // recogniser untouched, so it is pinned rather than left to chance.
    expect(files[0]?.fileName).toMatch(/^voice-[\w-]+\.ogg$/);
  });

  test('an audio file keeps the name and type it was sent with', () => {
    const files = filesOf({
      audio: { file_id: 'a-1', file_name: 'note.mp3', mime_type: 'audio/mpeg', duration: 95 },
    });
    expect(files[0]).toEqual({
      fileId: 'a-1',
      fileName: 'note.mp3',
      mimeType: 'audio/mpeg',
      size: undefined,
    });
  });
});

describe('recordings', () => {
  test('voice and audio are recordings; a photo is not', () => {
    expect(carriesRecording({ voice: { file_id: 'v' } })).toBe(true);
    expect(carriesRecording({ audio: { file_id: 'a' } })).toBe(true);
    expect(carriesRecording({ photo: [{ file_id: 'p' }] })).toBe(false);
  });

  test('the length Telegram measured is passed on rather than probed for', () => {
    expect(recordingDurationOf({ voice: { file_id: 'v', duration: 42 } })).toBe(42);
    expect(recordingDurationOf({ audio: { file_id: 'a', duration: 610 } })).toBe(610);
    expect(recordingDurationOf({ text: 'hello' })).toBeUndefined();
  });
});

describe('unsupported media', () => {
  test('names what it cannot read', () => {
    expect(unsupportedKindOf({ video_note: {} })).toBe('video note');
    expect(unsupportedKindOf({ sticker: {} })).toBe('sticker');
    expect(unsupportedKindOf({ video: {} })).toBe('video');
    expect(unsupportedKindOf({ animation: {} })).toBe('animation');
  });

  test('a recording is no longer unsupported — it is transcribed', () => {
    expect(unsupportedKindOf({ voice: { file_id: 'v' } })).toBeNull();
    expect(unsupportedKindOf({ audio: { file_id: 'a' } })).toBeNull();
  });

  test('a photo or a document is not unsupported', () => {
    expect(unsupportedKindOf({ photo: [{ file_id: 'p' }] })).toBeNull();
    expect(unsupportedKindOf({ document: { file_id: 'd' } })).toBeNull();
  });

  test('the reply says what to send instead, in one line', () => {
    const line = unsupportedMessage('sticker');
    expect(line).toContain("can't read a sticker");
    expect(line).toContain('voice message');
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('defaultCaption', () => {
  test('names a single file so the agent knows what arrived', () => {
    expect(
      defaultCaption([{ fileId: 'a', fileName: 'error-log.txt', mimeType: 'text/plain' }])
    ).toContain('error-log.txt');
  });

  test('counts several', () => {
    expect(
      defaultCaption([
        { fileId: 'a', fileName: 'one.jpg' },
        { fileId: 'b', fileName: 'two.jpg' },
        { fileId: 'c', fileName: 'three.jpg' },
      ])
    ).toContain('3 files');
  });

  test('is never empty — an empty turn gives the agent nothing to act on', () => {
    expect(defaultCaption([]).length).toBeGreaterThan(0);
    expect(defaultCaption([{ fileId: 'a' }]).length).toBeGreaterThan(0);
  });
});
