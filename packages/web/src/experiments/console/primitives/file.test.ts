import { describe, test, expect } from 'bun:test';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  attachFiles,
  isAcceptedFileType,
  formatBytes,
  transferredFiles,
  type Attachment,
  type AttachmentMeta,
} from './file';

const file = (name: string, type = ''): File => new File(['x'], name, { type });

describe('isAcceptedFileType', () => {
  test('accepts by MIME — text/*, image/*, pdf, json', () => {
    expect(isAcceptedFileType(file('a', 'text/plain'))).toBe(true);
    expect(isAcceptedFileType(file('a', 'image/png'))).toBe(true);
    expect(isAcceptedFileType(file('a', 'application/pdf'))).toBe(true);
    expect(isAcceptedFileType(file('a', 'application/json'))).toBe(true);
  });

  test('accepts by extension when the MIME type is empty (code/config files)', () => {
    expect(isAcceptedFileType(file('main.py'))).toBe(true);
    expect(isAcceptedFileType(file('schema.sql'))).toBe(true);
    expect(isAcceptedFileType(file('Config.YAML'))).toBe(true); // case-insensitive
  });

  test('rejects an unknown extension with an empty MIME', () => {
    expect(isAcceptedFileType(file('archive.zip'))).toBe(false);
    expect(isAcceptedFileType(file('binary.exe'))).toBe(false);
  });

  test('rejects no-extension files and dotfiles', () => {
    expect(isAcceptedFileType(file('Makefile'))).toBe(false);
    expect(isAcceptedFileType(file('.gitignore'))).toBe(false);
  });
});

describe('formatBytes', () => {
  test('formats B / KB / MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });
});

const items = (list: { kind: string; getAsFile: () => File | null }[]): DataTransferItemList =>
  list as unknown as DataTransferItemList;

describe('transferredFiles', () => {
  test('keeps the file items of a paste and drops the string items', () => {
    const png = file('image.png', 'image/png');
    const result = transferredFiles(
      items([
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => png },
      ])
    );
    expect(result).toEqual([png]);
  });

  test('keeps every file of a multi-file drop, in order', () => {
    const a = file('a.png', 'image/png');
    const b = file('b.png', 'image/png');
    expect(
      transferredFiles(
        items([
          { kind: 'file', getAsFile: () => a },
          { kind: 'file', getAsFile: () => b },
        ])
      )
    ).toEqual([a, b]);
  });

  test('skips a file item that carries no file', () => {
    expect(transferredFiles(items([{ kind: 'file', getAsFile: () => null }]))).toEqual([]);
  });

  test('returns nothing for a plain-text paste', () => {
    expect(transferredFiles(items([{ kind: 'string', getAsFile: () => null }]))).toEqual([]);
  });
});

describe('attachFiles', () => {
  // Mirrors the composer: ids come from a counter, images get a preview URL.
  const minter = (): ((file: File) => AttachmentMeta) => {
    let n = 0;
    return (f: File): AttachmentMeta => ({
      id: String(n++),
      previewUrl: f.type.startsWith('image/') ? `blob:${f.name}` : null,
    });
  };

  const names = (list: readonly Attachment[]): string[] => list.map(a => a.file.name);

  test('two batches added back to back keep both (the stale-list regression)', () => {
    const mint = minter();
    // Same tick: the second call sees only what the first one returned, never a
    // render snapshot taken before it.
    const first = attachFiles([], [file('one.png', 'image/png')], mint);
    const second = attachFiles(first.next, [file('two.txt', 'text/plain')], mint);
    const third = attachFiles(second.next, [file('three.png', 'image/png')], mint);

    expect(names(third.next)).toEqual(['one.png', 'two.txt', 'three.png']);
    expect(third.next.map(a => a.id)).toEqual(['0', '1', '2']);
    expect(third.skipped).toEqual([]);
  });

  test('leaves the list it was given untouched', () => {
    const current = attachFiles([], [file('a.txt', 'text/plain')], minter()).next;
    attachFiles(current, [file('b.txt', 'text/plain')], minter());
    expect(names(current)).toEqual(['a.txt']);
  });

  test('mints a preview URL for images only', () => {
    const { next } = attachFiles(
      [],
      [file('pic.png', 'image/png'), file('notes.txt', 'text/plain')],
      minter()
    );
    expect(next[0]?.previewUrl).toBe('blob:pic.png');
    expect(next[1]?.previewUrl).toBeNull();
  });

  test('counts the files already attached against the limit', () => {
    const mint = minter();
    let current: readonly Attachment[] = [];
    for (let i = 0; i < MAX_FILES; i++) {
      current = attachFiles(current, [file(`f${String(i)}.txt`, 'text/plain')], mint).next;
    }
    const over = attachFiles(current, [file('extra.txt', 'text/plain')], mint);
    expect(over.next).toHaveLength(MAX_FILES);
    expect(over.skipped).toEqual([`extra.txt: over the ${String(MAX_FILES)}-file limit`]);
  });

  test('skips oversize and unsupported files, keeping the good ones', () => {
    const big = new File([new Uint8Array(1)], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    const { next, skipped } = attachFiles(
      [],
      [file('ok.txt', 'text/plain'), big, file('archive.zip')],
      minter()
    );
    expect(names(next)).toEqual(['ok.txt']);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toContain('huge.png');
    expect(skipped[1]).toContain('unsupported type');
  });

  test('never mints for a file it rejects (no leaked object URL)', () => {
    const minted: string[] = [];
    attachFiles([], [file('archive.zip')], f => {
      minted.push(f.name);
      return { id: 'x', previewUrl: null };
    });
    expect(minted).toEqual([]);
  });
});
