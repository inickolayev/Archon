import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let mockArchonHome = '/tmp/archon-telegram-uploads-test';
mock.module('@archon/paths', () => ({
  getArchonHome: (): string => mockArchonHome,
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

import { persistTelegramFiles } from './telegram-uploads';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('persistTelegramFiles', () => {
  beforeEach(async () => {
    mockArchonHome = await mkdtemp(join(tmpdir(), 'archon-tg-uploads-'));
  });
  afterEach(async () => {
    await rm(mockArchonHome, { recursive: true, force: true });
  });

  test('a photo from the phone lands where a browser upload lands', async () => {
    const result = await persistTelegramFiles(
      '123456789:2',
      [{ fileId: 'f1', fileName: 'photo-abc.jpg', mimeType: 'image/jpeg', size: 5 }],
      async () => bytes('jpeg!')
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]?.name).toBe('photo-abc.jpg');
    expect(result.uploadDir).toContain(join('artifacts', 'uploads'));
    expect(await readFile(result.savedFiles[0]?.path ?? '', 'utf8')).toBe('jpeg!');
  });

  test('a hostile filename is sanitised before it touches the disk', async () => {
    const result = await persistTelegramFiles(
      'c1',
      [{ fileId: 'f1', fileName: '../../../etc/passwd', mimeType: 'text/plain', size: 2 }],
      async () => bytes('hi')
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.savedFiles[0]?.name).toBe('passwd');
    expect(result.savedFiles[0]?.path.startsWith(result.uploadDir)).toBe(true);
  });

  test('an oversized file is refused without being downloaded', async () => {
    let downloads = 0;
    const result = await persistTelegramFiles(
      'c1',
      [{ fileId: 'f1', fileName: 'huge.jpg', mimeType: 'image/jpeg', size: 11 * 1024 * 1024 }],
      async () => {
        downloads += 1;
        return bytes('never');
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('10 MB');
    expect(downloads).toBe(0);
  });

  test('too many files in one message are refused with the limit named', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      fileId: `f${String(i)}`,
      fileName: `f${String(i)}.jpg`,
      mimeType: 'image/jpeg',
    }));
    const result = await persistTelegramFiles('c1', many, async () => bytes('x'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('5');
  });

  test('an unsupported type is refused by the same rules the browser path uses', async () => {
    const result = await persistTelegramFiles(
      'c1',
      [{ fileId: 'f1', fileName: 'thing.zip', mimeType: 'application/zip', size: 3 }],
      async () => bytes('zip')
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unsupported type');
  });

  test('a download failure is reported, and no URL (which carries the token) leaks', async () => {
    const result = await persistTelegramFiles(
      'c1',
      [{ fileId: 'f1', fileName: 'a.txt', mimeType: 'text/plain', size: 3 }],
      async () => {
        throw new Error('Downloading that file from Telegram failed.');
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('Downloading that file from Telegram failed.');
    expect(result.error).not.toContain('api.telegram.org');
    expect(result.error).not.toContain('bot');
  });

  test('no files is not an error — a plain text message still goes through', async () => {
    const result = await persistTelegramFiles('c1', [], async () => bytes(''));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.savedFiles).toEqual([]);
  });
});
