/**
 * ChessWin fork (chesswin-factory issue #32): the words a Telegram chat gets when a run it
 * hears from pauses or ends. Each pause carries the commands that answer it, spelled the way
 * the core chat grammar parses them, so the answer works from whichever chat received it —
 * a run belongs to no conversation (ADR 0011).
 */
import type { AttentionNotice } from '@archon/core/services/attention-notices';
import { attentionAnswerLines, spellWorkflowCommand } from '@archon/workflows/deps';
import { runAttention } from '@archon/workflows/schemas/workflow-run';
import { chatAttentionNotice } from '../chat-host/attention-destination';

/** Telegram has no command spelling of its own: `/workflow <command>`. */
const SURFACE = {};
const command = (text: string): string => `\`${spellWorkflowCommand(SURFACE, text)}\``;

function decisionLine(runId: string, decision: { id: string; label?: string }): string {
  const plain =
    decision.id === 'approve' ? 'Approve' : decision.id === 'reject' ? 'Reject' : decision.id;
  const display = decision.label ? `${decision.label} (${decision.id})` : plain;
  const answer =
    decision.id === 'approve' || decision.id === 'reject'
      ? `${decision.id} ${runId}`
      : `respond ${runId} ${decision.id} [text]`;
  return `${display}: ${command(answer)}`;
}

function gateText(notice: AttentionNotice): string {
  const gate = chatAttentionNotice(notice);
  if (gate.type !== 'gate') throw new Error(`Run ${notice.run.id} is not at a gate`);
  return [
    `⏸ **${gate.workflowName}** waits for a decision at \`${gate.nodeId}\``,
    gate.message,
    '',
    ...gate.decisions.map(decision => decisionLine(gate.runId, decision)),
    `Details: ${command(`get ${gate.runId}`)}`,
  ].join('\n');
}

function attentionText(notice: AttentionNotice): string {
  const attention = runAttention(notice.run);
  if (attention?.kind !== 'attention')
    throw new Error(`Run ${notice.run.id} is no longer waiting for an answer`);
  return [
    `❓ **${notice.run.workflow_name}** needs an answer at \`${attention.nodeId}\``,
    attention.message,
    '',
    ...attentionAnswerLines(SURFACE, attention),
    `Details: ${command(`get ${notice.run.id}`)}`,
  ].join('\n');
}

const STATUS_MARK = { completed: '✅', failed: '❌', cancelled: '⏹' } as const;

function terminalText(notice: AttentionNotice): string {
  const end = chatAttentionNotice(notice);
  if (end.type !== 'terminal') throw new Error(`Run ${notice.run.id} has not finished`);
  const outcome = end.completedOutcome ? ` — ${end.completedOutcome}` : '';
  const cost = end.totalCostUsd !== undefined ? ` · $${end.totalCostUsd.toFixed(2)}` : '';
  return [
    `${STATUS_MARK[end.status]} **${end.workflowName}** ${end.status}${outcome}${cost}`,
    `Details: ${command(`get ${end.runId}`)}`,
  ].join('\n');
}

/** The message for one selected notice; throws when the run moved on since selection. */
export function telegramNoticeText(notice: AttentionNotice): string {
  switch (notice.kind) {
    case 'gate':
      return gateText(notice);
    case 'attention':
      return attentionText(notice);
    case 'terminal':
      return terminalText(notice);
  }
}
