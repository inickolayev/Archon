import { describe, expect, test } from 'bun:test';
import type { AttentionNoticeData } from '@archon/workflows/schemas/attention-notice';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { Conversation } from '../../types';
import type { WorkflowCommand } from './workflow-command';
import { watchWorkflowRun, type WatchDeps } from './workflow-watch';

const RUN_ID = '5007e9a0-1111-2222-3333-444455556666';

function command(platform: string, platformId: string, args: string[]): WorkflowCommand {
  return {
    operations: {} as WorkflowCommand['operations'],
    conversation: {
      id: 'conv-1',
      platform_type: platform,
      platform_conversation_id: platformId,
      codebase_id: 'cb-1',
    } as Conversation,
    args,
    surface: {},
    actor: {} as WorkflowCommand['actor'],
  };
}

function deps(status: WorkflowRun['status'] = 'running'): {
  deps: WatchDeps;
  recorded: { runId: string; data: AttentionNoticeData }[];
  allRuns: { chatId: string; watching: boolean }[];
} {
  const recorded: { runId: string; data: AttentionNoticeData }[] = [];
  const allRuns: { chatId: string; watching: boolean }[] = [];
  return {
    recorded,
    allRuns,
    deps: {
      watchAll: async (chatId, watching) => {
        allRuns.push({ chatId, watching });
      },
      resolveRunId: async arg => {
        if (!RUN_ID.startsWith(arg))
          throw new Error(`Workflow run not found in this project: ${arg}`);
        return RUN_ID;
      },
      getRun: async () => ({ id: RUN_ID, workflow_name: 'chesswin-ship', status }) as WorkflowRun,
      record: async (runId, data) => {
        recorded.push({ runId, data });
      },
      describe: async () => ({ success: true, message: 'chesswin-ship (paused)\n  Approve: …' }),
    },
  };
}

describe('watchWorkflowRun', () => {
  test('`watch all`: the chat is called by every run nobody started', async () => {
    const { deps: d, allRuns, recorded } = deps();
    const result = await watchWorkflowRun(command('telegram', '352', ['watch', 'all']), true, d);
    expect(result.success).toBe(true);
    expect(allRuns).toEqual([{ chatId: '352', watching: true }]);
    expect(recorded).toEqual([]);
    expect(result.message).toContain('nobody started');
    expect(result.message).toContain('/workflow unwatch all');
  });

  test('`unwatch all` stops it', async () => {
    const { deps: d, allRuns } = deps();
    const result = await watchWorkflowRun(command('telegram', '352', ['unwatch', 'all']), false, d);
    expect(result.success).toBe(true);
    expect(allRuns).toEqual([{ chatId: '352', watching: false }]);
  });

  test('`watch all` is refused outside Telegram', async () => {
    const { deps: d, allRuns } = deps();
    const result = await watchWorkflowRun(command('web', 'w-1', ['watch', 'all']), true, d);
    expect(result.success).toBe(false);
    expect(allRuns).toEqual([]);
  });

  test('a Telegram chat watches a run by its short id', async () => {
    const { deps: d, recorded } = deps();
    const result = await watchWorkflowRun(
      command('telegram', '-100:2', ['watch', '5007e9a0']),
      true,
      d
    );
    expect(result.success).toBe(true);
    expect(recorded).toEqual([
      {
        runId: RUN_ID,
        data: { destination: 'telegram', key: 'watch@-100', conversationId: '-100' },
      },
    ]);
    expect(result.message).toContain('chesswin-ship');
    expect(result.message).toContain(`/workflow unwatch ${RUN_ID}`);
  });

  test('the reply shows where the run stands, so a pause already passed is not missed', async () => {
    const { deps: d } = deps('paused');
    const result = await watchWorkflowRun(command('telegram', '42', ['watch', RUN_ID]), true, d);
    expect(result.message).toContain('Approve: …');
  });

  test('unwatch records the stop', async () => {
    const { deps: d, recorded } = deps();
    await watchWorkflowRun(command('telegram', '42', ['unwatch', RUN_ID]), false, d);
    expect(recorded[0]?.data.key).toBe('unwatch@42');
  });

  test('a finished run has nothing left to tell', async () => {
    const { deps: d, recorded } = deps('completed');
    const result = await watchWorkflowRun(command('telegram', '42', ['watch', RUN_ID]), true, d);
    expect(result.success).toBe(false);
    expect(result.message).toContain('completed');
    expect(recorded).toEqual([]);
  });

  test('only a Telegram chat can watch: nothing else is delivered to', async () => {
    const { deps: d, recorded } = deps();
    const result = await watchWorkflowRun(command('web', 'web-1', ['watch', RUN_ID]), true, d);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Telegram');
    expect(recorded).toEqual([]);
  });

  test('without an id it says how to use it; an unknown id says so', async () => {
    const { deps: d } = deps();
    const usage = await watchWorkflowRun(command('telegram', '42', ['watch']), true, d);
    expect(usage.message).toContain('/workflow watch <id|all>');
    const unknown = await watchWorkflowRun(command('telegram', '42', ['watch', 'ffff']), true, d);
    expect(unknown.success).toBe(false);
    expect(unknown.message).toContain('not found');
  });
});
