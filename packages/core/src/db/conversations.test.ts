import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';
// spyOn (NOT mock.module) for config-loader: this file shares a `bun test`
// invocation with the real config-loader.test.ts, and `mock.module` is
// process-global and irreversible — mocking the loader here would poison it.
import * as configLoader from '../config/config-loader';

const mockQuery = createMockQuery();

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import {
  formatSqliteTimestamp,
  getOrAdoptConversation,
  claimConversationOwner,
  getOrCreateConversation,
  listConversationsForChat,
  markConversationActive,
  updateConversation,
  findConversationByPlatformId,
} from './conversations';
import type { Conversation } from '../types';
import { ConversationNotFoundError } from '../types';

describe('conversations', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('getOrCreateConversation', () => {
    const mergedConfig = (assistant: string) =>
      ({ assistant }) as Awaited<ReturnType<typeof configLoader.loadConfig>>;
    let loadConfigSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      loadConfigSpy = spyOn(configLoader, 'loadConfig').mockResolvedValue(mergedConfig('claude'));
    });

    afterEach(() => {
      loadConfigSpy.mockRestore();
    });

    const existingConversation: Conversation = {
      id: 'conv-123',
      platform_type: 'telegram',
      platform_conversation_id: 'chat-456',
      ai_assistant_type: 'claude',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      title: null,
      hidden: false,
      deleted_at: null,
      user_id: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    test('returns existing conversation when found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([existingConversation]));

      const result = await getOrCreateConversation('telegram', 'chat-456');

      expect(result).toEqual(existingConversation);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
        ['telegram', 'chat-456']
      );
    });

    test('creates new conversation with default assistant type', async () => {
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
      };

      // First query returns empty (no existing)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Second query creates new
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('telegram', 'chat-789');

      expect(result).toEqual(newConversation);
      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['telegram', 'chat-789', 'claude', null, null, null]
      );
    });

    test('uses codebase assistant type when codebaseId provided', async () => {
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
        ai_assistant_type: 'codex',
        codebase_id: 'codebase-123',
      };

      // First query returns empty (no existing)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Second query fetches codebase
      mockQuery.mockResolvedValueOnce(createQueryResult([{ ai_assistant_type: 'codex' }]));
      // Third query creates new
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('telegram', 'chat-789', 'codebase-123');

      expect(result).toEqual(newConversation);
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'SELECT ai_assistant_type FROM remote_agent_codebases WHERE id = $1',
        ['codebase-123']
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['telegram', 'chat-789', 'codex', 'codebase-123', null, null]
      );
      // The codebase-level assistant short-circuits the config chain.
      expect(loadConfigSpy).not.toHaveBeenCalled();
    });

    // Harvested from PR #1826 (credit: @EugeneChan00) — the configured default
    // assistant chain (config > DEFAULT_AI_ASSISTANT env > first built-in, all
    // owned by loadConfig) must reach new conversations without a codebase.
    test('resolves the configured default assistant when no codebase is scoped', async () => {
      loadConfigSpy.mockResolvedValueOnce(mergedConfig('codex'));

      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
        ai_assistant_type: 'codex',
      };

      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('web', 'web-new-chat');

      expect(result).toEqual(newConversation);
      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['web', 'web-new-chat', 'codex', null, null, null]
      );
    });

    test('falls back to claude when config load fails', async () => {
      loadConfigSpy.mockRejectedValueOnce(new Error('config unavailable'));

      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
      };

      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('web', 'web-new-chat');

      expect(result).toEqual(newConversation);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['web', 'web-new-chat', 'claude', null, null, null]
      );
    });

    test('falls back to configured default when codebase not found', async () => {
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
      };

      // First query returns empty (no existing)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Second query fetches codebase - not found
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Third query creates new
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('telegram', 'chat-789', 'non-existent-codebase');

      expect(result).toEqual(newConversation);
      // Missing row → falls through to the config chain.
      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['telegram', 'chat-789', 'claude', 'non-existent-codebase', null, null]
      );
    });

    test('inherits context from parent conversation', async () => {
      const parentConversation: Conversation = {
        ...existingConversation,
        id: 'parent-conv',
        platform_conversation_id: 'parent-channel',
        codebase_id: 'codebase-123',
        cwd: '/workspace/project',
        ai_assistant_type: 'codex',
      };
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'thread-conv',
        platform_conversation_id: 'thread-123',
        codebase_id: 'codebase-123',
        cwd: '/workspace/project',
        ai_assistant_type: 'codex',
      };

      // First query returns empty (no existing thread conversation)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Second query fetches parent conversation
      mockQuery.mockResolvedValueOnce(createQueryResult([parentConversation]));
      // Third query creates new
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation(
        'discord',
        'thread-123',
        undefined,
        'parent-channel'
      );

      expect(result).toEqual(newConversation);
      expect(mockQuery).toHaveBeenCalledTimes(3);
      // Verify parent lookup
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
        ['discord', 'parent-channel']
      );
      // Verify inherited values in INSERT
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['discord', 'thread-123', 'codex', 'codebase-123', '/workspace/project', null]
      );
      // Parent inheritance short-circuits the config chain.
      expect(loadConfigSpy).not.toHaveBeenCalled();
    });

    test('inherits the owner, so a chat started from a button belongs to someone', async () => {
      // The bug this covers: `+ New chat` in Telegram created a row with
      // codebase_id AND user_id NULL. It then appeared in nobody's console
      // (the chat list is per project) and read as written by a stranger.
      const parentConversation: Conversation = {
        ...existingConversation,
        id: 'parent-conv',
        platform_conversation_id: '352328891',
        codebase_id: 'codebase-123',
        cwd: '/workspace/project',
        user_id: 'user-operator',
      };
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'second-chat',
        platform_conversation_id: '352328891:2',
      };

      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([parentConversation]));
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      await getOrCreateConversation('telegram', '352328891:2', undefined, '352328891');

      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [
          'telegram',
          '352328891:2',
          existingConversation.ai_assistant_type,
          'codebase-123',
          '/workspace/project',
          'user-operator',
        ]
      );
    });

    test('an explicit sender wins over the inherited owner', async () => {
      const parentConversation: Conversation = {
        ...existingConversation,
        id: 'parent-conv',
        platform_conversation_id: 'parent-channel',
        user_id: 'user-parent',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([parentConversation]));
      mockQuery.mockResolvedValueOnce(createQueryResult([existingConversation]));

      await getOrCreateConversation(
        'discord',
        'thread-123',
        undefined,
        'parent-channel',
        'user-sender'
      );

      const insert = mockQuery.mock.calls[2] as unknown[];
      expect((insert[1] as unknown[])[5]).toBe('user-sender');
    });

    test('does not inherit when parent has no context', async () => {
      const parentConversation: Conversation = {
        ...existingConversation,
        id: 'parent-conv',
        platform_conversation_id: 'parent-channel',
        codebase_id: null,
        cwd: null,
      };
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'thread-conv',
        platform_conversation_id: 'thread-123',
      };

      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([parentConversation]));
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation(
        'discord',
        'thread-123',
        undefined,
        'parent-channel'
      );

      expect(result).toEqual(newConversation);
      // Should use inherited assistant type but null for codebase/cwd
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['discord', 'thread-123', 'claude', null, null, null]
      );
    });
  });

  describe('findConversationByPlatformId', () => {
    const cliConversation: Conversation = {
      id: 'conv-cli-1',
      platform_type: 'cli',
      platform_conversation_id: 'cli-1234-abc',
      ai_assistant_type: 'claude',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      title: null,
      hidden: false,
      deleted_at: null,
      user_id: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    test('returns conversation when platform_conversation_id matches', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([cliConversation]));

      const result = await findConversationByPlatformId('cli-1234-abc');

      expect(result).toEqual(cliConversation);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1',
        ['cli-1234-abc']
      );
    });

    test('returns null when no conversation matches', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findConversationByPlatformId('nonexistent');

      expect(result).toBeNull();
    });

    test('works for any platform type without filtering', async () => {
      const telegramConv: Conversation = {
        ...cliConversation,
        id: 'conv-tg-1',
        platform_type: 'telegram',
        platform_conversation_id: 'tg-chat-999',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([telegramConv]));

      const result = await findConversationByPlatformId('tg-chat-999');

      expect(result).toEqual(telegramConv);
      // Verify no platform_type in the query
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1',
        ['tg-chat-999']
      );
    });
  });

  describe('updateConversation', () => {
    test('updates codebase_id only', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateConversation('conv-123', { codebase_id: 'codebase-456' });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_conversations SET codebase_id = $1, updated_at = NOW() WHERE id = $2',
        ['codebase-456', 'conv-123']
      );
    });

    test('updates cwd only', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateConversation('conv-123', { cwd: '/workspace/project' });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_conversations SET cwd = $1, updated_at = NOW() WHERE id = $2',
        ['/workspace/project', 'conv-123']
      );
    });

    test('updates both fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateConversation('conv-123', {
        codebase_id: 'codebase-456',
        cwd: '/workspace/project',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_conversations SET codebase_id = $1, cwd = $2, updated_at = NOW() WHERE id = $3',
        ['codebase-456', '/workspace/project', 'conv-123']
      );
    });

    test('does nothing when no updates provided', async () => {
      await updateConversation('conv-123', {});

      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('allows setting codebase_id to null', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateConversation('conv-123', { codebase_id: null });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_conversations SET codebase_id = $1, updated_at = NOW() WHERE id = $2',
        [null, 'conv-123']
      );
    });

    test('throws ConversationNotFoundError when conversation not found (rowCount === 0)', async () => {
      // Simulate UPDATE returning 0 rows affected
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(
        updateConversation('non-existent-id', { codebase_id: 'codebase-456' })
      ).rejects.toThrow(ConversationNotFoundError);

      // Verify the error contains the conversation ID
      try {
        mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
        await updateConversation('test-conv-id', { cwd: '/workspace' });
      } catch (error) {
        expect(error).toBeInstanceOf(ConversationNotFoundError);
        expect((error as ConversationNotFoundError).conversationId).toBe('test-conv-id');
        expect((error as ConversationNotFoundError).message).toBe(
          'Conversation not found: test-conv-id'
        );
      }
    });
  });
});

