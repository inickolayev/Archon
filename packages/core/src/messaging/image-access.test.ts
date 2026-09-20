import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { MAX_OUTBOUND_IMAGE_BYTES, outboundImageRoots, resolveOutboundImage } from './image-access';

const bytesOf = (text: string): number[] => Array.from(text, c => c.charCodeAt(0));

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const GIF_HEADER = bytesOf('GIF89a');
const WEBP_HEADER = [...bytesOf('RIFF'), 0, 0, 0, 0, ...bytesOf('WEBP')];

const trackTempRoot = trackTempRoots();

/** A project root and a sibling directory the project must not be able to reach. */
async function fixture(): Promise<{ project: string; outside: string }> {
  const base = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-outbound-image-')));
  // Roots are compared as real paths and these tests build paths by hand — on
  // macOS `tmpdir()` is itself a symlink, so a raw join would never match.
  const real = await realpath(base);
  const project = join(real, 'project');
  const outside = join(real, 'outside');
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { project, outside };
}

async function writeImage(path: string, header: readonly number[], padding = 0): Promise<string> {
  await writeFile(path, Buffer.concat([Buffer.from(header), Buffer.alloc(padding)]));
  return path;
}

describe('outboundImageRoots', () => {
  test('always includes the system temp directory — where a screenshot lands', () => {
    expect(outboundImageRoots([])).toEqual([tmpdir()]);
  });

  test('keeps the named directories and drops the empty and relative ones', () => {
    const roots = outboundImageRoots(['/srv/project', null, undefined, '', 'relative/path']);
    expect(roots).toEqual(['/srv/project', tmpdir()]);
  });

  test('never repeats a root', () => {
    expect(outboundImageRoots([tmpdir(), tmpdir()])).toEqual([tmpdir()]);
  });
});

describe('resolveOutboundImage — what it allows', () => {
  let project = '';

  beforeEach(async () => {
    ({ project } = await fixture());
  });

  test('a real PNG inside an allowed root, reported by its header', async () => {
    const path = await writeImage(join(project, 'shot.png'), PNG_HEADER);
    expect(await resolveOutboundImage(path, [project])).toMatchObject({
      ok: true,
      path,
      mediaType: 'image/png',
    });
  });

  test('a file nested below the root', async () => {
    await mkdir(join(project, 'deep', 'deeper'), { recursive: true });
    const path = await writeImage(join(project, 'deep', 'deeper', 'shot.png'), PNG_HEADER);
    expect(await resolveOutboundImage(path, [project])).toMatchObject({ ok: true });
  });

  test('every raster format the chat surfaces render', async () => {
    const cases = [
      ['a.jpg', JPEG_HEADER, 'image/jpeg'],
      ['a.gif', GIF_HEADER, 'image/gif'],
      ['a.webp', WEBP_HEADER, 'image/webp'],
    ] as const;
    for (const [name, header, mediaType] of cases) {
      const path = await writeImage(join(project, name), header);
      expect(await resolveOutboundImage(path, [project])).toMatchObject({ ok: true, mediaType });
    }
  });
});

describe('resolveOutboundImage — what it refuses', () => {
  let project = '';
  let outside = '';

  beforeEach(async () => {
    ({ project, outside } = await fixture());
  });

  test('a path outside every allowed root', async () => {
    const path = await writeImage(join(outside, 'shot.png'), PNG_HEADER);
    expect(await resolveOutboundImage(path, [project])).toEqual({
      ok: false,
      reason: 'outside_allowed_roots',
    });
  });

  test('a symlink that sits inside a root but points out of it', async () => {
    const target = await writeImage(join(outside, 'secret.png'), PNG_HEADER);
    const link = join(project, 'innocent.png');
    await symlink(target, link);
    expect(await resolveOutboundImage(link, [project])).toEqual({
      ok: false,
      reason: 'outside_allowed_roots',
    });
  });

  test('a traversal that climbs out of the root', async () => {
    await writeImage(join(outside, 'escape.png'), PNG_HEADER);
    const climbing = join(project, '..', 'outside', 'escape.png');
    expect(await resolveOutboundImage(climbing, [project])).toEqual({
      ok: false,
      reason: 'outside_allowed_roots',
    });
  });

  test('a seed phrase, even renamed to look like a picture', async () => {
    // The standing rule this protects: `ton_*_phrase.txt` in the ChessWin
    // checkout must never leave the machine. It lives inside the project root,
    // so the root check alone would admit it — the header is what refuses it.
    const path = join(project, 'ton_main_phrase.png');
    await writeFile(path, 'abandon abandon abandon ability able about above absent');
    expect(await resolveOutboundImage(path, [project])).toEqual({
      ok: false,
      reason: 'not_an_image',
    });
  });

  test('a text file under its own name, before any filesystem work', async () => {
    const path = join(project, 'ton_main_phrase.txt');
    await writeFile(path, 'abandon abandon abandon');
    expect(await resolveOutboundImage(path, [project])).toEqual({
      ok: false,
      reason: 'unsupported_extension',
    });
  });

  test('an SVG, which the extension allowlist never admits', async () => {
    const path = join(project, 'diagram.svg');
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(await resolveOutboundImage(path, [project])).toEqual({
      ok: false,
      reason: 'unsupported_extension',
    });
  });

  test('a relative path', async () => {
    expect(await resolveOutboundImage('shots/a.png', [project])).toEqual({
      ok: false,
      reason: 'not_absolute',
    });
  });

  test('a path that names nothing', async () => {
    expect(await resolveOutboundImage(join(project, 'absent.png'), [project])).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  test('a directory that happens to be named like an image', async () => {
    const path = join(project, 'shots.png');
    await mkdir(path, { recursive: true });
    expect(await resolveOutboundImage(path, [project])).toEqual({
      ok: false,
      reason: 'not_a_file',
    });
  });

  test('a file past the size Telegram accepts', async () => {
    const path = join(project, 'huge.png');
    await writeImage(path, PNG_HEADER, MAX_OUTBOUND_IMAGE_BYTES);
    expect(await resolveOutboundImage(path, [project])).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  test('anything at all when no root is allowed', async () => {
    const path = await writeImage(join(project, 'rootless.png'), PNG_HEADER);
    expect(await resolveOutboundImage(path, [])).toEqual({
      ok: false,
      reason: 'outside_allowed_roots',
    });
  });

  test('a root that does not exist contains nothing', async () => {
    const path = await writeImage(join(project, 'ghost-root.png'), PNG_HEADER);
    expect(await resolveOutboundImage(path, [join(project, 'no-such-dir')])).toEqual({
      ok: false,
      reason: 'outside_allowed_roots',
    });
  });
});
