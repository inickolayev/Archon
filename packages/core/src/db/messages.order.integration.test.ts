/**
 * Integration test: message-query ordering against a REAL bun:sqlite database.
 *
 * SQLite stores `created_at` at 1-second granularity, so consecutive messages
 * routinely share a timestamp. Without a secondary sort key the LIMIT window of
 * `ORDER BY created_at DESC LIMIT n` is undefined for tied rows and can flip
 * between refetches, dropping/duplicating a boundary message (#2218). These
 * tests pin the `id DESC` tie-breaker: tied rows are inserted in an order that
 * differs from their id order, so scan-order luck cannot make them pass.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { addMessage, listMessages, getRecentWorkflowResultMessages } = await import('./messages');

await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);

async function insertMessage(id: string, createdAt: string, metadata = '{}'): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_messages (id, conversation_id, role, content, metadata, created_at)
     VALUES ($1, 'conv-1', 'user', $2, $3, $4)`,
    [id, `content-${id}`, metadata, createdAt]
  );
}

// Two older messages with distinct timestamps...
await insertMessage('old-1', '2026-01-01 00:00:01');
await insertMessage('old-2', '2026-01-01 00:00:02');
// ...and four messages sharing one created_at, inserted OUT of id order so that
// insertion (scan) order differs from the deterministic id order.
await insertMessage('tie-2', '2026-01-01 00:00:10');
await insertMessage('tie-4', '2026-01-01 00:00:10');
await insertMessage('tie-1', '2026-01-01 00:00:10');
await insertMessage('tie-3', '2026-01-01 00:00:10');

describe('listMessages — deterministic LIMIT window on shared created_at (#2218)', () => {
  test('a LIMIT cutting inside a tie group keeps the highest ids, in stable order', async () => {
    // Newest 3 of the 4 tied rows: id DESC picks tie-4, tie-3, tie-2; reversed
    // to chronological. Without the tie-breaker, membership follows scan order
    // (tie-2, tie-4, tie-1) and this assertion fails.
    const rows = await listMessages('conv-1', 3);
    expect(rows.map(r => r.id)).toEqual(['tie-2', 'tie-3', 'tie-4']);
  });

  test('window membership is identical across refetches', async () => {
    const first = await listMessages('conv-1', 3);
    const second = await listMessages('conv-1', 3);
    expect(second.map(r => r.id)).toEqual(first.map(r => r.id));
  });

  test('distinct timestamps keep the chronological (oldest-first) contract', async () => {
    const rows = await listMessages('conv-1', 10);
    expect(rows.map(r => r.id)).toEqual(['old-1', 'old-2', 'tie-1', 'tie-2', 'tie-3', 'tie-4']);
  });

  test('a limit spanning the tie boundary includes the older distinct row', async () => {
    const rows = await listMessages('conv-1', 5);
    expect(rows.map(r => r.id)).toEqual(['old-2', 'tie-1', 'tie-2', 'tie-3', 'tie-4']);
  });
});

describe('getRecentWorkflowResultMessages — same tie-breaker (#2218)', () => {
  test('a LIMIT cutting inside a tie group keeps the highest ids, newest-first', async () => {
    const meta = '{"workflowResult":{"workflowName":"plan","runId":"run-1"}}';
    await insertMessage('wf-2', '2026-01-01 00:00:20', meta);
    await insertMessage('wf-3', '2026-01-01 00:00:20', meta);
    await insertMessage('wf-1', '2026-01-01 00:00:20', meta);

    const rows = await getRecentWorkflowResultMessages('conv-1', 2);
    expect(rows.map(r => r.id)).toEqual(['wf-3', 'wf-2']);
  });
});

/**
 * The race that put a question above the answer to the one before it.
 *
 * Both rows used to be written fire-and-forget, landing about two milliseconds
 * apart, into a column SQLite fills at ONE-SECOND granularity — so they tied,
 * and the reader broke the tie on a random uuid. Half the time the pair came
 * back in the wrong order. Nothing here mocks the clock or the writer: these
 * are real inserts through the real `addMessage`, in a real database.
 */
describe('a turn written through addMessage keeps its order', () => {
  test('question then answer, every time, with no tie left for the id to decide', async () => {
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ('conv-race', 'telegram', 'conv-race-platform')`,
      []
    );

    // Twenty turns back-to-back: a random tie-break would have to win every
    // one of them to let this pass by luck.
    for (let turn = 0; turn < 20; turn++) {
      await addMessage('conv-race', 'user', `question ${String(turn)}`);
      await addMessage('conv-race', 'assistant', `answer ${String(turn)}`);
    }

    const rows = await listMessages('conv-race', 100);
    expect(rows.map(r => r.content)).toEqual(
      Array.from({ length: 20 }, (_, turn) => [
        `question ${String(turn)}`,
        `answer ${String(turn)}`,
      ]).flat()
    );
  });
});

/**
 * A message typed while a turn was running used to be held in memory until the
 * turn ended, then inserted with `now()` — so it surfaced minutes late AND
 * after every bubble the turn had produced in the meantime. Persisted at
 * ingest with the platform's send time, it lands immediately and sits where it
 * was actually typed.
 */
describe('a message sent mid-turn lands where it was sent', () => {
  test('it reads between the bubbles it arrived between, not after all of them', async () => {
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ('conv-midturn', 'telegram', 'conv-midturn-platform')`,
      []
    );

    // Written in the order the server produced them: both bubbles of the
    // running turn, and only then the message that arrived between them — the
    // queue hands it over when the turn ends, however long that takes.
    const turnStart = Date.now() - 60_000;
    await addMessage('conv-midturn', 'assistant', 'first bubble', undefined, undefined, {
      sentAtMs: turnStart,
    });
    await addMessage('conv-midturn', 'assistant', 'second bubble', undefined, undefined, {
      sentAtMs: turnStart + 2000,
    });
    await addMessage('conv-midturn', 'user', 'actually, stop', undefined, undefined, {
      sentAtMs: turnStart + 1000,
    });

    const rows = await listMessages('conv-midturn', 100);
    expect(rows.map(r => r.content)).toEqual(['first bubble', 'actually, stop', 'second bubble']);
  });

  test('a send time from before the turn started sorts ahead of the whole turn', async () => {
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ('conv-late', 'telegram', 'conv-late-platform')`,
      []
    );

    await addMessage('conv-late', 'assistant', 'bubble one');
    await addMessage('conv-late', 'assistant', 'bubble two');
    // Typed six minutes ago, inserted now: the row is stamped with when it was
    // SENT, which is the whole point of carrying the platform's time.
    await addMessage('conv-late', 'user', 'typed long ago', undefined, undefined, {
      sentAtMs: Date.now() - 6 * 60_000,
    });

    const rows = await listMessages('conv-late', 100);
    expect(rows.map(r => r.content)).toEqual(['typed long ago', 'bubble one', 'bubble two']);
  });
});