describe('getOrAdoptConversation', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const telegramRow: Conversation = {
    id: 'conv-telegram',
    platform_type: 'telegram',
    platform_conversation_id: '123456789:2',
    ai_assistant_type: 'claude',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    title: 'Started on the phone',
    hidden: false,
    deleted_at: null,
    user_id: null,
    last_activity_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  test('returns the row of the same platform when there is one', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([telegramRow]));

    const result = await getOrAdoptConversation('telegram', '123456789:2');

    expect(result).toEqual(telegramRow);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('adopts a conversation born on another platform instead of forking a twin', async () => {
    // Delivering through the web adapter, but the conversation is Telegram's.
    mockQuery
      .mockResolvedValueOnce(createQueryResult([])) // no ('web', '123456789:2')
      .mockResolvedValueOnce(createQueryResult([telegramRow])); // but the id exists

    const result = await getOrAdoptConversation('web', '123456789:2');

    expect(result).toEqual(telegramRow);
    // Two lookups, and crucially no INSERT.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const statements = mockQuery.mock.calls.map(call => String(call[0]));
    expect(statements.some(sql => sql.includes('INSERT'))).toBe(false);
  });

  test('falls through to creation when the id is unknown everywhere', async () => {
    const loadConfigSpy = spyOn(configLoader, 'loadConfig').mockResolvedValue({
      assistant: 'claude',
    } as Awaited<ReturnType<typeof configLoader.loadConfig>>);
    mockQuery
      .mockResolvedValueOnce(createQueryResult([])) // same platform
      .mockResolvedValueOnce(createQueryResult([])) // any platform
      .mockResolvedValueOnce(createQueryResult([])) // getOrCreate's own lookup
      .mockResolvedValueOnce(createQueryResult([{ ...telegramRow, id: 'conv-new' }]));

    const result = await getOrAdoptConversation('web', 'web-brand-new');

    expect(result.id).toBe('conv-new');
    const statements = mockQuery.mock.calls.map(call => String(call[0]));
    expect(statements.some(sql => sql.includes('INSERT'))).toBe(true);
    loadConfigSpy.mockRestore();
  });
});

