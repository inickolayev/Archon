/**
 * Live Claude model catalog.
 *
 * The Claude Code CLI answers `supportedModels()` from its `initialize`
 * handshake, before any prompt is read — so a session whose prompt stream
 * never yields lists the models without sending a turn (no tokens, no cost).
 * The answer depends on the CLI version and the account, which is why this
 * must run the SAME binary and credentials that workflow runs use: the CLI
 * bundled with the SDK can lag the installed one by whole model generations.
 */
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';
import type { ProviderModel } from '../types';
import { resolveClaudeBinaryPath } from './binary-resolver';
import { parseClaudeConfig } from './config';
import { buildRequestSubprocessEnv, shouldPassNoEnvFile } from './provider';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude.models');
  return cachedLog;
}

/** The handshake takes ~1–2s; anything past this is a hung or unauthenticated CLI. */
const LIST_TIMEOUT_MS = 30_000;

export async function listClaudeModels(
  assistantConfig: Record<string, unknown>
): Promise<ProviderModel[]> {
  const config = parseClaudeConfig(assistantConfig);
  const cliPath = await resolveClaudeBinaryPath(config.claudeBinaryPath);
  const controller = new AbortController();
  const stderrLines: string[] = [];

  // Never yields: the session exists only for its initialize handshake.
  // eslint-disable-next-line require-yield -- an empty prompt stream is the point
  async function* idlePrompt(): AsyncGenerator<never> {
    if (controller.signal.aborted) return;
    await new Promise<void>(resolve => {
      controller.signal.addEventListener('abort', () => {
        resolve();
      });
    });
  }

  const session = query({
    prompt: idlePrompt(),
    options: {
      // A neutral cwd: project settings must not shape an install-wide list.
      cwd: tmpdir(),
      env: buildRequestSubprocessEnv(undefined),
      ...(cliPath !== undefined ? { pathToClaudeCodeExecutable: cliPath } : {}),
      ...(shouldPassNoEnvFile(cliPath) ? { executableArgs: ['--no-env-file'] } : {}),
      // User settings can restrict the model menu (`availableModels`), so load them.
      settingSources: ['user'],
      abortController: controller,
      stderr: (data: string): void => {
        stderrLines.push(data.trim());
      },
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      session.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Claude CLI did not report its models within ${LIST_TIMEOUT_MS}ms`));
        }, LIST_TIMEOUT_MS);
      }),
    ]);
    return models.map(m => ({
      id: m.value,
      ...(m.displayName && m.displayName !== m.value ? { displayName: m.displayName } : {}),
      ...(m.description ? { description: m.description } : {}),
    }));
  } catch (error) {
    getLog().warn(
      { err: error, cliPath: cliPath ?? null, stderr: stderrLines.slice(-5).join('\n') },
      'claude.models_list_failed'
    );
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
