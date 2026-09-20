/**
 * Unit tests for the outbound-image path of the Telegram adapter.
 *
 * The logger is mocked the same way `adapter.test.ts` does it — `mock.module`
 * persists across files in one run, so every file in this directory has to agree
 * on what `@archon/paths` is.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InputFile } from 'grammy';
import { trackTempRoots } from '@archon/paths/test-utils';

const mockLogger = {
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
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { sendReferencedImages, type PhotoSender } from './outbound-images';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const trackTempRoot = trackTempRoots();

interface SentPhoto {
  chatId: number;
  photo: InputFile;
  caption: string | undefined;
}

function recorder(): { api: PhotoSender; sent: SentPhoto[] } {
  const sent: SentPhoto[] = [];
  const api: PhotoSender = {
    sendPhoto: async (chatId, photo, other) => {
      sent.push({ chatId, photo, caption: other?.caption });
      return { message_id: sent.length };
    },
  };
  return { api, sent };
}

describe('sendReferencedImages', () => {
  let project = '';

  beforeEach(async () => {
    const base = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-tg-images-')));
    project = join(await realpath(base), 'project');
    await mkdir(project, { recursive: true });
  });

  test('uploads the screenshots an answer lists, in the order it lists them', async () => {
    await writeFile(join(project, 'desktop.png'), PNG);
    await writeFile(join(project, 'mobile.png'), PNG);
    const { api, sent } = recorder();

    await sendReferencedImages(
      api,
      4242,
      `Файлы: ${join(project, 'desktop.png')}, ${join(project, 'mobile.png')}`,
      [project]
    );

    expect(sent.map(s => s.caption)).toEqual(['desktop.png', 'mobile.png']);
    expect(sent.every(s => s.chatId === 4242 && s.photo instanceof InputFile)).toBe(true);
  });

  test('captions a markdown image with its alt text', async () => {
    await writeFile(join(project, 'shot.png'), PNG);
    const { api, sent } = recorder();

    await sendReferencedImages(api, 1, `![the lobby](${join(project, 'shot.png')})`, [project]);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.caption).toBe('the lobby');
  });

  test('sends nothing for a path outside the allowed roots', async () => {
    const elsewhere = join(await realpath(trackTempRoot(mkdtempSync(join(tmpdir(), 'other-')))));
    await writeFile(join(elsewhere, 'shot.png'), PNG);
    const { api, sent } = recorder();

    await sendReferencedImages(api, 1, `see ${join(elsewhere, 'shot.png')}`, [project]);

    expect(sent).toHaveLength(0);
  });

  test('sends nothing when the install named no roots', async () => {
    await writeFile(join(project, 'shot.png'), PNG);
    const { api, sent } = recorder();

    await sendReferencedImages(api, 1, `see ${join(project, 'shot.png')}`, []);

    expect(sent).toHaveLength(0);
  });

  test('sends nothing for a file that is not really an image', async () => {
    await writeFile(join(project, 'phrase.png'), 'abandon abandon abandon');
    const { api, sent } = recorder();

    await sendReferencedImages(api, 1, `see ${join(project, 'phrase.png')}`, [project]);

    expect(sent).toHaveLength(0);
  });

  test('uploads a file named twice only once', async () => {
    await writeFile(join(project, 'shot.png'), PNG);
    const path = join(project, 'shot.png');
    const { api, sent } = recorder();

    await sendReferencedImages(api, 1, `${path} and again ${path}`, [project]);

    expect(sent).toHaveLength(1);
  });

  test('keeps going, and never throws, when one upload fails', async () => {
    await writeFile(join(project, 'a.png'), PNG);
    await writeFile(join(project, 'b.png'), PNG);
    const sent: string[] = [];
    const api: PhotoSender = {
      sendPhoto: async (_chatId, _photo, other) => {
        if (other?.caption === 'a.png') throw new Error('Bad Request: PHOTO_INVALID_DIMENSIONS');
        sent.push(other?.caption ?? '');
        return {};
      },
    };

    await sendReferencedImages(api, 1, `${join(project, 'a.png')} ${join(project, 'b.png')}`, [
      project,
    ]);

    expect(sent).toEqual(['b.png']);
  });

  test('does no filesystem work for an answer that names no image', async () => {
    const { api, sent } = recorder();
    await sendReferencedImages(api, 1, 'Done — the route is in app-api.js.', [project]);
    expect(sent).toHaveLength(0);
  });
});
