// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
}));
const { createApiToken, verifyApiToken, listApiTokens, revokeApiToken } = await import(
  './pat-store'
);
afterAll(async () => await db.close());

async function seedUser(id: string): Promise<void> {
  await db.query('INSERT INTO remote_agent_users (id) VALUES ($1)', [id]);
}

test('a created token verifies to its owner, has the documented format and stores only the hash', async () => {
  await seedUser('u1');
  const { token, record } = await createApiToken({ userId: 'u1', name: 'cli', expiresInDays: 90 });
  expect(token).toMatch(/^arc_pat_[A-Za-z0-9_-]{43}$/);
  expect(record.prefix).toBe(token.slice(0, 12));
  expect(await verifyApiToken(token)).toEqual({ userId: 'u1', tokenId: record.id });

  const rows = (await db.query('SELECT * FROM remote_agent_api_tokens', [])).rows;
  expect(JSON.stringify(rows)).not.toContain(token);
  expect(rows[0]).toMatchObject({ token_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
});

test('unknown and malformed tokens do not verify', async () => {
  expect(await verifyApiToken('arc_pat_nope')).toBeNull();
  expect(await verifyApiToken('something-else')).toBeNull();
});

test('expired tokens are rejected and never-expiring tokens are not', async () => {
  await seedUser('u2');
  const past = new Date(Date.now() - 100 * 86_400_000);
  const expired = await createApiToken({
    userId: 'u2',
    name: 'old',
    expiresInDays: 30,
    now: past,
  });
  expect(await verifyApiToken(expired.token)).toBeNull();
  const forever = await createApiToken({
    userId: 'u2',
    name: 'forever',
    expiresInDays: null,
    now: past,
  });
  expect(forever.record.expiresAt).toBeNull();
  expect((await verifyApiToken(forever.token))?.userId).toBe('u2');
});

test('verify records last use and listing exposes no secrets', async () => {
  await seedUser('u3');
  const { token, record } = await createApiToken({ userId: 'u3', name: 'a', expiresInDays: 30 });
  expect(record.lastUsedAt).toBeNull();
  await verifyApiToken(token);
  const [listed] = await listApiTokens('u3');
  expect(listed?.lastUsedAt).not.toBeNull();
  expect(Object.keys(listed ?? {}).sort()).toEqual(
    ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'prefix'].sort()
  );
  expect(JSON.stringify(listed)).not.toContain(token);
});

test('revoke is owner-scoped and takes effect immediately', async () => {
  await seedUser('u4');
  await seedUser('u5');
  const { token, record } = await createApiToken({ userId: 'u4', name: 'a', expiresInDays: 30 });
  expect(await revokeApiToken('u5', record.id)).toBe(false);
  expect(await verifyApiToken(token)).not.toBeNull();
  expect(await revokeApiToken('u4', record.id)).toBe(true);
  expect(await verifyApiToken(token)).toBeNull();
  expect(await listApiTokens('u4')).toEqual([]);
  expect(await revokeApiToken('u4', record.id)).toBe(false);
});
