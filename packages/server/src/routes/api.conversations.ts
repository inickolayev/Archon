import { readFile } from 'fs/promises';
import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { RunActor } from '@archon/core';
import {
  ConversationNotFoundError,
  generateTitleForUser,
  resolveTitleRequest,
  stopTurn,
} from '@archon/core';
import * as codebaseDb from '@archon/core/db/codebases';
import * as conversationDb from '@archon/core/db/conversations';
import * as messageDb from '@archon/core/db/messages';
import { resolveOutboundImage } from '@archon/core/messaging/image-access';
import { getArchonWorkspacesPath } from '@archon/paths';
import type { WebAdapter } from '../adapters/web';
import { isConversationOwnershipEnforced } from '../auth';
import { conversationImageRoots } from '../messaging/conversation-image-roots';
import type { OrchestratorDispatch } from './api-message-dispatch';
import {
  authorizeConversation,
  requireConversationVisibility,
  resolveRunActor,
  resolveWebUserId,
} from './api-request-auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { toApiConversation } from './api-serializers';
import {
  conversationIdParamsSchema,
  conversationListResponseSchema,
  conversationSchema,
  createConversationBodySchema,
  createConversationResponseSchema,
  listConversationsQuerySchema,
  stopTurnResponseSchema,
  successResponseSchema,
  updateConversationBodySchema,
} from './schemas/conversation.schemas';

