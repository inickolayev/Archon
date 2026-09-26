/**
 * Which provider and model a direct-chat turn runs on.
 *
 * Kept apart from the orchestrator so everything that must agree with a turn
 * about its model — the turn itself, and the pickers that show the model
 * before a turn runs — reads it from one place without importing the turn.
 */
import { createLogger } from '@archon/paths';
import {
  buildAiProfile,
  isLiteralSpec,
  isTierName,
  resolveModelSpec,
  resolveTierWithFallback,
  type ModelAliasPreset,
  type TierName,
} from '@archon/workflows/model-validation';
import type { MergedConfig } from '../config/config-types';
import { getUserAiPrefs, type UserAiPrefs } from '../db/user-ai-prefs-store';
import type { Conversation } from '../types';

/**
 * Lazy-initialized logger (deferred so test mocks can intercept createLogger).
 * Logs under the orchestrator's module name: these events moved here from it
 * and keep the name anything filtering on them already uses.
 */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator-agent');
  return cachedLog;
}

/**
 * Resolve the user's personal AI prefs (tiers / aliases / default assistant)
 * for a direct-chat turn (Phase 3). Folded into `buildAiProfile` as the
 * highest-precedence layer.
 *
 * NEVER THROWS — returns `{}` on any failure so model resolution falls back
 * to install-wide config exactly as before.
 */
export async function resolveUserAiPrefsForChat(userId: string): Promise<UserAiPrefs> {
  try {
    return await getUserAiPrefs(userId);
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'orchestrator.user_ai_prefs_resolve_failed');
    return {};
  }
}

export interface ResolvedModelRequest {
  provider: string;
  model: string | undefined;
  preset?: ModelAliasPreset;
  /** When `modelRef` was a tier: which tier in the fallback chain matched. */
  matchedTier?: TierName;
}

export function resolveModelRequest(
  aiProfile: ReturnType<typeof buildAiProfile>,
  modelRef: string,
  fallbackProvider: string
): ResolvedModelRequest {
  if (isTierName(modelRef)) {
    const { preset, matchedTier } = resolveTierWithFallback(aiProfile, modelRef);
    return { provider: preset.provider, model: preset.model, preset, matchedTier };
  }
  const spec = resolveModelSpec(aiProfile, modelRef);
  if (isLiteralSpec(spec)) {
    return { provider: fallbackProvider, model: spec.literal };
  }
  return { provider: spec.provider, model: spec.model, preset: spec };
}

/**
 * Resolve the model request for the MAIN chat turn (#1998).
 *
 * Model precedence (chat call-site only — workflows keep resolving `large`):
 *   0. the conversation's `model_override` — applied only when the
 *      conversation's own provider is the effective one, for the same reason
 *      as the per-user guard below. Always a literal model id (validated when
 *      set by `setChatModelOverride`), so it can never re-route the provider
 *      through a tier or alias, and it is never degraded: there is nothing to
 *      resolve, so nothing to fall back from.
 *   1. per-user `default_model` — applied only when the user's
 *      `default_provider` matches the effective provider (a stale pin must
 *      never ride a different provider). Routed through resolveModelRequest so
 *      `@alias` and tier refs keep working; an unresolvable ref (e.g. deleted
 *      alias) degrades to the tier path with a warning instead of failing chat.
 *   2. tier `large` from CONFIGURED tiers (user > repo > global).
 *   3. install `assistants.<p>.model` — outranks the BUILT-IN tier default
 *      only, never a configured tier ('inherit' means "SDK default", skip).
 *   4. built-in tier default.
 *
 * Title generation is NOT routed through this — it keeps the `small` tier.
 * With no pin, no user prefs and no `assistants.<p>.model`, this reduces
 * byte-for-byte to the previous `resolveModelRequest(aiProfile, 'large', provider)` call.
 */
