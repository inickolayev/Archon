import { describe, expect, test } from 'bun:test';
import type { AttentionNotice } from '@archon/core/services/attention-notices';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { telegramNoticeText } from './telegram-attention-text';

const RUN_ID = '5007e9a0-1111-2222-3333-444455556666';

function notice(
  kind: AttentionNotice['kind'],
  status: WorkflowRun['status'],
  metadata: Record<string, unknown>,
  outcomes: Pick<WorkflowRun, 'outcome' | 'completed_outcome'> = {
    outcome: null,
    completed_outcome: null,
  }
): AttentionNotice {
  return {
    kind,
    destination: 'telegram',
    key: 'key',
    run: {
      origin: null,
      id: RUN_ID,
      workflow_name: 'chesswin-ship',
      conversation_id: null,
      parent_conversation_id: null,
      codebase_id: null,
      status,
      ...outcomes,
      user_message: 'private input',
      metadata,
      active_phase_started_at: null,
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: '/private/path',
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: null,
      checkout_baseline: null,
      item_id: null,
    },
  };
}

describe('telegramNoticeText', () => {
  test('a gate names the run, says what it asks and how to answer it from this chat', () => {
    const text = telegramNoticeText(
      notice('gate', 'paused', {
        approval: { nodeId: 'review', pauseId: 'p1', message: 'Merge the plan?' },
      })
    );
    expect(text).toContain('chesswin-ship');
    expect(text).toContain('Merge the plan?');
    expect(text).toContain(`\`/workflow approve ${RUN_ID}\``);
    expect(text).toContain(`\`/workflow reject ${RUN_ID}\``);
    expect(text).not.toContain('private');
  });

  test('a gate with its own decisions is answered with respond', () => {
    const text = telegramNoticeText(
      notice('gate', 'paused', {
        approval: {
          nodeId: 'route',
          pauseId: 'p1',
          message: 'Which way?',
          decisions: [{ id: 'ship', label: 'Ship it' }, { id: 'reject' }],
        },
      })
    );
    expect(text).toContain(`Ship it (ship): \`/workflow respond ${RUN_ID} ship [text]\``);
    expect(text).toContain(`Reject: \`/workflow reject ${RUN_ID}\``);
  });

  test('an attention wait gets the engine’s own answer lines', () => {
    const text = telegramNoticeText(
      notice('attention', 'paused', {
        wait: {
          kind: 'attention',
          owner: 'node',
          nodeId: 'hold',
          pauseId: 'w1',
          waitingSince: '2026-11-23T01:00:00.000Z',
          message: 'Pick a base',
          form: 'select',
          options: [{ id: 'main' }, { id: 'dev', label: 'Dev branch' }],
        },
      })
    );
    expect(text).toContain('Pick a base');
    expect(text).toContain(`\`/workflow respond ${RUN_ID} main [text]\``);
    expect(text).toContain('Dev branch (dev)');
  });

  test('the end says how it ended, with its outcome when it has one', () => {
    const done = telegramNoticeText(
      notice('terminal', 'completed', {}, { outcome: 'succeeded', completed_outcome: 'built' })
    );
    expect(done).toContain('chesswin-ship');
    expect(done).toContain('completed');
    expect(done).toContain('built');
    expect(telegramNoticeText(notice('terminal', 'failed', {}))).toContain('failed');
  });
});
