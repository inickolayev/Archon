/**
 * chesswin: which scopes a run under an explicit --workflow-source may take its named workflow
 * from.
 *
 * Upstream #5854 admits only the source's own project scope: a mistyped source must not
 * silently run another scope's copy and record the source as its origin (#5826). The Factory
 * depends on one more: its own workflow pack is a global pack on purpose, layered over the
 * pinned engine it passes as --workflow-source (chesswin-factory ADR 0008, item 8), and source
 * capture already freezes that global scope with the run. So the operator may re-admit the
 * global scope — only it, never bundled or installed copies — with
 * ARCHON_WORKFLOW_SOURCE_ADMITS_GLOBAL=1. Unset, upstream's rule holds unchanged
 * (chesswin-factory#40).
 */
import type { WorkflowSource } from '@archon/workflows/schemas/workflow';

export const WORKFLOW_SOURCE_ADMITS_GLOBAL = 'ARCHON_WORKFLOW_SOURCE_ADMITS_GLOBAL';

export function workflowSourceAdmits(
  scope: WorkflowSource | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (scope === 'project') return true;
  return scope === 'global' && env[WORKFLOW_SOURCE_ADMITS_GLOBAL] === '1';
}
