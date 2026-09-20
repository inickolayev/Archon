/**
 * Tests: GET /api/conversations/:id/image — the bytes behind an image a reply
 * pointed at.
 *
 * The interesting half is what it refuses. The agent picks the path, the
 * container can read the operator's whole workspace, and the route is the only
 * thing between the two, so every refusal here is a case someone could
 * otherwise walk through.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

/**
 * The system temp directory is ALWAYS an allowed root, so a fixture built under
 * the real one would be allowed no matter what the route decided — every
 * refusal below would pass for the wrong reason. `TMPDIR` is therefore moved to
 * an empty sandbox for the length of this file, and the fixtures are built
 * beside it under the real temp directory rather than inside it.
 */
const HOST_TMP = realpathSync(tmpdir());
const SANDBOX_TMP = mkdtempSync(join(HOST_TMP, 'archon-conv-image-tmproot-'));
const TMPDIR_BEFORE = process.env.TMPDIR;
process.env.TMPDIR = SANDBOX_TMP;

afterAll(async () => {
  if (TMPDIR_BEFORE === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = TMPDIR_BEFORE;
  await removeTempTree(SANDBOX_TMP);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let conversationRow: { codebase_id: string | null; cwd: string | null } | null = null;
let codebaseRow: { default_cwd: string } | null = null;

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  isTelegramConversationId: (id: string) => /^-?\d+(?::\d+)?$/.test(id),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: () => ({
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
  }),
}));

mockAllWorkflowModules();

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => conversationRow),
}));
mock.module('@archon/core/db/codebases', () => ({
  getCodebase: mock(async () => codebaseRow),
  listCodebases: mock(async () => []),
}));
mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
mock.module('@archon/core/db/messages', () => ({}));

import { registerApiRoutes } from './api';

const trackTempRoot = trackTempRoots();

function api(): OpenAPIHono {
  const app = new OpenAPIHono();
  registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
  return app;
}

function imageRequest(path: string): string {
  return `/api/conversations/web-test-abc/image?path=${encodeURIComponent(path)}`;
}

describe('GET /api/conversations/:id/image', () => {
  let project = '';
  let outside = '';

  beforeEach(async () => {
    const base = trackTempRoot(mkdtempSync(join(HOST_TMP, 'archon-conv-image-')));
    project = join(base, 'project');
    outside = join(base, 'outside');
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });
    conversationRow = { codebase_id: 'cb-1', cwd: null };
    codebaseRow = { default_cwd: project };
  });

  test('serves a PNG from the project, typed by its header and never sniffed', async () => {
    const path = join(project, 'shot.png');
    await writeFile(path, PNG);

    const response = await api().request(imageRequest(path));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PNG));
  });

  test('serves a screenshot from the temp directory of a conversation with no project', async () => {
    conversationRow = { codebase_id: null, cwd: null };
    codebaseRow = null;
    const shots = join(tmpdir(), 'archon-devshot-test');
    await mkdir(shots, { recursive: true });
    trackTempRoot(shots);
    const path = join(shots, 'desktop.png');
    await writeFile(path, PNG);

    expect((await api().request(imageRequest(path))).status).toBe(200);
  });

  test('refuses a path outside the conversation’s roots', async () => {
    const path = join(outside, 'shot.png');
    await writeFile(path, PNG);

    expect((await api().request(imageRequest(path))).status).toBe(404);
  });

  test('refuses a symlink inside the project that points out of it', async () => {
    const target = join(outside, 'secret.png');
    await writeFile(target, PNG);
    const link = join(project, 'innocent.png');
    await symlink(target, link);

    expect((await api().request(imageRequest(link))).status).toBe(404);
  });

  test('refuses a secret renamed to look like a picture', async () => {
    const path = join(project, 'ton_main_phrase.png');
    await writeFile(path, 'abandon abandon abandon ability able about');

    expect((await api().request(imageRequest(path))).status).toBe(404);
  });

  test('refuses a text file under its own name', async () => {
    const path = join(project, 'ton_main_phrase.txt');
    await writeFile(path, 'abandon abandon abandon');

    expect((await api().request(imageRequest(path))).status).toBe(404);
  });

  test('refuses an SVG, which the browser would run as a document', async () => {
    const path = join(project, 'diagram.svg');
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

    expect((await api().request(imageRequest(path))).status).toBe(404);
  });

  test('asks for a path before it does anything', async () => {
    const response = await api().request('/api/conversations/web-test-abc/image');
    expect(response.status).toBe(400);
  });

  test('says the same "not available" however the path failed', async () => {
    const missing = await api().request(imageRequest(join(project, 'absent.png')));
    const foreign = await api().request(imageRequest(join(outside, 'absent.png')));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await foreign.json());
  });

  test('refuses everything when the conversation cannot be read', async () => {
    conversationRow = null;
    codebaseRow = null;
    const path = join(project, 'shot.png');
    await writeFile(path, PNG);

    expect((await api().request(imageRequest(path))).status).toBe(404);
  });
});
