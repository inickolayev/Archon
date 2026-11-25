import { describe, expect, test } from 'bun:test';
import { WORKFLOW_SOURCE_ADMITS_GLOBAL, workflowSourceAdmits } from './workflow-source-global';

const on = { [WORKFLOW_SOURCE_ADMITS_GLOBAL]: '1' };

describe('workflowSourceAdmits', () => {
  test('a project workflow is admitted with or without the flag', () => {
    expect(workflowSourceAdmits('project', {})).toBe(true);
    expect(workflowSourceAdmits('project', on)).toBe(true);
  });

  test('a global workflow is admitted only when the operator says so', () => {
    expect(workflowSourceAdmits('global', {})).toBe(false);
    expect(workflowSourceAdmits('global', on)).toBe(true);
    expect(workflowSourceAdmits('global', { [WORKFLOW_SOURCE_ADMITS_GLOBAL]: '0' })).toBe(false);
    expect(workflowSourceAdmits('global', { [WORKFLOW_SOURCE_ADMITS_GLOBAL]: 'yes' })).toBe(false);
  });

  test('bundled and installed copies stay refused even with the flag', () => {
    expect(workflowSourceAdmits('bundled', on)).toBe(false);
    expect(workflowSourceAdmits('installed', on)).toBe(false);
    expect(workflowSourceAdmits(undefined, on)).toBe(false);
  });
});
