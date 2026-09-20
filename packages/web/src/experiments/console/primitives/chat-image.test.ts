import { describe, test, expect } from 'bun:test';
import {
  chatImageUrl,
  imageName,
  inlineImagePaths,
  isLocalImagePath,
  withInlineImages,
} from './chat-image';

describe('isLocalImagePath', () => {
  test('accepts an absolute path to a raster image', () => {
    expect(isLocalImagePath('/tmp/devshot/desktop.png')).toBe(true);
    expect(isLocalImagePath('/tmp/a.JPEG')).toBe(true);
  });

  test('refuses a remote URL, a relative path and a non-image', () => {
    expect(isLocalImagePath('https://example.com/a.png')).toBe(false);
    expect(isLocalImagePath('shots/a.png')).toBe(false);
    expect(isLocalImagePath('/etc/passwd')).toBe(false);
    expect(isLocalImagePath(undefined)).toBe(false);
  });

  test('refuses an SVG — the server never serves one as an image', () => {
    expect(isLocalImagePath('/tmp/diagram.svg')).toBe(false);
  });
});

describe('withInlineImages', () => {
  test('turns the bare paths of a real answer into markdown images', () => {
    expect(withInlineImages('Файлы: /tmp/devshot/desktop.png, /tmp/devshot/mobile.png')).toBe(
      'Файлы: ![desktop.png](/tmp/devshot/desktop.png), ![mobile.png](/tmp/devshot/mobile.png)'
    );
  });

  test('keeps the sentence punctuation outside the image', () => {
    expect(withInlineImages('See /tmp/a.png.')).toBe('See ![a.png](/tmp/a.png).');
  });

  test('leaves a path that is already a markdown image alone', () => {
    const md = '![the lobby](/tmp/a.png)';
    expect(withInlineImages(md)).toBe(md);
  });

  test('leaves a path inside a link alone', () => {
    const md = '[open it](/tmp/a.png)';
    expect(withInlineImages(md)).toBe(md);
  });

  test('leaves a path shown as code alone — it is text, not an illustration', () => {
    expect(withInlineImages('run `open /tmp/a.png`')).toBe('run `open /tmp/a.png`');
    expect(withInlineImages('```\n/tmp/a.png\n```')).toBe('```\n/tmp/a.png\n```');
  });

  test('rewrites prose that follows a code block', () => {
    expect(withInlineImages('```\ncode\n```\nthen /tmp/a.png')).toBe(
      '```\ncode\n```\nthen ![a.png](/tmp/a.png)'
    );
  });

  test('changes nothing in a message that names no image', () => {
    const text = 'Done. The route lives in src/app/api/app-api.js.';
    expect(withInlineImages(text)).toBe(text);
  });

  test('leaves a non-image path as prose', () => {
    expect(withInlineImages('see /etc/hosts')).toBe('see /etc/hosts');
  });
});

describe('inlineImagePaths', () => {
  test('lists the pictures a message shows, in order and without repeats', () => {
    const content = '/tmp/b.png then ![alt](/tmp/a.png) then /tmp/b.png again';
    expect(inlineImagePaths(content)).toEqual(['/tmp/b.png', '/tmp/a.png']);
  });

  test('ignores a remote image', () => {
    expect(inlineImagePaths('![remote](https://example.com/a.png)')).toEqual([]);
  });
});

describe('chatImageUrl', () => {
  test('encodes the conversation and the path', () => {
    expect(chatImageUrl('web-1 2', '/tmp/a b.png')).toBe(
      '/api/conversations/web-1%202/image?path=%2Ftmp%2Fa%20b.png'
    );
  });
});

describe('imageName', () => {
  test('is the last path segment', () => {
    expect(imageName('/tmp/devshot/desktop.png')).toBe('desktop.png');
  });
});

describe('withInlineImages — pictures share a paragraph', () => {
  test('a run of image-only lines becomes one line, so they lay out as a grid', () => {
    const content = 'Вот экраны:\n/tmp/a.png\n/tmp/b.png\n/tmp/c.png';
    expect(withInlineImages(content)).toBe(
      'Вот экраны:\n\n![a.png](/tmp/a.png) ![b.png](/tmp/b.png) ![c.png](/tmp/c.png)'
    );
  });

  test('a blank line between two pictures does not split them into two paragraphs', () => {
    expect(withInlineImages('/tmp/a.png\n\n/tmp/b.png')).toBe(
      '![a.png](/tmp/a.png) ![b.png](/tmp/b.png)'
    );
  });

  test('prose after the pictures keeps its own paragraph', () => {
    const content = '/tmp/a.png\n/tmp/b.png\n\nЭто dev в текущем состоянии.';
    expect(withInlineImages(content)).toBe(
      '![a.png](/tmp/a.png) ![b.png](/tmp/b.png)\n\nЭто dev в текущем состоянии.'
    );
  });

  test('a picture named inside a sentence stays inside that sentence', () => {
    expect(withInlineImages('Файлы: /tmp/a.png, /tmp/b.png.')).toBe(
      'Файлы: ![a.png](/tmp/a.png), ![b.png](/tmp/b.png).'
    );
  });

  test('a lone picture is left exactly where it was', () => {
    expect(withInlineImages('до\n/tmp/a.png\nпосле')).toBe('до\n\n![a.png](/tmp/a.png)\nпосле');
  });
});
