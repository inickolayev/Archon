import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ApiCall, ApiResult } from './api-client';
import { createArchonMcpServer } from './archon-mcp-server';

type Handler = (
  method: string,
  path: string,
  query?: Record<string, string | number | undefined>,
  body?: unknown
) => ApiResult;

const ok = (data: unknown): ApiResult => ({ status: 200, ok: true, data });
const fail = (status: number, error: string): ApiResult => ({
  status,
  ok: false,
  data: { error },
});

async function connect(handler: Handler, nowValues?: () => number) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const call: ApiCall = async (method, path, options) => {
    calls.push({ method, path, body: options?.body });
    return handler(method, path, options?.query, options?.body);
  };
  const server = createArchonMcpServer(call, {
    sleep: async () => undefined,
    ...(nowValues ? { now: nowValues } : {}),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls };
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0]?.text ?? '';
}

describe('Archon MCP tools', () => {
  test('exposes the intended tool set', async () => {
    const { client } = await connect(() => ok([]));
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(
      [
        'approve_run',
        'cancel_run',
        'create_conversation',
        'get_messages',
        'get_run',
        'list_conversations',
        'list_projects',
        'list_runs',
        'list_workflows',
        'reject_run',
        'run_workflow',
        'send_message',
      ].sort()
    );
  });

  test('an API failure becomes a tool error with status and message', async () => {
    const { client } = await connect(() => fail(404, 'Conversation not found'));
    const result = await client.callTool({
      name: 'get_messages',
      arguments: { conversationId: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({ status: 404, error: 'Conversation not found' });
  });

  test('send_message waits for the lock to clear and returns only new assistant messages', async () => {
    let snapshots = 0;
    const { client, calls } = await connect((method, path, query) => {
      if (path === '/api/dashboard/conversations') {
        snapshots += 1;
        return ok({
          activeConversations: snapshots < 3 ? [{ conversationId: 'web-1' }] : [],
          queuedConversations: [],
        });
      }
      if (method === 'POST') return ok({ accepted: true, status: 'started' });
      if (query?.limit === 1) return ok([{ id: 'm1', role: 'assistant', content: 'old' }]);
      return ok([
        { id: 'm1', role: 'assistant', content: 'old' },
        { id: 'm2', role: 'user', content: 'hi' },
        { id: 'm3', role: 'assistant', content: 'hello', created_at: 't' },
      ]);
    });
    const result = await client.callTool({
      name: 'send_message',
      arguments: { conversationId: 'web-1', message: 'hi' },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result));
    expect(body.status).toBe('done');
    expect(body.reply).toEqual([
      { id: 'm3', role: 'assistant', content: 'hello', created_at: 't' },
    ]);
    expect(snapshots).toBe(3);
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ message: 'hi' });
  });

  test('a queued turn counts as running; the wait limit reports running', async () => {
    let clock = 0;
    const { client } = await connect(
      (method, path) => {
        if (path === '/api/dashboard/conversations') {
          return ok({
            activeConversations: [],
            queuedConversations: [{ conversationId: 'web-1' }],
          });
        }
        return method === 'POST' ? ok({ accepted: true, status: 'queued-conversation' }) : ok([]);
      },
      () => (clock += 400_000)
    );
    const result = await client.callTool({
      name: 'send_message',
      arguments: { conversationId: 'web-1', message: 'hi', waitSeconds: 200 },
    });
    expect(JSON.parse(textOf(result))).toEqual({ status: 'running', conversationId: 'web-1' });
  });

  test('run_workflow starts a conversation when none is given, passes inputs and returns the run id', async () => {
    const { client, calls } = await connect((method, path) => {
      if (path === '/api/conversations') return ok({ conversationId: 'web-9', id: 'u' });
      if (path === '/api/workflows/runs') {
        return ok({
          runs: [
            { id: 'r-other', workflow_name: 'other' },
            { id: 'r-old', workflow_name: 'sdlc' },
            { id: 'r-new', workflow_name: 'sdlc' },
          ],
        });
      }
      if (path === '/api/workflows/runs/r-old') return ok({ run: { parent_platform_id: 'web-1' } });
      if (path === '/api/workflows/runs/r-new') return ok({ run: { parent_platform_id: 'web-9' } });
      return method === 'POST' ? ok({ accepted: true, status: 'started' }) : fail(404, 'nope');
    });
    const result = await client.callTool({
      name: 'run_workflow',
      arguments: { name: 'sdlc', message: 'do #5', codebaseId: 'cb', inputs: { issue: '5' } },
    });
    expect(JSON.parse(textOf(result))).toEqual({
      conversationId: 'web-9',
      accepted: true,
      status: 'started',
      runId: 'r-new',
    });
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'POST /api/conversations',
      'POST /api/workflows/sdlc/run',
      'GET /api/workflows/runs',
      'GET /api/workflows/runs/r-old',
      'GET /api/workflows/runs/r-new',
    ]);
    expect(calls[0]?.body).toEqual({ codebaseId: 'cb' });
    expect(calls[1]?.body).toEqual({
      conversationId: 'web-9',
      message: 'do #5',
      inputs: { issue: '5' },
    });
  });

  test('run_workflow still answers when the started run cannot be found yet', async () => {
    const { client } = await connect((method, path) => {
      if (path === '/api/workflows/runs') return ok({ runs: [] });
      return method === 'POST' ? ok({ accepted: true, status: 'started' }) : fail(404, 'nope');
    });
    const result = await client.callTool({
      name: 'run_workflow',
      arguments: { name: 'sdlc', message: 'go', conversationId: 'web-2' },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ conversationId: 'web-2', runId: null });
  });

  test('gate tools post the route bodies', async () => {
    const { client, calls } = await connect(() => ok({ success: true }));
    await client.callTool({ name: 'approve_run', arguments: { runId: 'r1', comment: 'ok' } });
    await client.callTool({ name: 'reject_run', arguments: { runId: 'r1', reason: 'no' } });
    await client.callTool({ name: 'cancel_run', arguments: { runId: 'r1' } });
    expect(calls).toEqual([
      { method: 'POST', path: '/api/workflows/runs/r1/approve', body: { comment: 'ok' } },
      { method: 'POST', path: '/api/workflows/runs/r1/reject', body: { reason: 'no' } },
      { method: 'POST', path: '/api/workflows/runs/r1/cancel', body: undefined },
    ]);
  });
});
