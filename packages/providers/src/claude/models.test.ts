import { describe, test, expect, mock } from 'bun:test';
import type { ModelInfo, Options } from '@anthropic-ai/claude-agent-sdk';
import { createMockLogger } from '../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
}));

interface QueryCall {
  prompt: AsyncIterable<unknown>;
  options: Options;
}
const calls: QueryCall[] = [];
let supportedModels: () => Promise<ModelInfo[]> = async () => [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: QueryCall) => {
    calls.push(params);
    return { supportedModels: () => supportedModels() };
  },
}));

import { listClaudeModels } from './models';

describe('listClaudeModels', () => {
  test('maps the CLI catalog and never sends a turn', async () => {
    calls.length = 0;
    supportedModels = async () => [
      {
        value: 'claude-fable-5-1',
        displayName: 'Fable',
        description: 'Fable 5.1 · hardest tasks',
      },
      { value: 'sonnet', displayName: 'sonnet', description: '' },
    ];

    const models = await listClaudeModels({});

    expect(models).toEqual([
      { id: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · hardest tasks' },
      { id: 'sonnet' },
    ]);
    expect(calls).toHaveLength(1);
    const [{ prompt, options }] = calls;
    // The session is torn down once the list is in…
    expect(options.abortController?.signal.aborted).toBe(true);
    // …and its prompt stream ends without ever yielding a message.
    const yielded: unknown[] = [];
    for await (const message of prompt) yielded.push(message);
    expect(yielded).toEqual([]);
    // User settings may restrict the menu; project settings must not shape it.
    expect(options.settingSources).toEqual(['user']);
  });

  test('surfaces the runtime failure and still tears the session down', async () => {
    calls.length = 0;
    supportedModels = async () => {
      throw new Error('Invalid API key');
    };

    await expect(listClaudeModels({})).rejects.toThrow('Invalid API key');
    expect(calls[0]?.options.abortController?.signal.aborted).toBe(true);
  });
});
