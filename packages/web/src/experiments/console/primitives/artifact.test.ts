import { describe, test, expect } from 'bun:test';
import {
  artifactBasename,
  artifactExtension,
  artifactKind,
  artifactUrl,
  formatArtifactSize,
} from './artifact';

describe('artifactKind', () => {
  test('markdown, text and code render as documents', () => {
    expect(artifactKind('review/report.md')).toBe('markdown');
    expect(artifactKind('notes.MDX')).toBe('markdown');
    expect(artifactKind('target-health.txt')).toBe('text');
    expect(artifactKind('run.log')).toBe('text');
    expect(artifactKind('config.yaml')).toBe('text');
  });

  test('raster images render as images', () => {
    expect(artifactKind('shots/step-01.png')).toBe('image');
    expect(artifactKind('photo.JPG')).toBe('image');
    expect(artifactKind('anim.gif')).toBe('image');
  });

  test('an .svg is text, never an image (the server refuses to type it as one)', () => {
    // An SVG can carry script and the console shares this origin, so it is
    // served as text/plain — rendering it through <img> would just break.
    expect(artifactKind('diagram.svg')).toBe('text');
  });

  test('pdf gets its own embedded viewer', () => {
    expect(artifactKind('spec.pdf')).toBe('pdf');
  });

  test('anything unknown is binary — a download card, not a text dump', () => {
    expect(artifactKind('trace.zip')).toBe('binary');
    expect(artifactKind('profile.trace')).toBe('binary');
    expect(artifactKind('Inter.woff2')).toBe('binary');
    expect(artifactKind('no-extension')).toBe('binary');
    expect(artifactKind('.hidden')).toBe('binary');
  });
});

describe('artifactExtension / artifactBasename', () => {
  test('takes the last segment and the last dot', () => {
    expect(artifactBasename('a/b/c.png')).toBe('c.png');
    expect(artifactExtension('a/b/c.tar.gz')).toBe('gz');
    expect(artifactExtension('a/b/plain')).toBe('');
    expect(artifactExtension('.gitignore')).toBe('');
  });
});

describe('artifactUrl', () => {
  test('encodes the run id and every path segment separately', () => {
    expect(artifactUrl('run 1', 'dir name/a b.png')).toBe(
      '/api/artifacts/run%201/dir%20name/a%20b.png'
    );
  });

  test('keeps the slashes that separate segments', () => {
    expect(artifactUrl('r', 'review/report.md')).toBe('/api/artifacts/r/review/report.md');
  });
});

describe('formatArtifactSize', () => {
  test('formats B / KB / MB', () => {
    expect(formatArtifactSize(512)).toBe('512 B');
    expect(formatArtifactSize(2048)).toBe('2.0 KB');
    expect(formatArtifactSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
