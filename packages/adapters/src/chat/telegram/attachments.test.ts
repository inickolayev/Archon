import { describe, expect, test } from 'bun:test';
import {
  defaultCaption,
  filesOf,
  largestPhoto,
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
});

describe('unsupported media', () => {
  test('names what it cannot read', () => {
    expect(unsupportedKindOf({ voice: {} })).toBe('voice');
    expect(unsupportedKindOf({ video_note: {} })).toBe('video note');
    expect(unsupportedKindOf({ sticker: {} })).toBe('sticker');
    expect(unsupportedKindOf({ audio: {} })).toBe('audio');
    expect(unsupportedKindOf({ video: {} })).toBe('video');
    expect(unsupportedKindOf({ animation: {} })).toBe('animation');
  });

  test('a photo or a document is not unsupported', () => {
    expect(unsupportedKindOf({ photo: [{ file_id: 'p' }] })).toBeNull();
    expect(unsupportedKindOf({ document: { file_id: 'd' } })).toBeNull();
  });

  test('the reply says what to send instead, in one line', () => {
    const line = unsupportedMessage('voice');
    expect(line).toContain("can't read a voice");
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
