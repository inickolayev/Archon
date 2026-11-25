/**
 * ChessWin fork (chesswin-factory ADR 0011 §6, issue #32): the chats that watch every run
 * nobody started — `/workflow watch all` / `/workflow unwatch all`.
 *
 * A run started by a person calls that person (`telegramRecipients`); a run started by the
 * CLI or the nightly timer has nobody to call, so it calls the chats that asked for such runs.
 * The wish is a state document per chat in the install scope, so it survives restarts and
 * re-pins and is named nowhere in configuration; `archon state` shows its history.
 */
import type { IStateDocumentStore } from '@archon/workflows/state-document-store';
import { getDatabase } from '../db/connection';
import { createSqlStateDocumentStore } from '../db/state-documents';

export type AllRunsWatchStore = Pick<
  IStateDocumentStore,
  'getStateDocuments' | 'listStateRevisions' | 'putStateDocument' | 'deleteStateDocument'
>;

const SCOPE = { kind: 'install' } as const;
const PREFIX = 'chesswin/attention/watch-all/';
const WRITER = { kind: 'surface', via: 'telegram' } as const;

let cachedStore: AllRunsWatchStore | undefined;
function defaultStore(): AllRunsWatchStore {
  cachedStore ??= createSqlStateDocumentStore(getDatabase);
  return cachedStore;
}

/** The chats watching every run nobody started. */
export async function listAllRunsWatchers(
  store: AllRunsWatchStore = defaultStore()
): Promise<string[]> {
  const documents = await store.getStateDocuments(SCOPE, { prefix: PREFIX });
  return documents.map(document => document.name.slice(PREFIX.length));
}

/** Start (`watching`) or stop a chat's watch of every run nobody started; repeats write nothing. */
export async function setAllRunsWatch(
  chatId: string,
  watching: boolean,
  store: AllRunsWatchStore = defaultStore()
): Promise<void> {
  const name = `${PREFIX}${chatId}`;
  // The latest revision, a tombstone included: a put is a compare-and-swap on it.
  const [latest] = await store.listStateRevisions(SCOPE, name, { limit: 1 });
  const watchingNow = latest !== undefined && latest.value !== null;
  if (watchingNow === watching) return;
  const ifRevision = latest?.revision ?? 0;
  if (watching)
    await store.putStateDocument({ scope: SCOPE, name, writer: WRITER, value: true, ifRevision });
  else await store.deleteStateDocument({ scope: SCOPE, name, writer: WRITER, ifRevision });
}
