/**
 * The per-conversation chat model pin: one validated write path, one read path.
 *
 * Every surface that lets an operator pin a model (the console picker, the
 * Telegram `/model` command) calls `setChatModelOverride`; every surface that
 * shows which model a conversation runs on calls `resolveEffectiveChatModel`.
 * Neither re-derives anything: validation lives here, resolution lives in
 * `resolveChatTurnModel`, which is also what the turn itself calls.
 */
import { createLogger } from '@archon/paths';
import { isRegisteredProvider, listProviderModels } from '@archon/providers';
import { isTierName } from '@archon/workflows/model-validation';
import { loadConfig } from '../config/config-loader';
import * as codebaseDb from '../db/codebases';
import {
  findConversationByPlatformId,
  getConversationById,
  setConversationModelOverride,
} from '../db/conversations';
import { ConversationNotFoundError, type Conversation } from '../types';
import type { MergedConfig } from '../config/config-types';
import { resolveChatTurnModel } from './chat-model-resolution';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.chat-model-override');
  return cachedLog;
}

/** The model is not one the conversation's provider accepts; nothing was stored. */
export class InvalidModelOverrideError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    reason: string
  ) {
    super(`'${model}' is not a ${provider} model: ${reason}`);
    this.name = 'InvalidModelOverrideError';
  }
}

/**
 * The provider's live catalog could not be read, so the model could not be
 * checked; nothing was stored. Accepting it unchecked would pin a model that
 * may fail every later turn, which is worse than asking again.
 */
export class ModelOverrideCatalogUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: string,
    options?: { cause?: unknown }
  ) {
    super(`Could not check the ${provider} model list: ${reason}`, options);
    this.name = 'ModelOverrideCatalogUnavailableError';
  }
}

async function requireConversation(conversationId: string): Promise<Conversation> {
  const conversation = await getConversationById(conversationId);
  if (conversation === null) throw new ConversationNotFoundError(conversationId);
  return conversation;
}

/**
 * Pin `model` as the chat model of the conversation, or clear the pin (`null`).
 *
 * The pin is always a literal model id for the conversation's own provider.
 * Tier names and `@alias` refs are refused: they resolve through config that
 * may name a different provider, and the pin must never re-route one.
 * Where the provider has a live catalog the model must be in it; where it has
 * none (it is free-text for that provider everywhere else too) any id is
 * accepted.
 *
 * @throws ConversationNotFoundError, InvalidModelOverrideError, ModelOverrideCatalogUnavailableError
 */
