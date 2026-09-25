/**
 * Provider Registry
 *
 * Typed registry where each entry is a ProviderRegistration record (factory + metadata).
 * Replaces the hardcoded factory switch from Phase 1.
 *
 * Bootstrap: callers must call registerBuiltinProviders() at process entrypoints
 * (server startup, CLI init) before any provider lookups.
 */
import type {
  IAgentProvider,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
  ProviderModel,
} from './types';
import { ClaudeProvider } from './claude/provider';
import { CodexProvider } from './codex/provider';
import { parseClaudeRunConfig } from './claude/config';
import { parseCodexRunConfig } from './codex/config';
import { CLAUDE_CAPABILITIES } from './claude/capabilities';
import { CODEX_CAPABILITIES } from './codex/capabilities';
import { listClaudeModels } from './claude/models';
import { listCodexModels } from './codex/models';
import { registerCopilotProvider } from './community/copilot/registration';
import { registerOpencodeProvider } from './community/opencode/registration';
import { registerPiProvider } from './community/pi/registration';
import { InvalidProviderRunConfigError, UnknownProviderError } from './errors';
import { createLogger } from '@archon/paths';
import { EFFORT_LADDER } from '@archon/paths/effort';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.registry');
  return cachedLog;
}

/** Backing store for registered providers. */
const registry = new Map<string, ProviderRegistration>();

function assertValidCapabilities(entry: ProviderRegistration): void {
  if (entry.capabilities.sessionFork === true && !entry.capabilities.sessionResume) {
    throw new Error(`Provider '${entry.id}' cannot advertise sessionFork without sessionResume`);
  }
}

/**
 * Register a provider. Throws on duplicate registration.
 */
export function registerProvider(entry: ProviderRegistration): void {
  if (registry.has(entry.id)) {
    throw new Error(`Provider '${entry.id}' is already registered`);
  }
  assertValidCapabilities(entry);
  registry.set(entry.id, entry);
  getLog().debug({ provider: entry.id, builtIn: entry.builtIn }, 'provider.registered');
}

/**
 * Get an instantiated agent provider by ID.
 * @throws UnknownProviderError if not registered
 */
export function getAgentProvider(id: string): IAgentProvider {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  getLog().debug({ provider: id }, 'provider_selected');
  return entry.factory();
}

/**
 * Get the full registration entry for a provider.
 * @throws UnknownProviderError if not registered
 */
export function getRegistration(id: string): ProviderRegistration {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  return entry;
}

/**
 * Get provider capabilities without instantiating a provider.
 * @throws UnknownProviderError if not registered
 */
export function getProviderCapabilities(id: string): ProviderCapabilities {
  return getRegistration(id).capabilities;
}

/** Validate and normalize a run-owned model through the provider's strict parser. */
export function parseProviderRunModel(id: string, model: string): string {
  const parsed = getRegistration(id).parseRunConfig({ model });
  if (typeof parsed.model !== 'string' || parsed.model.trim().length === 0) {
    throw new InvalidProviderRunConfigError('model', 'provider did not accept the model');
  }
  return parsed.model;
}

/**
 * Get all registered providers.
 */
export function getRegisteredProviders(): ProviderRegistration[] {
  return [...registry.values()];
}

/**
 * Get API-safe provider info (excludes the factory).
 */
export function getProviderInfoList(): ProviderInfo[] {
  return getRegisteredProviders().map(({ id, displayName, capabilities, builtIn, listModels }) => ({
    id,
    displayName,
    capabilities,
    builtIn,
    ...(capabilities.effortControl ? { effortLevels: EFFORT_LADDER } : {}),
    listsModels: listModels !== undefined,
  }));
}

/**
 * Asking a runtime spawns its CLI (1–3s), and every model field on a settings
 * page asks, so answers are shared briefly. Failures are never cached: a retry
 * after fixing a login or binary path must ask again.
 */
const MODEL_LIST_TTL_MS = 5 * 60_000;
const modelListCache = new Map<string, { at: number; models: Promise<ProviderModel[]> }>();

/**
 * The models a provider's runtime offers right now, or null when the provider
 * has no live catalog (Pi and OpenCode expose theirs through their own routes).
 * @throws UnknownProviderError if not registered; the runtime's error if it cannot answer
 */
export async function listProviderModels(
  id: string,
  assistantConfig: Record<string, unknown>
): Promise<ProviderModel[] | null> {
  const { listModels } = getRegistration(id);
  if (listModels === undefined) return null;
  const key = `${id}\0${JSON.stringify(assistantConfig)}`;
  const cached = modelListCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.models;
  const models = listModels(assistantConfig);
  modelListCache.set(key, { at: Date.now(), models });
  models.catch(() => {
    if (modelListCache.get(key)?.models === models) modelListCache.delete(key);
  });
  return models;
}

/**
 * Check if a provider is registered.
 */
export function isRegisteredProvider(id: string): boolean {
  return registry.has(id);
}

/**
 * Register built-in providers (Claude, Codex). Idempotent — skips already-registered IDs.
 * Must be called at process entrypoints (server, CLI) before any provider lookups.
 */
export function registerBuiltinProviders(): void {
  const builtins: ProviderRegistration[] = [
    {
      id: 'claude',
      displayName: 'Claude (Anthropic)',
      factory: () => new ClaudeProvider(),
      capabilities: CLAUDE_CAPABILITIES,
      builtIn: true,
      parseRunConfig: parseClaudeRunConfig,
      listModels: listClaudeModels,
      credentials: {
        kind: 'static',
        specs: [
          {
            vendor: 'anthropic',
            displayName: 'Anthropic',
            kinds: ['api_key', 'subscription'],
          },
        ],
      },
    },
    {
      id: 'codex',
      displayName: 'Codex (OpenAI)',
      factory: () => new CodexProvider(),
      capabilities: CODEX_CAPABILITIES,
      builtIn: true,
      parseRunConfig: parseCodexRunConfig,
      listModels: listCodexModels,
      credentials: {
        kind: 'static',
        specs: [
          {
            // Subscription (ChatGPT) login runs Archon's own PKCE flow —
            // see @archon/core credentials/openai-oauth.ts (#1924).
            vendor: 'openai',
            displayName: 'OpenAI',
            kinds: ['api_key', 'subscription'],
          },
        ],
      },
    },
  ];

  for (const entry of builtins) {
    if (!registry.has(entry.id)) {
      assertValidCapabilities(entry);
      registry.set(entry.id, entry);
      getLog().debug({ provider: entry.id }, 'builtin_provider.registered');
    }
  }
}

/**
 * Register all bundled community providers in one call.
 *
 * Process entrypoints (server, CLI, config-loader) call this once after
 * `registerBuiltinProviders()`. Adding a new community provider means:
 *   1. Drop the implementation under `packages/providers/src/community/<id>/`.
 *   2. Export a `register<Name>Provider()` function from it.
 *   3. Import + call it here.
 *
 * That's the entire cross-cutting change outside the provider's own
 * directory. No entrypoint edits, no config-type edits — just add a line
 * to this function. That's the Phase 2 contract (#1195): community
 * providers are a localized addition.
 *
 * Each `register*Provider` is itself idempotent, so calling this
 * aggregator multiple times (e.g. from both CLI and config-loader paths)
 * is safe. Errors during registration are not caught here — a broken
 * community provider should fail loud at bootstrap, not silently
 * disappear.
 */
export function registerCommunityProviders(): void {
  registerOpencodeProvider();
  registerPiProvider();
  registerCopilotProvider();
}

/** @internal Test-only — clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
  modelListCache.clear();
}
