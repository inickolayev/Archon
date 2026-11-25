/**
 * ChessWin fork (chesswin-factory ADR 0011 §6, issue #32): `/workflow watch <id>` and
 * `/workflow unwatch <id>`; `watch all` / `unwatch all` for every run nobody started.
 *
 * Any Telegram chat can ask a run to call it — its gates, its questions and its end — by the
 * run's id, whoever started it and from wherever. Watching is not owning: the run neither
 * waits for its watchers nor ends with them, and any chat may answer it (ADR 0011 §3).
 * Delivery is the bundled Telegram adapter's attention destination; this only records the
 * wish in the attention ledger (`watchRecord`).
 */
import type { AttentionNoticeData } from '@archon/workflows/schemas/attention-notice';
import { isTerminalRunStatus, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { parseTelegramConversationId } from '../../conversations/telegram-conversation-id';
import { persistWorkflowEvent } from '../../db/workflow-events';
import * as workflowDb from '../../db/workflows';
import { setAllRunsWatch } from '../../services/all-runs-watchers';
import { watchRecord } from '../../services/run-watchers';
import type { CommandResult } from '../../types';
import { getLog } from './log';
import { spell, type WorkflowCommand } from './workflow-command';
import { getWorkflowRun, resolveChatRunId } from './workflow-runs';

export interface WatchDeps {
  resolveRunId: typeof resolveChatRunId;
  getRun: (runId: string) => Promise<WorkflowRun | null>;
  record: (runId: string, data: AttentionNoticeData) => Promise<void>;
  /** Where the run stands now, with the commands that answer a pause it is already at. */
  describe: (input: WorkflowCommand) => Promise<CommandResult>;
  /** Start or stop a chat's watch of every run nobody started (the CLI, the nightly timer). */
  watchAll: (chatId: string, watching: boolean) => Promise<void>;
}

const defaultDeps: WatchDeps = {
  resolveRunId: resolveChatRunId,
  getRun: runId => workflowDb.getWorkflowRun(runId),
  record: (runId, data) =>
    persistWorkflowEvent({ workflow_run_id: runId, event_type: 'attention_notice_sent', data }),
  describe: getWorkflowRun,
  watchAll: (chatId, watching) => setAllRunsWatch(chatId, watching),
};

const ALL = 'all';

export async function watchWorkflowRun(
  input: WorkflowCommand,
  watching: boolean,
  deps: WatchDeps = defaultDeps
): Promise<CommandResult> {
  const verb = watching ? 'watch' : 'unwatch';
  const { conversation } = input;
  const chat =
    conversation.platform_type === 'telegram'
      ? parseTelegramConversationId(conversation.platform_conversation_id)
      : null;
  if (chat === null)
    return {
      success: false,
      message: 'Only a Telegram chat can watch a run: that is where its gates and end are sent.',
    };
  const arg = input.args[1];
  if (!arg) return { success: false, message: `Usage: ${spell(input, `${verb} <id|all>`)}` };
  try {
    if (arg === ALL) return await watchAllRuns(input, String(chat.chatId), watching, deps);
    const runId = await deps.resolveRunId(arg, conversation);
    const run = await deps.getRun(runId);
    if (!run) return { success: false, message: `Workflow run not found: ${arg}` };
    if (watching && isTerminalRunStatus(run.status))
      return {
        success: false,
        message: `\`${run.workflow_name}\` has already ${run.status}: ${spell(input, `get ${run.id}`)}`,
      };
    await deps.record(run.id, watchRecord(String(chat.chatId), watching));
    if (!watching)
      return { success: true, message: `This chat no longer watches \`${run.workflow_name}\`.` };
    const now = await deps.describe({ ...input, args: ['get', run.id] });
    return {
      success: true,
      message:
        `Watching \`${run.workflow_name}\`: its gates, questions and end come to this chat.\n` +
        `Stop: \`${spell(input, `unwatch ${run.id}`)}\`\n\n${now.message}`,
    };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId: arg }, `cmd.workflow_${verb}_failed`);
    return { success: false, message: `Could not ${verb} the run: ${err.message}` };
  }
}

async function watchAllRuns(
  input: WorkflowCommand,
  chatId: string,
  watching: boolean,
  deps: WatchDeps
): Promise<CommandResult> {
  await deps.watchAll(chatId, watching);
  return {
    success: true,
    message: watching
      ? 'This chat is called by every run nobody started (the CLI, the nightly timer): its ' +
        `gates, its questions, and its end if it paused.\nStop: \`${spell(input, 'unwatch all')}\``
      : 'This chat is no longer called by runs nobody started.',
  };
}
