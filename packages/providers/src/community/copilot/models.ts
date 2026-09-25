/**
 * Live Copilot model catalog via the SDK's `client.listModels()`. The catalog
 * is negotiated per GitHub subscription, so only the runtime can answer it.
 *
 * The SDK is imported lazily, like in `CopilotProvider.sendQuery`, so compiled
 * binaries never load it at module scope (see provider-lazy-load.test.ts).
 */
import { tmpdir } from 'node:os';
import type { ModelInfo } from '@github/copilot-sdk';
import { createLogger } from '@archon/paths';
import type { ProviderModel } from '../../types';
import { parseCopilotConfig } from './config';
import { buildCopilotClientOptions } from './provider';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot.models');
  return cachedLog;
}

/** Models the subscription's policy disables cannot run, so they are not offered. */
export function toProviderModels(models: readonly ModelInfo[]): ProviderModel[] {
  return models
    .filter(m => m.policy?.state !== 'disabled')
    .map(m => ({ id: m.id, ...(m.name && m.name !== m.id ? { displayName: m.name } : {}) }));
}

export async function listCopilotModels(
  assistantConfig: Record<string, unknown>
): Promise<ProviderModel[]> {
  const { clientOpts } = await buildCopilotClientOptions(
    parseCopilotConfig(assistantConfig),
    undefined,
    tmpdir()
  );
  const { CopilotClient: copilotClientCtor } = await import('@github/copilot-sdk');
  const client = new copilotClientCtor(clientOpts);
  try {
    await client.start();
    return toProviderModels(await client.listModels());
  } catch (error) {
    getLog().warn({ err: error }, 'copilot.models_list_failed');
    throw error;
  } finally {
    const stopErrors = await client.stop().catch((err: unknown) => [err]);
    if (stopErrors.length > 0)
      getLog().debug({ count: stopErrors.length }, 'copilot.client_stop_errors');
  }
}
