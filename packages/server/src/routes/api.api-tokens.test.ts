import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { makeIdleLockStats } from '../test/conversation-lock-fixtures';
import { makeListDashboardRunsMock, mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Authorization order for personal access tokens (PATs) and the token
// management routes (/api/me/tokens). The token store itself is covered in
// core (pat-store.test.ts); here it is an in-memory stand-in.
// ---------------------------------------------------------------------------

const noopLogger = () => ({
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
});

let gateEnabled = true;
type FakeSession = { user: { id: string; name: string } } | null;
let session: FakeSession = null;
let authInstance: { api: { getSession: (args: unknown) => Promise<FakeSession> } } | null = null;

const real0 = { ...(await import('../auth')) };
const real1 = { ...(await import('@archon/core/db/users')) };
const real2 = { ...(await import('@archon/core/db/pat-store')) };
const real3 = { ...(await import('@archon/core')) };
const real4 = { ...(await import('@archon/paths')) };
const real5 = { ...(await import('@archon/git')) };
const real6 = { ...(await import('@archon/core/db/conversations')) };
const real7 = { ...(await import('@archon/core/db/codebases')) };
const real8 = { ...(await import('@archon/core/db/isolation-environments')) };
const real9 = { ...(await import('@archon/core/db/workflows')) };
const real10 = { ...(await import('@archon/core/db/workflow-events')) };
const real11 = { ...(await import('@archon/core/db/messages')) };
const real12 = { ...(await import('@archon/core/utils/commands')) };

mock.module('../auth', () => ({
  ...real0,
  getAuth: () => authInstance,
  isWebAuthEnabled: () => authInstance !== null,
  getSignupMode: () => 'disabled',
  isApiGateEnabled: () => gateEnabled,
  isConversationOwnershipEnforced: () => false,
}));

mock.module('@archon/core/db/users', () => ({
  ...real1,
  findOrCreateUserByPlatformIdentity: mock(async (_platform: string, platformUserId: string) => ({
    id: `user-from-${platformUserId}`,
    role: 'admin' as const,
  })),
  getUserById: mock(async (id: string) => ({ id, role: 'member' as const })),
}));

// --- In-memory token store ---
interface Stored {
  id: string;
  userId: string;
  name: string;
  token: string;
  revoked: boolean;
  expired: boolean;
}
let stored: Stored[] = [];
const created: { userId: string; name: string; expiresInDays: number | null }[] = [];

mock.module('@archon/core/db/pat-store', () => ({
  ...real2,
  looksLikeApiToken: (v: string) => v.startsWith('arc_pat_'),
  verifyApiToken: mock(async (token: string) => {
    const row = stored.find(s => s.token === token);
    if (!row || row.revoked || row.expired) return null;
    return { userId: row.userId, tokenId: row.id };
  }),
  createApiToken: mock(
    async (p: { userId: string; name: string; expiresInDays: number | null }) => {
      created.push(p);
      const id = `t${stored.length + 1}`;
      const token = `arc_pat_secret${id}`;
      stored.push({ id, userId: p.userId, name: p.name, token, revoked: false, expired: false });
      return {
        token,
        record: {
          id,
          name: p.name,
          prefix: token.slice(0, 12),
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: null,
          expiresAt: null,
        },
      };
    }
  ),
  listApiTokens: mock(async (userId: string) =>
    stored
      .filter(s => s.userId === userId && !s.revoked)
      .map(s => ({
        id: s.id,
        name: s.name,
        prefix: s.token.slice(0, 12),
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
      }))
  ),
  revokeApiToken: mock(async (userId: string, id: string) => {
    const row = stored.find(s => s.id === id && s.userId === userId && !s.revoked);
    if (!row) return false;
    row.revoked = true;
    return true;
  }),
}));

const mockGetPrefs = mock(async (_userId: string) => ({}));

mock.module('@archon/core', () => ({
  ...real3,
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'postgresql',
  loadConfig: mock(async () => ({})),
  ProjectRegistrationError: class ProjectRegistrationError extends Error {},
  inspectProjectBaseBranch: mock(async () => ({
    kind: 'repo',
    defaultBranch: 'dev',
    reason: null,
  })),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateTitleForUser: mock(async () => {}),
  resolveTitleRequest: mock(async () => ({ provider: 'claude', options: {} })),
  isPerUserGitHubEnabled: () => false,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: noopLogger,
  isPerUserProviderKeysEnabled: () => false,
  persistProviderApiKey: mock(async () => ({})),
  InvalidProviderKeyError: class InvalidProviderKeyError extends Error {},
  listUserProviderKeys: mock(async () => []),
  deleteUserProviderKey: mock(async () => {}),
  listConnectableVendors: () => ['anthropic'],
  buildAgentCredentialMatrix: () => [],
  normalizeCredentialVendor: (id: string) => id,
  SUBSCRIPTION_PROVIDERS: new Set<string>(['anthropic']),
  startOAuth: mock(async () => ({})),
  pollOAuth: mock(() => ({ status: 'pending' })),
  // A route that reports who the caller is, to observe the resolved identity.
  getUserAiPrefs: mockGetPrefs,
  setUserTiers: mock(async () => {}),
  setUserAliases: mock(async () => {}),
  setUserDefault: mock(async () => {}),
}));

mock.module('@archon/paths', () => ({
  ...real4,
  canonicalizeProjectPath: async (path: string) => path,
  createLogger: noopLogger,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getBundledWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: (owner: string, repo: string, runId: string): string =>
    `/tmp/.archon/workspaces/${owner}/${repo}/artifacts/runs/${runId}`,
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  ...real5,
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  ...real6,
  listConversations: mock(async () => []),
  findConversationByPlatformId: mock(async () => null),
  getOrCreateConversation: mock(async () => ({ id: 'c', platform_conversation_id: 'web-x' })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  ...real7,
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  ...real8,
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  ...real9,
  pauseWorkflowRunForOperator: mock(async () => ({ paused: false })),
  requestOperatorPause: mock(async () => undefined),
  getRunIdsByIsolationEnvId: mock(async (): Promise<string[]> => []),
  getWorkflowRunsByIds: mock(async () => []),
  getWorkflowRunForAttention: mock(async () => null),
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: makeListDashboardRunsMock(),
  getWorkflowRun: mock(async () => null),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  ...real10,
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/db/messages', () => ({
  ...real11,
  addMessage: mock(async () => ({ id: 'm' })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  ...real12,
  findCommandFiles: mock(async () => []),
}));

import { registerApiRoutes } from './api';

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(makeIdleLockStats),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

const WHOAMI = '/api/auth/me/ai-prefs';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const PROXY = { 'X-Archon-User': 'proxy-user' };

function seedToken(overrides: Partial<Stored> = {}): Stored {
  const row: Stored = {
    id: 'seed',
    userId: 'owner',
    name: 'seed',
    token: 'arc_pat_good',
    revoked: false,
    expired: false,
    ...overrides,
  };
  stored.push(row);
  return row;
}

beforeEach(() => {
  gateEnabled = true;
  session = null;
  authInstance = { api: { getSession: async () => session } };
  stored = [];
  created.length = 0;
  mockGetPrefs.mockClear();
});

describe('API token authentication order', () => {
  test('a valid token acts as its owner and wins over the proxy header', async () => {
    seedToken();
    const res = await makeApp().request(WHOAMI, {
      headers: { ...bearer('arc_pat_good'), ...PROXY },
    });
    expect(res.status).toBe(200);
    expect(mockGetPrefs).toHaveBeenCalledWith('owner');
  });

  for (const [label, patch] of [
    ['unknown', undefined],
    ['revoked', { revoked: true }],
    ['expired', { expired: true }],
  ] as const) {
    test(`a ${label} token is 401 even with a valid proxy header or session`, async () => {
      if (patch) seedToken(patch);
      session = { user: { id: 's1', name: 'S' } };
      const res = await makeApp().request(WHOAMI, {
        headers: { ...bearer('arc_pat_good'), ...PROXY },
      });
      expect(res.status).toBe(401);
      expect(mockGetPrefs).not.toHaveBeenCalled();
    });
  }

  test('a bad token is 401 even when the gate is off', async () => {
    gateEnabled = false;
    authInstance = null;
    const res = await makeApp().request(WHOAMI, {
      headers: { ...bearer('arc_pat_nope'), ...PROXY },
    });
    expect(res.status).toBe(401);
  });

  test('a bearer value that is not a token leaves the existing identity path alone', async () => {
    const res = await makeApp().request(WHOAMI, {
      headers: { ...bearer('something-else'), ...PROXY },
    });
    expect(res.status).toBe(200);
    expect(mockGetPrefs).toHaveBeenCalledWith('user-from-proxy-user');
  });
});

describe('token management routes', () => {
  const JSON_HEADERS = { 'Content-Type': 'application/json' };

  for (const [method, path] of [
    ['GET', '/api/me/tokens'],
    ['POST', '/api/me/tokens'],
    ['DELETE', '/api/me/tokens/seed'],
  ] as const) {
    test(`${method} ${path} is 403 for a token, even a valid one`, async () => {
      seedToken();
      const res = await makeApp().request(path, {
        method,
        headers: { ...bearer('arc_pat_good'), ...JSON_HEADERS },
        ...(method === 'POST' ? { body: JSON.stringify({ name: 'x' }) } : {}),
      });
      expect(res.status).toBe(403);
      expect(created).toEqual([]);
    });
  }

  test('without a session the routes are 401', async () => {
    const res = await makeApp().request('/api/me/tokens');
    expect(res.status).toBe(401);
  });

  test('the proxy header is not a session: 401', async () => {
    const res = await makeApp().request('/api/me/tokens', { headers: PROXY });
    expect(res.status).toBe(401);
  });

  test('a session creates (default 90 days), lists and revokes its own tokens', async () => {
    session = { user: { id: 'alice', name: 'Alice' } };
    const app = makeApp();
    const made = await app.request('/api/me/tokens', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'laptop' }),
    });
    expect(made.status).toBe(200);
    const body = (await made.json()) as { token: string; record: { id: string } };
    expect(body.token.startsWith('arc_pat_')).toBe(true);
    expect(created).toEqual([{ userId: 'user-from-alice', name: 'laptop', expiresInDays: 90 }]);

    const listed = await app.request('/api/me/tokens');
    const listText = await listed.text();
    expect(listText).toContain('laptop');
    expect(listText).not.toContain(body.token);

    const revoked = await app.request(`/api/me/tokens/${body.record.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    const again = await app.request(`/api/me/tokens/${body.record.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  test('null expiry means never and invalid bodies are rejected', async () => {
    session = { user: { id: 'alice', name: 'Alice' } };
    const app = makeApp();
    const never = await app.request('/api/me/tokens', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'ci', expiresInDays: null }),
    });
    expect(never.status).toBe(200);
    expect(created[0]?.expiresInDays).toBeNull();
    const bad = await app.request('/api/me/tokens', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: '' }),
    });
    expect(bad.status).toBe(400);
  });
});
