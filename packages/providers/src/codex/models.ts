/**
 * Live Codex model catalog via the Codex app-server's `model/list` request.
 *
 * The Codex SDK only drives `codex exec`, which has no catalog query, so this
 * speaks the app-server's JSON-RPC protocol (one JSON object per line over
 * stdio) for exactly one request. `model/list` is the stable catalog surface —
 * `codex debug models` dumps a raw internal shape and is not a contract.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { createLogger } from '@archon/paths';
import type { ProviderModel } from '../types';
import { resolveCodexBinaryPath } from './binary-resolver';
import { parseCodexConfig } from './config';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex.models');
  return cachedLog;
}

const LIST_TIMEOUT_MS = 30_000;
/** Guard against a server that keeps returning a cursor. */
const MAX_PAGES = 20;

/** The `model/list` fields Archon reads (the app-server returns more). */
interface CodexCatalogModel {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
}

interface ModelListPage {
  data: CodexCatalogModel[];
  nextCursor?: string | null;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * The command that starts the app-server. Compiled binaries resolve a native
 * Codex through the same tiers as runs (env, config, vendor dir); in dev mode
 * the resolver defers to the SDK's node_modules copy, which we reach through
 * the official `@openai/codex` npm launcher (it picks the platform binary).
 */
async function appServerCommand(
  configCodexBinaryPath: string | undefined
): Promise<{ command: string; args: string[] }> {
  const resolved = await resolveCodexBinaryPath(configCodexBinaryPath);
  if (resolved !== undefined) return { command: resolved, args: ['app-server'] };
  // The SDK's export map is import-only, so resolve it as ESM, then require
  // `@openai/codex` (its dependency, no export map) from the SDK's location.
  const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
  const launcher = sdkRequire.resolve('@openai/codex/bin/codex.js');
  return { command: process.execPath, args: [launcher, 'app-server'] };
}

/** Visible catalog entries → picker models, in the runtime's own order. */
export function toProviderModels(models: readonly CodexCatalogModel[]): ProviderModel[] {
  return models
    .filter(m => m.hidden !== true)
    .map(m => ({
      id: m.id,
      ...(m.displayName && m.displayName !== m.id ? { displayName: m.displayName } : {}),
      ...(m.description ? { description: m.description } : {}),
    }));
}

export async function listCodexModels(
  assistantConfig: Record<string, unknown>
): Promise<ProviderModel[]> {
  const { command, args } = await appServerCommand(
    parseCodexConfig(assistantConfig).codexBinaryPath
  );
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrLines: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrLines.push(chunk.trim());
  });

  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let nextId = 1;
  let failProcess: (error: Error) => void = () => undefined;
  const processFailed = new Promise<never>((_, reject) => {
    failProcess = reject;
  });
  // Observed here so an exit while no request is in flight is not an unhandled rejection.
  processFailed.catch(() => undefined);
  child.on('error', failProcess);
  child.on('exit', code => {
    failProcess(new Error(`codex app-server exited (code ${String(code)}) before answering`));
  });

  createInterface({ input: child.stdout }).on('line', line => {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // Not a protocol frame (startup banner); notifications are ignored too.
    }
    if (typeof message.id === 'number') pending.get(message.id)?.(message);
  });

  const request = async (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const answered = new Promise<JsonRpcResponse>(resolve => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await Promise.race([answered, processFailed]);
    pending.delete(id);
    if (response.error) {
      throw new Error(`codex app-server ${method} failed: ${response.error.message ?? 'unknown'}`);
    }
    return response.result;
  };

  const listAll = async (): Promise<CodexCatalogModel[]> => {
    await request('initialize', { clientInfo: { name: 'archon', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    const models: CodexCatalogModel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = (await request('model/list', cursor ? { cursor } : {})) as ModelListPage;
      models.push(...result.data);
      if (!result.nextCursor) return models;
      cursor = result.nextCursor;
    }
    throw new Error(`codex app-server model/list did not finish within ${MAX_PAGES} pages`);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      listAll(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`codex app-server did not list models within ${LIST_TIMEOUT_MS}ms`));
        }, LIST_TIMEOUT_MS);
      }),
    ]);
    return toProviderModels(models);
  } catch (error) {
    getLog().warn(
      { err: error, command, stderr: stderrLines.slice(-5).join('\n') },
      'codex.models_list_failed'
    );
    throw error;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}
