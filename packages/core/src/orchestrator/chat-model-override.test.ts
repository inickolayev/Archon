import { mock, describe, test, expect, beforeEach } from 'bun:test';
import type { Conversation } from '../types';
import { ConversationNotFoundError } from '../types';

const mockGetConversationById = mock<(id: string) => Promise<Conversation | null>>();
const mockSetConversationModelOverride = mock<(id: string, model: string | null) => Promise<void>>(
  () => Promise.resolve()
);
const mockFindConversationByPlatformId = mock<(id: string) => Promise<Conversation | null>>();
mock.module('../db/conversations', () => ({
  getConversationById: mockGetConversationById,
  findConversationByPlatformId: mockFindConversationByPlatformId,
  setConversationModelOverride: mockSetConversationModelOverride,
}));

const mockGetCodebase = mock(() => Promise.resolve(null));
mock.module('../db/codebases', () => ({ getCodebase: mockGetCodebase }));

const mockLoadConfig = mock((_cwd?: string) =>
  Promise.resolve({ assistants: { claude: { settingSources: ['project'] }, pi: {} } })
);
mock.module('../config/config-loader', () => ({ loadConfig: mockLoadConfig }));

const mockListProviderModels =
  mock<(id: string, cfg: Record<string, unknown>) => Promise<{ id: string }[] | null>>();
const realProviders = await import('@archon/providers');
mock.module('@archon/providers', () => ({
  ...realProviders,
  isRegisteredProvider: (id: string) => id === 'claude' || id === 'pi',
  listProviderModels: mockListProviderModels,
}));

const mockResolveChatTurnModel = mock(() =>
  Promise.resolve({
    chatRequest: { provider: 'claude', model: 'claude-haiku-4-5' },
    aiProfile: {},
    configuredProviderKey: 'claude',
  })
);
mock.module('./chat-model-resolution', () => ({ resolveChatTurnModel: mockResolveChatTurnModel }));

const {
  setChatModelOverride,
  resolveEffectiveChatModel,
  InvalidModelOverrideError,
  ModelOverrideCatalogUnavailableError,
  createChatModelControls,
} = await import('./chat-model-override');

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-db-1',
    platform_type: 'web',
    platform_conversation_id: 'web-1',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    model_override: null,
    title: null,
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    user_id: 'creator-1',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  mockGetConversationById.mockReset();
  mockGetConversationById.mockResolvedValue(makeConversation());
  mockFindConversationByPlatformId.mockReset();
  mockFindConversationByPlatformId.mockResolvedValue(makeConversation());
  mockSetConversationModelOverride.mockClear();
  mockListProviderModels.mockReset();
  mockListProviderModels.mockResolvedValue([
    { id: 'claude-sonnet-4-5' },
    { id: 'claude-haiku-4-5' },
  ]);
  mockResolveChatTurnModel.mockClear();
  mockLoadConfig.mockClear();
});

