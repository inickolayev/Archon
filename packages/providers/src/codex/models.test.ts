import { describe, test, expect } from 'bun:test';
import { toProviderModels } from './models';

describe('codex toProviderModels', () => {
  test('drops hidden catalog entries and keeps the runtime order', () => {
    expect(
      toProviderModels([
        { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Most capable.' },
        { id: 'gpt-daybreak-blue-latest', displayName: 'Daybreak Blue', hidden: true },
        { id: 'gpt-5.6-luna', displayName: 'gpt-5.6-luna', hidden: false },
      ])
    ).toEqual([
      { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Most capable.' },
      { id: 'gpt-5.6-luna' },
    ]);
  });
});
