import { describe, test, expect } from 'bun:test';
import { MAX_IMAGE_REFERENCES, imageReferenceName, parseImageReferences } from './image-references';

describe('parseImageReferences', () => {
  test('reads the bare paths an agent writes after a screenshot', () => {
    const text = 'Файлы: /tmp/devshot/desktop.png, /tmp/devshot/mobile.png';
    expect(parseImageReferences(text)).toEqual([
      { path: '/tmp/devshot/desktop.png', caption: 'desktop.png' },
      { path: '/tmp/devshot/mobile.png', caption: 'mobile.png' },
    ]);
  });

  test('takes the alt text of a markdown image as its caption', () => {
    expect(parseImageReferences('![the lobby at 393px](/tmp/shot.png)')).toEqual([
      { path: '/tmp/shot.png', caption: 'the lobby at 393px' },
    ]);
  });

  test('ignores a markdown title and angle brackets around the path', () => {
    expect(parseImageReferences('![alt](</tmp/a.png> "a title")')).toEqual([
      { path: '/tmp/a.png', caption: 'alt' },
    ]);
  });

  test('keeps the order of first mention and drops repeats', () => {
    const text = '/tmp/b.png then /tmp/a.png then /tmp/b.png again';
    expect(parseImageReferences(text).map(r => r.path)).toEqual(['/tmp/b.png', '/tmp/a.png']);
  });

  test('separates a comma-joined list with no spaces', () => {
    expect(parseImageReferences('/tmp/a.png,/tmp/b.png').map(r => r.path)).toEqual([
      '/tmp/a.png',
      '/tmp/b.png',
    ]);
  });

  test('leaves the sentence punctuation that follows a path out of it', () => {
    expect(parseImageReferences('Look at /tmp/a.png.').map(r => r.path)).toEqual(['/tmp/a.png']);
    expect(parseImageReferences('(see /tmp/a.png)').map(r => r.path)).toEqual(['/tmp/a.png']);
  });

  test('matches the extension case-insensitively', () => {
    expect(parseImageReferences('/tmp/A.PNG').map(r => r.path)).toEqual(['/tmp/A.PNG']);
  });

  test('finds nothing in text that names no image', () => {
    expect(parseImageReferences('Done. See src/app/server.js for the route.')).toEqual([]);
  });

  test('ignores a remote URL — only local paths become pictures', () => {
    expect(parseImageReferences('https://example.com/a.png')).toEqual([]);
  });

  test('ignores a relative path: there is no directory to resolve it against', () => {
    expect(parseImageReferences('see shots/a.png')).toEqual([]);
  });

  test('ignores a non-image extension, including one that only looks like an image', () => {
    expect(parseImageReferences('/repo/ton_main_phrase.txt /repo/notes.png.txt')).toEqual([]);
  });

  test('stops at the cap so a listing cannot become a burst of photos', () => {
    const text = Array.from({ length: 25 }, (_, i) => `/tmp/shot-${String(i)}.png`).join(' ');
    expect(parseImageReferences(text)).toHaveLength(MAX_IMAGE_REFERENCES);
  });
});

describe('imageReferenceName', () => {
  test('is the last path segment', () => {
    expect(imageReferenceName('/tmp/devshot/desktop.png')).toBe('desktop.png');
  });
});
