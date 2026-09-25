import { describe, test, expect } from 'bun:test';
import type { ModelInfo } from '@github/copilot-sdk';
import { toProviderModels } from './models';

function model(id: string, name: string, policy?: ModelInfo['policy']): ModelInfo {
  return { id, name, capabilities: {} as ModelInfo['capabilities'], ...(policy ? { policy } : {}) };
}

describe('copilot toProviderModels', () => {
  test('drops models the subscription policy disables', () => {
    expect(
      toProviderModels([
        model('gpt-5', 'GPT-5', { state: 'enabled', terms: '' }),
        model('claude-sonnet-5', 'Claude Sonnet 5', { state: 'disabled', terms: '' }),
        model('auto', 'auto'),
      ])
    ).toEqual([{ id: 'gpt-5', displayName: 'GPT-5' }, { id: 'auto' }]);
  });
});
