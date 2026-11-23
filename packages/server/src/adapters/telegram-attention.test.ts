import { describe, expect, test } from 'bun:test';
import type { AttentionNoticeRecord } from '@archon/core/db/workflow-events';
import type { AttentionNotice } from '@archon/core/services/attention-notices';
import { TELEGRAM_ATTENTION_DESTINATION, watchRecord } from '@archon/core/services/run-watchers';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  TelegramAttentionDestination,
  telegramOperatorChats,
  type TelegramAttentionDeps,
} from './telegram-attention';

const RUN_ID = 'run-1';

function gateNotice(overrides: Partial<WorkflowRun> = {}): AttentionNotice {
  return {
    kind: 'gate',
    destination: TELEGRAM_ATTENTION_DESTINATION,
    key: 'review:1',
    run: {
      origin: null,
      id: RUN_ID,
      workflow_name: 'chesswin-ship',
      conversation_id: 'worker-conv',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'paused',
      outcome: null,
      completed_outcome: null,
      user_message: 'ship #12',
      metadata: { approval: { nodeId: 'review', pauseId: 'p1', message: 'Merge?' } },
      active_phase_started_at: null,
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: null,
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: null,
      checkout_baseline: null,
      item_id: null,
      ...overrides,
    },
  };
}

interface Harness {
  sent: { chat: string; text: string }[];
  destination: TelegramAttentionDestination;
}

function harness(
  options: {
    operators?: string[];
    ledger?: AttentionNoticeRecord[];
    chats?: Record<string, string>;
    failFor?: string[];
    /** Extra fields of the error a failing chat throws (grammY's `error_code`). */
    failure?: Record<string, unknown>;
    telegramUp?: boolean;
  } = {}
): Harness {
  const sent: Harness['sent'] = [];
  const deps: TelegramAttentionDeps = {
    operators: options.operators ?? ['100'],
    sender: () =>
      options.telegramUp === false
        ? null
        : {
            sendMessage: async (chat: string, text: string): Promise<void> => {
              if (options.failFor?.includes(chat))
                throw Object.assign(new Error(`chat ${chat} blocked the bot`), options.failure);
              sent.push({ chat, text });
            },
          },
    ledger: async () => options.ledger ?? [],
    chatOf: async conversationId => options.chats?.[conversationId],
    activateBaseline: async () => undefined,
  };
  return { sent, destination: new TelegramAttentionDestination(deps) };
}

describe('TelegramAttentionDestination', () => {
  test('is active only while the bot runs', async () => {
    expect(await harness().destination.state()).toBe('active');
    expect(await harness({ telegramUp: false }).destination.state()).toBe('plugin_down');
  });

  test('a gate of a run started anywhere reaches the operator chat with its answer', async () => {
    const { sent, destination } = harness();
    await destination.deliver(gateNotice());
    expect(sent.map(m => m.chat)).toEqual(['100']);
    expect(sent[0]?.text).toContain(`/workflow approve ${RUN_ID}`);
  });

  test('the Telegram chat that started a background run is called to its gate', async () => {
    const { sent, destination } = harness({ operators: [], chats: { 'parent-conv': '200' } });
    await destination.deliver(gateNotice({ parent_conversation_id: 'parent-conv' }));
    expect(sent.map(m => m.chat)).toEqual(['200']);
  });

  test('a watcher hears the gate too, and the chat the run talks in is not told twice', async () => {
    const { sent, destination } = harness({
      ledger: [{ runId: RUN_ID, data: watchRecord('300', true) }],
      chats: { 'run-conv': '100' },
    });
    await destination.deliver(gateNotice({ conversation_id: 'run-conv' }));
    expect(sent.map(m => m.chat)).toEqual(['300']);
  });

  test('one blocked chat does not stop the others, and does not fail the notice', async () => {
    const { sent, destination } = harness({
      ledger: [{ runId: RUN_ID, data: watchRecord('300', true) }],
      failFor: ['100'],
    });
    await destination.deliver(gateNotice());
    expect(sent.map(m => m.chat)).toEqual(['300']);
  });

  test('when no chat took it, delivery fails so the router tries again next scan', async () => {
    const { destination } = harness({ failFor: ['100'] });
    await expect(destination.deliver(gateNotice())).rejects.toThrow('no Telegram chat');
  });

  test('a chat that blocked the bot is not retried every scan forever', async () => {
    const { destination } = harness({ failFor: ['100'], failure: { error_code: 403 } });
    expect(await destination.deliver(gateNotice())).toEqual({});
  });

  test('nobody to tell is not a failure', async () => {
    const { sent, destination } = harness({ operators: [] });
    await destination.deliver(gateNotice());
    expect(sent).toEqual([]);
  });
});

describe('telegramOperatorChats', () => {
  test('takes the telegram routes of attentionNotices, and only them', () => {
    expect(
      telegramOperatorChats([
        { platform: 'telegram', destination: '100' },
        { platform: 'slack', destination: 'C1' },
        { platform: 'telegram', destination: '-200' },
      ])
    ).toEqual(['100', '-200']);
  });
});
