import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiCall } from './api-client';
import type { ChatToolDeps } from './chat-tools';
import { apiFailure, asArray, asRecord, jsonResult, pick, respond } from './tool-kit';

/**
 * How many times run_workflow looks for the run it started, and the pause between looks.
 * The run row appears only after dispatch and isolation setup: on the factory stand a
 * run of a zero-AI workflow appeared 17 s after its start was accepted. A minute keeps
 * well under Bun's 255 s idle timeout for the one HTTP response this tool call is.
 */
const RUN_LOOKUP_ATTEMPTS = 60;
const RUN_LOOKUP_INTERVAL_MS = 1000;
/** Newest runs of the workflow examined per look; the started one is among the newest. */
const RUN_LOOKUP_CANDIDATES = 5;

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

/**
 * The id of the run that `POST /api/workflows/{name}/run` just started in
 * `conversationId`. That route answers before the run exists and returns no id,
 * and the runs list carries no conversation platform ids, so this reads the
 * newest runs of the workflow and matches the detail's `parent_platform_id`
 * (web runs work in a child conversation) or `conversation_platform_id`.
 * Undefined when nothing matched in time — the run may still start; list_runs finds it.
 */
async function findStartedRun(
  call: ApiCall,
  workflowName: string,
  conversationId: string,
  sleep: (ms: number) => Promise<void>
): Promise<string | undefined> {
  const examined = new Set<string>();
  for (let attempt = 0; attempt < RUN_LOOKUP_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RUN_LOOKUP_INTERVAL_MS);
    const listed = await call('GET', '/api/workflows/runs', { query: { limit: 20 } });
    if (!listed.ok) return undefined;
    const candidates = asArray(asRecord(listed.data).runs)
      .map(asRecord)
      .filter(run => run.workflow_name === workflowName && typeof run.id === 'string')
      .map(run => run.id as string)
      .filter(id => !examined.has(id))
      .slice(0, RUN_LOOKUP_CANDIDATES);
    for (const id of candidates) {
      examined.add(id);
      const detail = await call('GET', runPath(id));
      const run = asRecord(asRecord(detail.data).run);
      if (
        run.parent_platform_id === conversationId ||
        run.conversation_platform_id === conversationId
      ) {
        return id;
      }
    }
  }
  return undefined;
}

export function registerRunTools(server: McpServer, call: ApiCall, deps: ChatToolDeps = {}): void {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

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
        '`inputs` fills the workflow’s declared inputs. Returns once the run exists, with its ' +
        '`runId` for get_run / approve_run / reject_run / cancel_run.',
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
      if (!result.ok) return apiFailure(result);
      const runId = await findStartedRun(call, name, target, sleep);
      return jsonResult({
        conversationId: target,
        ...asRecord(result.data),
        ...(runId === undefined
          ? { runId: null, note: 'Run id not found yet; look it up with list_runs.' }
          : { runId }),
      });
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