const getConversationsRoute = createRoute({
  method: 'get',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'List conversations',
  request: { query: listConversationsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationListResponseSchema } },
      description: 'OK',
    },
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const getConversationRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Get a conversation by platform conversation ID',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationSchema } },
      description: 'Conversation',
    },
    404: jsonError('Not found'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const createConversationRoute = createRoute({
  method: 'post',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'Create a new conversation',
  request: {
    body: {
      content: { 'application/json': { schema: createConversationBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Created conversation',
    },
    400: jsonError('Bad request'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const updateConversationRoute = createRoute({
  method: 'patch',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Update a conversation (title)',
  request: {
    params: conversationIdParamsSchema,
    body: {
      content: { 'application/json': { schema: updateConversationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Updated',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const deleteConversationRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Soft-delete a conversation',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const stopTurnRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/stop',
  tags: ['Conversations'],
  summary: 'Call off the turn running in a conversation',
  description:
    'Aborts the agent call in flight for this conversation. Answers `{ stopped: false }` ' +
    'when nothing was running, which is not an error.',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: stopTurnResponseSchema } },
      description: 'Stop requested',
    },
    404: jsonError('Not found'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

/**
 * Under ownership enforcement, the caller must be allowed this access to the
 * conversation; off enforcement every caller is (the solo install). Returns the
 * refusal to send, or null to proceed.
 */
async function refuseConversationAccess(
  c: Context,
  platformId: string,
  access: 'read' | 'write'
): Promise<Response | null> {
  if (!isConversationOwnershipEnforced()) return null;
  const result = await authorizeConversation(c, { platformId }, access);
  return 'error' in result ? result.error : null;
}

export function registerConversationRoutes(
  app: OpenAPIHono,
  {
    webAdapter,
    dispatchToOrchestrator,
  }: { webAdapter: WebAdapter; dispatchToOrchestrator: OrchestratorDispatch }
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/conversations - List conversations
  registerOpenApiRoute(getConversationsRoute, async c => {
    try {
      const platformType = c.req.query('platform') ?? undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const visibility = await requireConversationVisibility(c);
      if ('error' in visibility) return visibility.error;
      // `mine=true` narrows every platform to the caller. Off enforcement it is
      // best-effort: it applies only when an identity happens to resolve.
      let userId: string | undefined;
      if (c.req.query('mine') === 'true') {
        userId = visibility.kind === 'owner' ? visibility.userId : await resolveWebUserId(c);
      }
      const conversations = await conversationDb.listConversations(visibility, {
        platformType,
        codebaseId,
        excludeEmpty: true,
        userId,
      });
      return c.json(conversations.map(toApiConversation));
    } catch (error) {
      getLog().error({ err: error }, 'list_conversations_failed');
      return apiError(c, 500, 'Failed to list conversations');
    }
  });

  // GET /api/conversations/:id - Get single conversation by platform conversation ID
  registerOpenApiRoute(getConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const access = await authorizeConversation(c, { platformId }, 'read');
      if ('error' in access) return access.error;
      return c.json(toApiConversation(access.conversation));
    } catch (error) {
      getLog().error({ err: error, platformId }, 'get_conversation_failed');
      return apiError(c, 500, 'Failed to get conversation');
    }
  });

  // POST /api/conversations - Create new conversation
  // Accepts optional `message` field for atomic create+send (avoids ghost "Untitled" entries)
  registerOpenApiRoute(createConversationRoute, async c => {
    try {
      const { codebaseId, message } = getValidatedBody(c, createConversationBodySchema);
      const visibility = await requireConversationVisibility(c);
      if ('error' in visibility) return visibility.error;
      // Under enforcement the strictly resolved caller owns the row; a second,
      // soft resolution could fail and leave it ownerless.
      const actor: RunActor =
        visibility.kind === 'owner'
          ? { kind: 'user', userId: visibility.userId }
          : await resolveRunActor(c);
      const userId = actor.kind === 'user' ? actor.userId : undefined;

      // Validate codebase exists if provided
      if (codebaseId) {
        const codebase = await codebaseDb.getCodebase(codebaseId);
        if (!codebase) {
          return apiError(c, 400, 'Codebase not found', `No codebase with id "${codebaseId}"`);
        }
      }

      const conversationId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const conversation = await conversationDb.getOrCreateConversation(
        'web',
        conversationId,
        codebaseId,
        undefined,
        userId
      );
      webAdapter.setConversationDbId(conversation.platform_conversation_id, conversation.id);

      // If message provided, dispatch it atomically (avoids ghost "Untitled" conversations)
      if (message) {
        try {
          await messageDb.addMessage(conversation.id, 'user', message, undefined, userId);
        } catch (e: unknown) {
          // Log only (no SSE warning) — the SSE stream isn't connected yet for new conversations.
          // The existing /message endpoint emits a warning because the stream is guaranteed to be active.
          getLog().error({ err: e, conversationId: conversation.id }, 'message_persistence_failed');
        }

        // Set placeholder title immediately so the sidebar never shows "Untitled conversation"
        const placeholderTitle = message.length > 60 ? message.slice(0, 60) + '...' : message;
        await conversationDb.updateConversationTitle(conversation.id, placeholderTitle);

        // Generate proper AI title for non-command messages (fire-and-forget, overwrites placeholder).
        // Resolve the `small` tier (config tiers + per-user prefs) instead of the raw
        // assistant default — the config-default Codex model may not be usable on the
        // active account (e.g. ChatGPT-plan accounts, #1855). Both calls never throw.
        if (!message.startsWith('/')) {
          void resolveTitleRequest(conversation.ai_assistant_type, userId).then(titleRequest =>
            generateTitleForUser(
              conversation.id,
              message,
              titleRequest,
              getArchonWorkspacesPath(),
              userId
            )
          );
        }

        const result = await dispatchToOrchestrator(
          conversation.platform_conversation_id,
          message,
          { actor }
        );

        return c.json({
          conversationId: conversation.platform_conversation_id,
          id: conversation.id,
          dispatched: true,
          ...result,
        });
      }

      return c.json({ conversationId: conversation.platform_conversation_id, id: conversation.id });
    } catch (error) {
      getLog().error({ err: error }, 'create_conversation_failed');
      return apiError(c, 500, 'Failed to create conversation');
    }
  });

  // PATCH /api/conversations/:id - Update conversation (title)
  registerOpenApiRoute(updateConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    const { title } = getValidatedBody(c, updateConversationBodySchema);
    try {
      const access = await authorizeConversation(c, { platformId }, 'write');
      if ('error' in access) return access.error;
      if (title !== undefined) {
        await conversationDb.updateConversationTitle(access.conversation.id, title.slice(0, 255));
      }
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'update_conversation_failed');
      return apiError(c, 500, 'Failed to update conversation');
    }
  });

  // DELETE /api/conversations/:id - Soft delete
  registerOpenApiRoute(deleteConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const access = await authorizeConversation(c, { platformId }, 'write');
      if ('error' in access) return access.error;
      await conversationDb.softDeleteConversation(access.conversation.id);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'delete_conversation_failed');
      return apiError(c, 500, 'Failed to delete conversation');
    }
  });

  // POST /api/conversations/:id/stop - Call off the running turn
  //
  // Deliberately does NOT touch the conversation lock or the queue: the aborted
  // turn returns through its own handler, which is what releases the lock and
  // starts whatever was waiting behind it. A queued message is the operator's
  // own correction — stopping the agent is not a reason to throw it away.
  registerOpenApiRoute(stopTurnRoute, async c => {
    const conversationId = c.req.param('id') ?? '';
    try {
      const refused = await refuseConversationAccess(c, conversationId, 'write');
      if (refused) return refused;
    } catch (error) {
      getLog().error({ err: error, conversationId }, 'conversation_stop_authorize_failed');
      return apiError(c, 500, 'Failed to load conversation');
    }
    const stopped = stopTurn(conversationId);
    getLog().info({ conversationId, stopped }, 'api.conversation_stop_requested');
    return c.json({ stopped });
  });

  // GET /api/conversations/:id/image?path=... — the bytes of one image a reply
  // pointed at, so the console can render it inline instead of printing a path.
  //
  // The client's reading of the message text is a rendering hint, never a
  // permission: the path is re-validated here from scratch against the
  // conversation's own roots, and the file's header has to agree that it is an
  // image. Registered with app.get() rather than an OpenAPI route for the same
  // reason the artifact route is — the response is raw bytes, not JSON.
  app.get('/api/conversations/:id/image', async c => {
    const platformId = c.req.param('id') ?? '';
    const requested = c.req.query('path') ?? '';
    if (requested === '' || requested.includes('\0')) {
      return apiError(c, 400, 'Invalid image path');
    }

    let roots: readonly string[];
    try {
      const refused = await refuseConversationAccess(c, platformId, 'read');
      if (refused) return refused;
      roots = await conversationImageRoots(platformId);
    } catch (error) {
      getLog().error({ err: error, platformId }, 'conversation_image.roots_failed');
      return apiError(c, 500, 'Failed to resolve this conversation');
    }

    const image = await resolveOutboundImage(requested, roots);
    if (!image.ok) {
      // One status for every refusal on purpose: which rule a path broke tells
      // whoever asked something about the filesystem they were not shown.
      getLog().warn(
        { platformId, path: requested, reason: image.reason },
        'conversation_image.refused'
      );
      return apiError(c, 404, 'Image not available');
    }

    let content: Buffer;
    try {
      content = await readFile(image.path);
    } catch (err) {
      getLog().error({ err, platformId, path: image.path }, 'conversation_image.read_failed');
      return apiError(c, 404, 'Image not available');
    }

    return new Response(new Uint8Array(content), {
      status: 200,
      headers: {
        // The type comes from the header bytes, never from the extension, and
        // the browser is told not to second-guess it either.
        'Content-Type': image.mediaType,
        'X-Content-Type-Options': 'nosniff',
        // A screenshot is overwritten in place by the next run, so a cached
        // copy would show the previous answer's picture.
        'Cache-Control': 'no-store',
      },
    });
  });
}
