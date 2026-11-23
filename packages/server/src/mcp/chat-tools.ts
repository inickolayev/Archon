import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiCall } from './api-client';
import { apiFailure, asArray, asRecord, jsonResult, pick, respond } from './tool-kit';

const DEFAULT_WAIT_SECONDS = 120;
/**
 * The whole wait happens inside one HTTP response that writes nothing until it ends
 * (JSON mode), and Bun.serve closes a connection idle for `idleTimeout` seconds —
 * 255 at most (server index.ts). Staying under it keeps the tool from losing the
 * connection mid-wait; a longer turn answers `running` and is read with get_messages.
 */
const MAX_WAIT_SECONDS = 240;
const POLL_INTERVAL_MS = 1500;
const MESSAGE_FETCH_LIMIT = 500;

export interface ChatToolDeps {
  /** Replaceable so tests need not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const conversationFields = [
  'platform_conversation_id',
  'title',
  'codebase_id',
  'platform_type',
  'last_activity_at',
  'updated_at',
] as const;

function toMessage(row: unknown): Record<string, unknown> {
  return pick(row, ['id', 'role', 'content', 'created_at']);
}

/** Messages that follow `afterId` in `rows` (all of them when the id is unknown or absent). */
export function messagesAfter(rows: readonly unknown[], afterId: string | undefined): unknown[] {
  if (afterId === undefined) return [...rows];
  const index = rows.findIndex(row => asRecord(row).id === afterId);
  return index === -1 ? [...rows] : rows.slice(index + 1);
}

/**
 * Whether a turn is still running for `conversationId`.
 *
 * The server serialises turns per conversation through its lock manager: a turn
 * is either holding a slot (active) or waiting for one (queued), and the
 * conversation leaves both lists when its last turn ends. `GET
 * /api/dashboard/conversations` is that snapshot, keyed by the same platform
 * conversation id the message route takes. dispatchToOrchestrator registers the
 * conversation in the lock manager before the POST answers, so polling right
 * after the POST cannot miss a turn that is about to start. Background workflow
 * runs started by a turn bypass the lock; follow those with get_run.
 */
async function isTurnRunning(call: ApiCall, conversationId: string): Promise<boolean | null> {
  const result = await call('GET', '/api/dashboard/conversations');
  if (!result.ok) return null;
  const snapshot = asRecord(result.data);
  const holding = [
    ...asArray(snapshot.activeConversations),
    ...asArray(snapshot.queuedConversations),
  ];
  return holding.some(entry => asRecord(entry).conversationId === conversationId);
}

export function registerChatTools(server: McpServer, call: ApiCall, deps: ChatToolDeps = {}): void {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  server.registerTool(
    'list_projects',
    {
      description: 'List the projects (codebases) registered in the factory.',
      inputSchema: {},
    },
    async () =>
      respond(await call('GET', '/api/codebases'), data =>
        asArray(data).map(row => pick(row, ['id', 'name', 'default_cwd', 'repository_url']))
      )
  );

  server.registerTool(
    'list_conversations',
    {
      description: 'List conversations, newest activity first.',
      inputSchema: {
        mine: z.boolean().optional().describe('Only conversations owned by the token owner'),
        codebaseId: z.string().optional().describe('Only conversations of this project'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
      },
    },
    async ({ mine, codebaseId, limit }) =>
      respond(
        await call('GET', '/api/conversations', {
          query: { mine: mine === undefined ? undefined : String(mine), codebaseId },
        }),
        data =>
          asArray(data)
            .slice(0, limit ?? 20)
            .map(row => pick(row, conversationFields))
      )
  );

  server.registerTool(
    'create_conversation',
    {
      description:
        'Create an empty conversation, optionally bound to a project. Use send_message to talk in it.',
      inputSchema: {
        codebaseId: z.string().optional(),
        title: z.string().min(1).optional(),
      },
    },
    async ({ codebaseId, title }) => {
      const created = await call('POST', '/api/conversations', {
        body: codebaseId === undefined ? {} : { codebaseId },
      });
      if (!created.ok) return apiFailure(created);
      const conversationId = asRecord(created.data).conversationId;
      if (title !== undefined && typeof conversationId === 'string') {
        const renamed = await call(
          'PATCH',
          `/api/conversations/${encodeURIComponent(conversationId)}`,
          {
            body: { title },
          }
        );
        if (!renamed.ok) return apiFailure(renamed);
      }
      return jsonResult(pick(created.data, ['conversationId', 'id']));
    }
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to a conversation and wait for the assistant to finish its turn. ' +
        'Returns the new assistant messages, or {status:"running"} when the wait limit passes ' +
        'first; then read the answer later with get_messages.',
      inputSchema: {
        conversationId: z.string().min(1),
        message: z.string().min(1),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(`Default ${DEFAULT_WAIT_SECONDS}, maximum ${MAX_WAIT_SECONDS}`),
      },
    },
    async ({ conversationId, message, waitSeconds }) => {
      const path = `/api/conversations/${encodeURIComponent(conversationId)}`;
      const before = await call('GET', `${path}/messages`, { query: { limit: 1 } });
      if (!before.ok) return apiFailure(before);
      const lastSeen = asRecord(asArray(before.data).at(-1)).id;
      const baseline = typeof lastSeen === 'string' ? lastSeen : undefined;

      const sent = await call('POST', `${path}/message`, { body: { message } });
      if (!sent.ok) return apiFailure(sent);

      const deadline = now() + (waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
      for (;;) {
        const running = await isTurnRunning(call, conversationId);
        if (running === false) break;
        if (now() >= deadline) return jsonResult({ status: 'running', conversationId });
        await sleep(POLL_INTERVAL_MS);
      }

      const after = await call('GET', `${path}/messages`, {
        query: { limit: MESSAGE_FETCH_LIMIT },
      });
      if (!after.ok) return apiFailure(after);
      const reply = messagesAfter(asArray(after.data), baseline)
        .filter(row => asRecord(row).role === 'assistant')
        .map(toMessage);
      return jsonResult({ status: 'done', conversationId, reply });
    }
  );

  server.registerTool(
    'get_messages',
    {
      description: 'Read a conversation’s messages, oldest first.',
      inputSchema: {
        conversationId: z.string().min(1),
        limit: z.number().int().min(1).max(MESSAGE_FETCH_LIMIT).optional().describe('Default 20'),
        after: z.string().optional().describe('Only messages after this message id'),
      },
    },
    async ({ conversationId, limit, after }) => {
      const result = await call(
        'GET',
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        { query: { limit: after === undefined ? (limit ?? 20) : MESSAGE_FETCH_LIMIT } }
      );
      return respond(result, data =>
        messagesAfter(asArray(data), after)
          .slice(0, limit ?? 20)
          .map(toMessage)
      );
    }
  );
}
