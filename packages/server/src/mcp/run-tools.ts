import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiCall } from './api-client';
import { apiFailure, asArray, asRecord, jsonResult, pick, respond } from './tool-kit';

const runFields = [
  'id',
  'workflow_name',
  'status',
  'conversation_id',
  'codebase_id',
  'started_at',
  'completed_at',
  'last_activity_at',
  'attention',
] as const;

const runPath = (runId: string): string => `/api/workflows/runs/${encodeURIComponent(runId)}`;

/** A run summary; `attention` names the gate or question a paused run waits at. */
function toRun(row: unknown): Record<string, unknown> {
  return pick(row, runFields);
}

export function registerRunTools(server: McpServer, call: ApiCall): void {
  server.registerTool(
    'list_workflows',
    {
      description: 'List the workflows that can be run, with their descriptions.',
      inputSchema: {
        cwd: z.string().optional().describe('A project directory (default_cwd of list_projects)'),
      },
    },
    async ({ cwd }) =>
      respond(await call('GET', '/api/workflows', { query: { cwd } }), data =>
        asArray(asRecord(data).workflows).map(entry => {
          const workflow = asRecord(asRecord(entry).workflow);
          return {
            name: workflow.name,
            description: workflow.description,
            source: asRecord(entry).source,
          };
        })
      )
  );

  server.registerTool(
    'run_workflow',
    {
      description:
        'Start a workflow run. It runs in a conversation: pass conversationId, or codebaseId ' +
        'to start in a fresh conversation of that project. `message` is the task text; ' +
        '`inputs` fills the workflow’s declared inputs. Returns at once; follow the run with ' +
        'list_runs / get_run.',
      inputSchema: {
        name: z.string().min(1).describe('Workflow name from list_workflows'),
        message: z.string().describe('What to do; may be empty if inputs carry everything'),
        conversationId: z.string().min(1).optional(),
        codebaseId: z.string().optional().describe('Used when conversationId is omitted'),
        inputs: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ name, message, conversationId, codebaseId, inputs }) => {
      let target = conversationId;
      if (target === undefined) {
        const created = await call('POST', '/api/conversations', {
          body: codebaseId === undefined ? {} : { codebaseId },
        });
        if (!created.ok) return apiFailure(created);
        const id = asRecord(created.data).conversationId;
        if (typeof id !== 'string') {
          return apiFailure({ status: 502, ok: false, data: { error: 'No conversation id' } });
        }
        target = id;
      }
      const result = await call('POST', `/api/workflows/${encodeURIComponent(name)}/run`, {
        body: { conversationId: target, message, ...(inputs === undefined ? {} : { inputs }) },
      });
      return respond(result, data => ({ conversationId: target, ...asRecord(data) }));
    }
  );

  server.registerTool(
    'list_runs',
    {
      description: 'List workflow runs, newest first.',
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe('e.g. running, paused, completed, failed, cancelled'),
        mine: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
      },
    },
    async ({ status, mine, limit }) =>
      respond(
        await call('GET', '/api/workflows/runs', {
          query: {
            status,
            mine: mine === undefined ? undefined : String(mine),
            limit: limit ?? 20,
          },
        }),
        data => asArray(asRecord(data).runs).map(toRun)
      )
  );

  server.registerTool(
    'get_run',
    {
      description: 'Status of one run: state, node states, and what it waits for if paused.',
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) =>
      respond(await call('GET', runPath(runId)), data => {
        const run = asRecord(asRecord(data).run);
        return { ...toRun(run), nodes: run.nodes, terminal_record: run.terminal_record };
      })
  );

  const actionResult = (data: unknown): unknown => data;

  server.registerTool(
    'approve_run',
    {
      description: 'Approve the gate a paused run is waiting at.',
      inputSchema: { runId: z.string().min(1), comment: z.string().optional() },
    },
    async ({ runId, comment }) =>
      respond(
        await call('POST', `${runPath(runId)}/approve`, {
          body: comment === undefined ? {} : { comment },
        }),
        actionResult
      )
  );

  server.registerTool(
    'reject_run',
    {
      description: 'Reject the gate a paused run is waiting at.',
      inputSchema: { runId: z.string().min(1), reason: z.string().optional() },
    },
    async ({ runId, reason }) =>
      respond(
        await call('POST', `${runPath(runId)}/reject`, {
          body: reason === undefined ? {} : { reason },
        }),
        actionResult
      )
  );

  server.registerTool(
    'cancel_run',
    {
      description: 'Cancel a run.',
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) => {
      const result = await call('POST', `${runPath(runId)}/cancel`);
      return result.ok ? jsonResult(result.data) : apiFailure(result);
    }
  );
}
