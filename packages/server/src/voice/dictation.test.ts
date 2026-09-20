import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { parseDictatedMessage } from '@archon/core/messaging/dictation';
import { parseQuotedMessage } from '@archon/core/messaging/quoted-context';
import type { AttachedFile } from '@archon/core';
import { dictationFor, resetDictationNoticeForTests, voiceAttachmentOf } from './dictation';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await removeTempTree(root);
});

async function savedRecording(name = 'voice-abc.ogg'): Promise<AttachedFile> {
  const root = await mkdtemp(join(tmpdir(), 'archon-voice-test-'));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, Buffer.alloc(4_000));
  return { path, name, mimeType: 'audio/ogg', size: 4_000 };
}

const PICTURE: AttachedFile = {
  path: '/nowhere/shot.png',
  name: 'shot.png',
  mimeType: 'image/png',
  size: 10,
};

describe('finding the recording in a message', () => {
  test('picks the audio out of whatever else was attached', () => {
    const voice: AttachedFile = {
      path: '/tmp/v.ogg',
      name: 'v.ogg',
      mimeType: 'audio/ogg',
      size: 1,
    };

    expect(voiceAttachmentOf([PICTURE, voice])).toBe(voice);
    expect(voiceAttachmentOf([PICTURE])).toBeNull();
    expect(voiceAttachmentOf([])).toBeNull();
  });
});

describe('a recording this install cannot transcribe', () => {
  // The keys are read at call time, so emptying them here is enough to pin the
  // unconfigured path whatever the machine running the suite happens to have.
  const previousKey = process.env.YANDEX_STT_API_KEY;
  const previousFolder = process.env.YANDEX_STT_FOLDER_ID;
  beforeEach(() => {
    process.env.YANDEX_STT_API_KEY = '';
    process.env.YANDEX_STT_FOLDER_ID = '';
    resetDictationNoticeForTests();
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.YANDEX_STT_API_KEY;
    else process.env.YANDEX_STT_API_KEY = previousKey;
    if (previousFolder === undefined) delete process.env.YANDEX_STT_FOLDER_ID;
    else process.env.YANDEX_STT_FOLDER_ID = previousFolder;
  });

  test('still becomes a message, marked as spoken and saying why it is empty', async () => {
    const dictated = await dictationFor({
      typed: '',
      files: [await savedRecording()],
      assistantType: 'claude',
      durationSec: 42,
    });

    expect(dictated).not.toBeNull();
    if (dictated === null) return;
    expect(dictated.transcript).toBe('');
    const parsed = parseDictatedMessage(dictated.text);
    expect(parsed.note).toContain('not transcribed');
    expect(parsed.note).toContain('0:42');
    // Nothing under the marker: there are no words to put there, and inventing
    // some would be worse than an empty body.
    expect(parsed.body).toBe('');
  });

  test('says what to configure once, then stops repeating itself', async () => {
    const file = await savedRecording();
    const first = await dictationFor({ typed: '', files: [file], assistantType: 'claude' });
    const second = await dictationFor({ typed: '', files: [file], assistantType: 'claude' });

    expect(first?.note).toContain('YANDEX_STT_API_KEY');
    expect(second?.note).not.toContain('YANDEX_STT_API_KEY');
    expect(second?.note).toContain('not transcribed');
  });

  test('words typed alongside the recording are kept', async () => {
    const dictated = await dictationFor({
      typed: 'это про вчерашний деплой',
      files: [await savedRecording()],
      assistantType: 'claude',
    });

    expect(parseDictatedMessage(dictated?.text ?? '').body).toBe('это про вчерашний деплой');
  });

  test('a dictated reply keeps its quote in front, where both windows look', async () => {
    const dictated = await dictationFor({
      typed:
        '> **Quoted context — the agent&apos;s earlier message**\n> deploy is green\n\nвот про это',
      files: [await savedRecording()],
      assistantType: 'claude',
    });

    const quoted = parseQuotedMessage(dictated?.text ?? '');
    expect(quoted.quotes).toHaveLength(1);
    // Only then the marker, then what was typed alongside the recording.
    expect(parseDictatedMessage(quoted.body).body).toBe('вот про это');
  });

  test('a message with no recording in it is left completely alone', async () => {
    expect(
      await dictationFor({ typed: 'look at this', files: [PICTURE], assistantType: 'claude' })
    ).toBeNull();
  });

  test('a recording that cannot be read back is a note, not a lost message', async () => {
    const dictated = await dictationFor({
      typed: '',
      files: [{ path: '/nowhere/at/all/voice.ogg', name: 'voice.ogg', mimeType: 'audio/ogg', size: 1 }],
      assistantType: 'claude',
    });

    expect(dictated?.note).toContain('not transcribed');
  });
});
