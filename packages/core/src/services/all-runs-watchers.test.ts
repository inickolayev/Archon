import { describe, expect, test } from 'bun:test';
import type { StateRevision, StateWriter } from '@archon/workflows/state-document-store';
import { listAllRunsWatchers, setAllRunsWatch, type AllRunsWatchStore } from './all-runs-watchers';

interface Write {
  op: 'put' | 'delete';
  scope: unknown;
  name: string;
  writer: StateWriter;
}

/** Live documents by name; every write is kept so a test can see what was written. */
function fakeStore(names: string[] = []): AllRunsWatchStore & { writes: Write[] } {
  const live = new Set(names);
  const writes: Write[] = [];
  const revision = (name: string): StateRevision =>
    ({ name, revision: 1, value: true }) as unknown as StateRevision;
  return {
    writes,
    getStateDocuments: async (_scope, options) =>
      [...live]
        .filter(name => name.startsWith(options?.prefix ?? ''))
        .sort()
        .map(revision),
    listStateRevisions: async (_scope, name) => (live.has(name) ? [revision(name)] : []),
    putStateDocument: async input => {
      live.add(input.name);
      writes.push({ op: 'put', scope: input.scope, name: input.name, writer: input.writer });
      return revision(input.name);
    },
    deleteStateDocument: async input => {
      live.delete(input.name);
      writes.push({ op: 'delete', scope: input.scope, name: input.name, writer: input.writer });
      return revision(input.name);
    },
  };
}

describe('all-runs watchers', () => {
  test('a chat that asked to watch every run is listed, as its chat id', async () => {
    const store = fakeStore();
    await setAllRunsWatch('352', true, store);
    await setAllRunsWatch('-100777', true, store);
    expect(await listAllRunsWatchers(store)).toEqual(['-100777', '352']);
  });

  test('the wish lives in the install scope, written by the Telegram surface', async () => {
    const store = fakeStore();
    await setAllRunsWatch('352', true, store);
    expect(store.writes).toEqual([
      {
        op: 'put',
        scope: { kind: 'install' },
        name: 'chesswin/attention/watch-all/352',
        writer: { kind: 'surface', via: 'telegram' },
      },
    ]);
  });

  test('unwatching removes the chat; documents outside the prefix are not watchers', async () => {
    const store = fakeStore(['chesswin/attention/watch-all/352', 'chesswin/other/1']);
    await setAllRunsWatch('352', false, store);
    expect(await listAllRunsWatchers(store)).toEqual([]);
  });

  test('unwatching a chat that never watched writes nothing', async () => {
    const store = fakeStore();
    await setAllRunsWatch('352', false, store);
    expect(store.writes).toEqual([]);
  });

  test('watching twice writes once', async () => {
    const store = fakeStore();
    await setAllRunsWatch('352', true, store);
    await setAllRunsWatch('352', true, store);
    expect(store.writes).toHaveLength(1);
  });
});