describe('setChatModelOverride', () => {
  test('stores a model the live catalog offers', async () => {
    await setChatModelOverride('conv-db-1', ' claude-haiku-4-5 ');

    // Checked against the provider config the turn itself would run with.
    expect(mockListProviderModels).toHaveBeenCalledWith('claude', { settingSources: ['project'] });
    expect(mockSetConversationModelOverride).toHaveBeenCalledWith('conv-db-1', 'claude-haiku-4-5');
  });

  test('rejects a model the live catalog does not offer, storing nothing', async () => {
    const err = await setChatModelOverride('conv-db-1', 'gpt-5.5').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidModelOverrideError);
    expect((err as Error).message).toContain('claude-haiku-4-5');
    expect(mockSetConversationModelOverride).not.toHaveBeenCalled();
  });

  test('refuses to accept unchecked when the catalog cannot be read', async () => {
    mockListProviderModels.mockRejectedValue(new Error('claude binary not found'));

    const err = await setChatModelOverride('conv-db-1', 'claude-haiku-4-5').catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(ModelOverrideCatalogUnavailableError);
    expect((err as Error).message).toContain('claude binary not found');
    expect(mockSetConversationModelOverride).not.toHaveBeenCalled();
  });

  test('accepts free text for a provider with no live catalog', async () => {
    mockGetConversationById.mockResolvedValue(makeConversation({ ai_assistant_type: 'pi' }));
    mockListProviderModels.mockResolvedValue(null);

    await setChatModelOverride('conv-db-1', 'anthropic/claude-haiku-4-5');

    expect(mockSetConversationModelOverride).toHaveBeenCalledWith(
      'conv-db-1',
      'anthropic/claude-haiku-4-5'
    );
  });

  test.each(['', '   ', 'large', '@fast'])('rejects %p (not a model id)', async model => {
    await expect(setChatModelOverride('conv-db-1', model)).rejects.toBeInstanceOf(
      InvalidModelOverrideError
    );
    expect(mockListProviderModels).not.toHaveBeenCalled();
    expect(mockSetConversationModelOverride).not.toHaveBeenCalled();
  });

  test('null clears the pin without consulting the catalog', async () => {
    await setChatModelOverride('conv-db-1', null);

    expect(mockListProviderModels).not.toHaveBeenCalled();
    expect(mockSetConversationModelOverride).toHaveBeenCalledWith('conv-db-1', null);
  });

  test('unknown conversation throws ConversationNotFoundError', async () => {
    mockGetConversationById.mockResolvedValue(null);

    await expect(setChatModelOverride('missing', null)).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
  });
});

describe('resolveEffectiveChatModel', () => {
  test('reports what the turn resolution returns, plus the stored pin', async () => {
    const conversation = makeConversation({ model_override: 'claude-haiku-4-5' });
    mockGetConversationById.mockResolvedValue(conversation);

    const effective = await resolveEffectiveChatModel('conv-db-1', 'viewer-1');

    expect(mockResolveChatTurnModel).toHaveBeenCalledWith(
      conversation,
      'viewer-1',
      expect.anything()
    );
    expect(effective).toEqual({
      provider: 'claude',
      model: 'claude-haiku-4-5',
      override: 'claude-haiku-4-5',
      conversationProvider: 'claude',
    });
  });

  test('falls back to the conversation creator when no viewer is known', async () => {
    await resolveEffectiveChatModel('conv-db-1', undefined);

    expect(mockResolveChatTurnModel).toHaveBeenCalledWith(
      expect.anything(),
      'creator-1',
      expect.anything()
    );
  });
});

describe('createChatModelControls', () => {
  test('describe offers the live list next to the effective model', async () => {
    const state = await createChatModelControls('web-1', 'viewer-1').describe();

    expect(state?.choices).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5']);
    expect(state?.effective.provider).toBe('claude');
  });

  test('describe says why the list is missing instead of offering nothing silently', async () => {
    mockListProviderModels.mockRejectedValue(new Error('claude binary not found'));

    const state = await createChatModelControls('web-1', undefined).describe();

    expect(state?.choices).toEqual([]);
    expect(state?.choicesError).toBe('claude binary not found');
  });

  test('describe answers null before the conversation exists', async () => {
    mockFindConversationByPlatformId.mockResolvedValue(null);

    expect(await createChatModelControls('123:2', undefined).describe()).toBeNull();
  });

  test('pin turns a refused model into a message', async () => {
    const outcome = await createChatModelControls('web-1', undefined).pin('gpt-5.5');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.message).toContain('not a claude model');
    expect(mockSetConversationModelOverride).not.toHaveBeenCalled();
  });

  test('pin stores an offered model', async () => {
    expect(await createChatModelControls('web-1', undefined).pin('claude-haiku-4-5')).toEqual({
      ok: true,
    });
    expect(mockSetConversationModelOverride).toHaveBeenCalledWith('conv-db-1', 'claude-haiku-4-5');
  });
});
