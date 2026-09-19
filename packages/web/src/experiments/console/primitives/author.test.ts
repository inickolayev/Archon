import { describe, expect, test } from 'bun:test';
import { authorLabel, displayNameOf, isMine, type Directory } from './author';

const directory: Directory = {
  me: 'user-me',
  users: [
    { id: 'user-me', displayName: 'Igor Nikolaev', email: 'igorabcpps@gmail.com' },
    { id: 'user-nameless', displayName: null, email: 'someone@example.com' },
    { id: 'user-blank', displayName: '   ', email: 'blank@example.com' },
    { id: 'user-other', displayName: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 'user-bot', displayName: null, email: null },
  ],
};

describe('displayNameOf', () => {
  test('a filled name always wins over the email', () => {
    expect(displayNameOf(directory.users[0])).toBe('Igor Nikolaev');
  });

  test('an empty or whitespace name falls back to the email', () => {
    expect(displayNameOf(directory.users[1])).toBe('someone@example.com');
    expect(displayNameOf(directory.users[2])).toBe('blank@example.com');
  });

  test('neither name nor email is null, not an invented label', () => {
    expect(displayNameOf(directory.users[4])).toBeNull();
    expect(displayNameOf(undefined)).toBeNull();
  });
});

describe('authorLabel', () => {
  test('my own writing says you, and which account that is', () => {
    expect(authorLabel(directory, 'user-me')).toBe('you (Igor Nikolaev)');
  });

  test('my own writing with no name falls back to my email', () => {
    const noName: Directory = {
      me: 'user-nameless',
      users: directory.users,
    };
    expect(authorLabel(noName, 'user-nameless')).toBe('you (someone@example.com)');
  });

  test('someone else is just themselves — no "you", no email when a name exists', () => {
    const label = authorLabel(directory, 'user-other');
    expect(label).toBe('Ada Lovelace');
    expect(label).not.toContain('ada@example.com');
  });

  test('someone else with no name shows their email', () => {
    expect(authorLabel(directory, 'user-nameless')).toBe('someone@example.com');
  });

  test('an unknown or missing author gets no label, rather than a guess', () => {
    expect(authorLabel(directory, 'user-never-seen')).toBeNull();
    expect(authorLabel(directory, null)).toBeNull();
    expect(authorLabel(directory, undefined)).toBeNull();
    expect(authorLabel(directory, '')).toBeNull();
  });

  test('with nobody signed in, nothing is mine', () => {
    const anonymous: Directory = { me: null, users: directory.users };
    expect(authorLabel(anonymous, 'user-me')).toBe('Igor Nikolaev');
    expect(isMine(anonymous, 'user-me')).toBe(false);
  });
});

describe('isMine', () => {
  test('true only for the signed-in account', () => {
    expect(isMine(directory, 'user-me')).toBe(true);
    expect(isMine(directory, 'user-other')).toBe(false);
    expect(isMine(directory, null)).toBe(false);
  });
});
