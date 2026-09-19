import { describe, test, expect } from 'bun:test';
import { isAcceptedFileType, formatBytes, transferredFiles } from './file';

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
