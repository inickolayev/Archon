// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { SqliteAdapter } from '../db/adapters/sqlite';
import { createSqlStateDocumentStore } from '../db/state-documents';
import { listAllRunsWatchers, setAllRunsWatch } from './all-runs-watchers';

const track = trackTempRoots();

test('the real state store keeps a private and a group chat, and lets one go', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'all-runs-watchers-')));
  const db = new SqliteAdapter(join(root, 'state.db'));
  try {
    const store = createSqlStateDocumentStore(() => db);
    await setAllRunsWatch('111222333', true, store);
    await setAllRunsWatch('-1001234567890', true, store);
    await setAllRunsWatch('111222333', false, store);
    await setAllRunsWatch('111222333', false, store);
    expect(await listAllRunsWatchers(store)).toEqual(['-1001234567890']);
  } finally {
    await db.close();
    await removeTempTree(root);
  }
});
