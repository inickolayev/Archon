import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { makeIdleLockStats } from '../test/conversation-lock-fixtures';
import { makeListDashboardRunsMock, mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// The MCP endpoint (/api/mcp) through the real route stack: the /api/* gate
// authenticates it, and tools reach the REST routes in-process with the
// caller's credentials. The token store is an in-memory stand-in.
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
  listCodebaseClaims: mock(async () => [
    {
      id: 'cb1',
      name: 'demo',
      kind: 'folder',
      default_cwd: '/w/demo',
      repository_url: null,
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    },
  ]),
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

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function rpc(app: OpenAPIHono, payload: unknown, headers: Record<string, string> = {}) {
  return app.request('/api/mcp', {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify(payload),
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

beforeEach(() => {
  gateEnabled = true;
  session = null;
  authInstance = { api: { getSession: async () => session } };
  stored = [
    {
      id: 't1',
      userId: 'owner',
      name: 'seed',
      token: 'arc_pat_good',
      revoked: false,
      expired: false,
    },
  ];
  created.length = 0;
});

describe('POST /api/mcp', () => {
  test('without credentials or with a bad token it is 401', async () => {
    const app = makeApp();
    expect((await rpc(app, INIT)).status).toBe(401);
    expect((await rpc(app, INIT, bearer('arc_pat_bad'))).status).toBe(401);
  });

  test('initialize and tools/list work for a valid token', async () => {
    const app = makeApp();
    const init = await rpc(app, INIT, bearer('arc_pat_good'));
    expect(init.status).toBe(200);
    expect(
      ((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name
    ).toBe('archon');
    const list = await rpc(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      bearer('arc_pat_good')
    );
    const names = (
      (await list.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map(t => t.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('approve_run');
  });

  test('a tool call reaches the REST route in-process with the caller’s token', async () => {
    const res = await rpc(
      makeApp(),
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_projects', arguments: {} },
      },
      bearer('arc_pat_good')
    );
    const body = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0]?.text ?? '[]')).toEqual([
      { id: 'cb1', name: 'demo', default_cwd: '/w/demo', repository_url: null },
    ]);
  });

  test('a tool call for a missing resource returns the API status as a tool error', async () => {
    const res = await rpc(
      makeApp(),
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_messages', arguments: { conversationId: 'nope' } },
      },
      bearer('arc_pat_good')
    );
    const body = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]?.text ?? '{}').status).toBe(404);
  });

  test('GET and DELETE are 405', async () => {
    const app = makeApp();
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request('/api/mcp', { method, headers: bearer('arc_pat_good') });
      expect(res.status).toBe(405);
    }
  });
});