export function resolveChatModelRequest(
  aiProfile: ReturnType<typeof buildAiProfile>,
  configuredProviderKey: string,
  userAiPrefs: UserAiPrefs,
  config: Pick<MergedConfig, 'assistants' | 'tiers'>,
  conversation: Pick<Conversation, 'id' | 'ai_assistant_type' | 'model_override'>
): ResolvedModelRequest {
  if (conversation.model_override !== null) {
    if (configuredProviderKey === conversation.ai_assistant_type) {
      return { provider: configuredProviderKey, model: conversation.model_override };
    }
    // Not an error — the operator's own default provider outranks the
    // conversation's — but a pin that silently stops applying is worth a line.
    getLog().info(
      {
        conversationId: conversation.id,
        conversationProvider: conversation.ai_assistant_type,
        effectiveProvider: configuredProviderKey,
      },
      'orchestrator.conversation_model_override_not_applied'
    );
  }
  if (
    userAiPrefs.defaultModel !== undefined &&
    userAiPrefs.defaultProvider === configuredProviderKey
  ) {
    try {
      return resolveModelRequest(aiProfile, userAiPrefs.defaultModel, configuredProviderKey);
    } catch (err) {
      getLog().warn(
        { err: err as Error, defaultModel: userAiPrefs.defaultModel },
        'orchestrator.user_default_model_invalid'
      );
    }
  }
  const request = resolveModelRequest(aiProfile, 'large', configuredProviderKey);
  if (request.matchedTier === undefined) return request;

  const tierConfigured =
    config.tiers?.[request.matchedTier] !== undefined ||
    userAiPrefs.tiers?.[request.matchedTier] !== undefined;
  if (tierConfigured) return request;

  const installModel = config.assistants[request.provider]?.model;
  if (typeof installModel === 'string' && installModel !== '' && installModel !== 'inherit') {
    return { ...request, model: installModel };
  }
  return request;
}

/** The model resolution of one chat turn, plus what title generation reuses. */
export interface ChatTurnModel {
  chatRequest: ResolvedModelRequest;
  aiProfile: ReturnType<typeof buildAiProfile>;
  configuredProviderKey: string;
}

/**
 * Resolve which provider and model a chat turn in `conversation` runs on.
 *
 * The one path from stored state to the model a turn sends: `handleMessage`
 * calls it for the turn itself, and the "effective model" shown by the model
 * pickers calls it too, so what a picker displays cannot drift from what the
 * next turn uses.
 */
export async function resolveChatTurnModel(
  conversation: Conversation,
  executionUserId: string | undefined,
  config: MergedConfig
): Promise<ChatTurnModel> {
  // Per-user AI prefs (Phase 3): the user's tiers/aliases/default-assistant
  // override install config (highest precedence). `{}` (no identity, no row,
  // or DB failure) keeps config-only behavior byte-for-byte.
  const userAiPrefs = executionUserId ? await resolveUserAiPrefsForChat(executionUserId) : {};

  let configuredProviderKey = userAiPrefs.defaultProvider ?? conversation.ai_assistant_type;
  let aiProfile: ReturnType<typeof buildAiProfile>;
  try {
    aiProfile = buildAiProfile(configuredProviderKey, {
      repoTiers: config.tiers,
      repoAliases: config.aliases,
      userTiers: userAiPrefs.tiers,
      userAliases: userAiPrefs.aliases,
    });
  } catch (profileErr) {
    // Structurally invalid STORED prefs (corrupt DB row) must not break the
    // user's chat — degrade to config-only. A broken config layer still
    // fails fast: the rebuild rethrows the same error.
    getLog().error(
      { err: profileErr as Error, userId: executionUserId },
      'orchestrator.user_ai_prefs_profile_invalid'
    );
    configuredProviderKey = conversation.ai_assistant_type;
    aiProfile = buildAiProfile(configuredProviderKey, {
      repoTiers: config.tiers,
      repoAliases: config.aliases,
    });
  }
  // Main chat model: conversation model_override > per-user default_model >
  // configured `large` tier > install assistants.<p>.model > built-in tier
  // default (#1998).
  const chatRequest = resolveChatModelRequest(
    aiProfile,
    configuredProviderKey,
    userAiPrefs,
    { assistants: config.assistants, tiers: config.tiers },
    conversation
  );
  return { chatRequest, aiProfile, configuredProviderKey };
}
