import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = createMockQuery();
const mockWithTransaction = mock(
  async (fn: (q: typeof mockQuery) => Promise<unknown>) => await fn(mockQuery)
);

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
  getDatabase: () => ({ withTransaction: mockWithTransaction }),
}));

import {
  linkIdentityToUser,
  unlinkIdentity,
  listIdentitiesForUser,
  listDirectoryUsers,
} from './account-links';

/** The SQL of every call made, flattened, so intent can be asserted plainly. */
function statements(): string[] {
  return mockQuery.mock.calls.map(call => String(call[0]).replace(/\s+/g, ' ').trim());
}

beforeEach(() => {
  mockQuery.mockReset();
  mockWithTransaction.mockClear();
});

describe('linkIdentityToUser — a sender nobody has seen', () => {
  test('records the mapping and moves nothing', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([])); // no identity
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1)); // insert

    const outcome = await linkIdentityToUser('telegram', '4242', 'user-web');

    expect(outcome).toEqual({ moved: {}, alreadyLinked: false });
    const sql = statements();
    expect(sql.some(s => s.startsWith('INSERT INTO remote_agent_user_identities'))).toBe(true);
    expect(sql.some(s => s.startsWith('UPDATE remote_agent_conversations'))).toBe(false);
    expect(sql.some(s => s.startsWith('DELETE'))).toBe(false);
  });
});

describe('linkIdentityToUser — already this account', () => {
  test('is a no-op: nothing is moved, nothing is deleted', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([{ id: 'ident-1', user_id: 'user-web', platform: 'telegram' }])
    );

    const outcome = await linkIdentityToUser('telegram', '4242', 'user-web');

    expect(outcome).toEqual({ moved: {}, alreadyLinked: true });
    expect(statements()).toHaveLength(1);
  });
});

describe('linkIdentityToUser — a Telegram user with its own history', () => {
  test('moves conversations, messages and runs, then re-points the identity', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([{ id: 'ident-1', user_id: 'user-tg', platform: 'telegram' }])
    );
    mockQuery.mockResolvedValueOnce(createQueryResult([], 3)); // conversations
    mockQuery.mockResolvedValueOnce(createQueryResult([], 17)); // messages
    mockQuery.mockResolvedValueOnce(createQueryResult([], 2)); // workflow runs
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1)); // identity re-point
    mockQuery.mockResolvedValueOnce(createQueryResult([{ count: '0' }])); // nothing left
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1)); // delete emptied user

    const outcome = await linkIdentityToUser('telegram', '4242', 'user-web');

    expect(outcome.alreadyLinked).toBe(false);
    expect(outcome.moved).toEqual({
      remote_agent_conversations: 3,
      remote_agent_messages: 17,
      remote_agent_workflow_runs: 2,
    });
    const sql = statements();
    // History moves to the account, never the other way around.
    expect(sql).toContain('UPDATE remote_agent_conversations SET user_id = $1 WHERE user_id = $2');
    expect(sql).toContain('UPDATE remote_agent_messages SET user_id = $1 WHERE user_id = $2');
    expect(sql).toContain('UPDATE remote_agent_workflow_runs SET user_id = $1 WHERE user_id = $2');
    // Nothing is deleted from history — only the emptied user row goes.
    const deletes = sql.filter(s => s.startsWith('DELETE'));
    expect(deletes).toEqual(['DELETE FROM remote_agent_users WHERE id = $1']);
  });

  test('all of it happens in one transaction', async () => {
    mockQuery.mockResolvedValue(createQueryResult([{ id: 'i', user_id: 'user-tg' }]));
    await linkIdentityToUser('telegram', '4242', 'user-web');
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
  });

  test('a user something else still points at is left alone', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([{ id: 'ident-1', user_id: 'user-tg', platform: 'telegram' }])
    );
    mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockResolvedValueOnce(createQueryResult([{ count: '1' }])); // still referenced

    await linkIdentityToUser('telegram', '4242', 'user-web');

    expect(statements().some(s => s.startsWith('DELETE'))).toBe(false);
  });
});

describe('unlinkIdentity', () => {
  test('removes the mapping only — no history is touched', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    const outcome = await unlinkIdentity('telegram', 'user-web');

    expect(outcome).toEqual({ removed: 1 });
    const sql = statements();
    expect(sql).toEqual([
      'DELETE FROM remote_agent_user_identities WHERE platform = $1 AND user_id = $2',
    ]);
    // Crucially: nothing sets user_id back to NULL anywhere.
    expect(sql.some(s => s.includes('user_id = NULL'))).toBe(false);
  });

  test('unlinking something that was never linked is not an error', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
    await expect(unlinkIdentity('telegram', 'user-web')).resolves.toEqual({ removed: 0 });
  });
});

describe('listIdentitiesForUser', () => {
  test('reports the platform, who it is there, and when it was linked', async () => {
    const linkedAt = new Date('2026-09-19T10:00:00.000Z');
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          platform: 'telegram',
          platform_user_id: '4242',
          platform_display_name: 'Igor',
          created_at: linkedAt,
        },
      ])
    );

    await expect(listIdentitiesForUser('user-web')).resolves.toEqual([
      { platform: 'telegram', platformUserId: '4242', displayName: 'Igor', linkedAt },
    ]);
  });
});

describe('listDirectoryUsers', () => {
  test('carries the email of the web account behind a user, and null when there is none', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        { id: 'user-web', display_name: 'Igor Nikolaev', email: 'igorabcpps@gmail.com' },
        { id: 'user-tg', display_name: 'Igor', email: null },
      ])
    );

    await expect(listDirectoryUsers()).resolves.toEqual([
      { id: 'user-web', displayName: 'Igor Nikolaev', email: 'igorabcpps@gmail.com' },
      { id: 'user-tg', displayName: 'Igor', email: null },
    ]);
  });
});