describe('listConversationsForChat', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  test('matches the chat exactly or by `<chat id>:` prefix, never a longer chat id', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([]));

    await listConversationsForChat('telegram', '123');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('platform_conversation_id = $2');
    expect(sql).toContain('platform_conversation_id LIKE $3');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual(['telegram', '123', '123:%']);
  });
});

describe('markConversationActive', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  test('bumps last_activity_at and updated_at together', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([]));

    await markConversationActive('conv-1');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('last_activity_at =');
    expect(sql).toContain('updated_at =');
    expect(params[0]).toBe('conv-1');
  });

  test('lands strictly after the newest sibling, even inside one millisecond', async () => {
    // Whole-second timestamps (SQLite's datetime('now')) made a switch tie with
    // the turn that preceded it; the floor is what makes the switch win.
    const future = Date.now() + 60_000;
    mockQuery.mockResolvedValueOnce(createQueryResult([]));

    await markConversationActive('conv-1', future);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const written = params[1];
    if (typeof written !== 'string') {
      // Postgres path: now() has microseconds, no floor parameter is needed.
      expect(params).toEqual(['conv-1']);
      return;
    }
    expect(Date.parse(`${written.replace(' ', 'T')}Z`)).toBeGreaterThan(future);
  });
});

describe('formatSqliteTimestamp', () => {
  test("keeps SQLite's own shape, with milliseconds", () => {
    expect(formatSqliteTimestamp(Date.parse('2026-09-19T18:27:45.030Z'))).toBe(
      '2026-09-19 18:27:45.030'
    );
  });

  test('sorts correctly against a whole-second value of the same second', () => {
    const second = '2026-09-19 18:27:45';
    const precise = formatSqliteTimestamp(Date.parse('2026-09-19T18:27:45.030Z'));
    expect(precise > second).toBe(true);
    expect(precise < '2026-09-19 18:27:46').toBe(true);
  });
});

describe('claimConversationOwner', () => {
  test('claims an unowned row, and says so', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    await expect(claimConversationOwner('conv-1', 'user-operator')).resolves.toBe(true);

    // The guard is in the SQL, not in a read-then-write: two turns racing
    // cannot take the row from one another, and an owned row is never
    // overwritten.
    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE remote_agent_conversations SET user_id = $1 WHERE id = $2 AND user_id IS NULL',
      ['user-operator', 'conv-1']
    );
  });

  test('a row that already belongs to someone is left alone', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
    await expect(claimConversationOwner('conv-1', 'user-someone-else')).resolves.toBe(false);
  });
});