export async function setChatModelOverride(
  conversationId: string,
  model: string | null
): Promise<void> {
  const conversation = await requireConversation(conversationId);
  const provider = conversation.ai_assistant_type;
  if (model === null) {
    await setConversationModelOverride(conversation.id, null);
    getLog().info({ conversationId: conversation.id, provider }, 'chat_model_override.cleared');
    return;
  }

  const id = model.trim();
  if (id === '') throw new InvalidModelOverrideError(provider, model, 'the model id is empty');
  if (isTierName(id) || id.startsWith('@')) {
    throw new InvalidModelOverrideError(
      provider,
      id,
      'tiers and aliases cannot be pinned; choose a model id'
    );
  }
  if (!isRegisteredProvider(provider)) {
    throw new InvalidModelOverrideError(provider, id, `provider '${provider}' is not registered`);
  }

  let catalog: { id: string }[] | null;
  try {
    // The provider config the turn itself will run with (binary path, config
    // dir), so the catalog checked is the one the turn's runtime offers.
    const config = await loadConversationConfig(conversation);
    catalog = await listProviderModels(provider, { ...(config.assistants[provider] ?? {}) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelOverrideCatalogUnavailableError(provider, reason, { cause: error });
  }
  if (catalog !== null && !catalog.some(m => m.id === id)) {
    throw new InvalidModelOverrideError(
      provider,
      id,
      `the runtime offers ${catalog.map(m => m.id).join(', ') || 'no models'}`
    );
  }

  await setConversationModelOverride(conversation.id, id);
  getLog().info(
    {
      conversationId: conversation.id,
      provider,
      model: id,
      checkedAgainstCatalog: catalog !== null,
    },
    'chat_model_override.set'
  );
}

/** Which provider and model the next chat turn in a conversation will run on. */
export interface EffectiveChatModel {
  provider: string;
  /** Absent when the provider's own default applies (no model is requested). */
  model?: string;
  /** The conversation's pin, whether or not it is the one in effect. */
  override: string | null;
  /** The conversation's own provider — the one a pin applies to. */
  conversationProvider: string;
}

/**
 * The config a turn in this conversation resolves against: the scoped
 * project's, else the install's — the same choice `handleMessage` makes.
 */
async function loadConversationConfig(conversation: Conversation): Promise<MergedConfig> {
  if (conversation.codebase_id !== null) {
    const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
    if (codebase) return loadConfig(conversation.cwd ?? codebase.default_cwd);
  }
  return loadConfig();
}

/**
 * Resolve the conversation's effective chat model for display, through the
 * exact function the turn itself uses.
 *
 * `userId` is the viewer, who is also the sender of the next turn from that
 * surface; like the turn, it falls back to the conversation's creator.
 */
export async function resolveEffectiveChatModel(
  conversationId: string,
  userId: string | undefined
): Promise<EffectiveChatModel> {
  const conversation = await requireConversation(conversationId);
  const config = await loadConversationConfig(conversation);
  const { chatRequest } = await resolveChatTurnModel(
    conversation,
    userId ?? conversation.user_id ?? undefined,
    config
  );
  return {
    provider: chatRequest.provider,
    ...(chatRequest.model !== undefined ? { model: chatRequest.model } : {}),
    override: conversation.model_override,
    conversationProvider: conversation.ai_assistant_type,
  };
}

/** What a model picker shows: the effective model, and the ids it may offer. */
export interface ChatModelChoices {
  effective: EffectiveChatModel;
  /** The provider's live list; null when it has none (any id is accepted). */
  choices: readonly string[] | null;
  /** Why the live list could not be read, when it could not. */
  choicesError?: string;
}

/** A pin attempt the operator can be told about; unexpected failures still throw. */
export type ChatModelPinOutcome = { ok: true } | { ok: false; message: string };

/**
 * The model controls of one conversation, for chat surfaces whose picker is a
 * message (Telegram's `/model`). Keyed by the platform conversation id those
 * surfaces hold; `describe` answers null while that conversation has no row
 * yet (a fresh chat nobody has written in).
 */
export interface ChatModelControls {
  describe(): Promise<ChatModelChoices | null>;
  pin(model: string | null): Promise<ChatModelPinOutcome>;
}

export function createChatModelControls(
  platformConversationId: string,
  userId: string | undefined
): ChatModelControls {
  const find = (): Promise<Conversation | null> =>
    findConversationByPlatformId(platformConversationId);
  return {
    async describe(): Promise<ChatModelChoices | null> {
      const conversation = await find();
      if (conversation === null) return null;
      const effective = await resolveEffectiveChatModel(conversation.id, userId);
      const provider = conversation.ai_assistant_type;
      if (!isRegisteredProvider(provider)) return { effective, choices: null };
      try {
        const config = await loadConversationConfig(conversation);
        const models = await listProviderModels(provider, {
          ...(config.assistants[provider] ?? {}),
        });
        return { effective, choices: models === null ? null : models.map(m => m.id) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        getLog().warn({ err: error, provider }, 'chat_model_override.choices_unavailable');
        return { effective, choices: [], choicesError: reason };
      }
    },
    async pin(model: string | null): Promise<ChatModelPinOutcome> {
      const conversation = await find();
      if (conversation === null) {
        return { ok: false, message: 'This chat has no conversation yet — send a message first.' };
      }
      try {
        await setChatModelOverride(conversation.id, model);
        return { ok: true };
      } catch (error) {
        if (
          error instanceof InvalidModelOverrideError ||
          error instanceof ModelOverrideCatalogUnavailableError
        ) {
          return { ok: false, message: error.message };
        }
        throw error;
      }
    },
  };
}
