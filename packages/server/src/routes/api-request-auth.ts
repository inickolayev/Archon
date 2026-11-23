import type { Context } from 'hono';
import type { Conversation, RunActor, User } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import {
  isConversationVisible,
  type ConversationVisibility,
} from '@archon/core/db/conversation-visibility';
import * as userDb from '@archon/core/db/users';
import { looksLikeApiToken, verifyApiToken } from '@archon/core/db/pat-store';
import * as workflowDb from '@archon/core/db/workflows';
import { getAuth, isWebAuthEnabled, isConversationOwnershipEnforced } from '../auth';
// Imported from the pure config module rather than the barrel: route tests mock
// '../auth', and the header name must stay the real implementation under them.
import { webAuthHeaderName } from '../auth/config';
import { apiError, getLog } from './api-route-kit';

interface WebUserContext {
  userId: User['id'];
  role: User['role'];
  /** True when the request authenticated with a personal access token rather than a session or proxy header. */
  viaToken?: true;
}

/** The personal access token in `Authorization: Bearer arc_pat_…`, if the request carries one. */
export function presentedApiToken(c: Context): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
  const value = match?.[1];
  return value !== undefined && looksLikeApiToken(value) ? value : undefined;
}

type TokenIdentity =
  | { kind: 'absent' }
  | { kind: 'valid'; context: WebUserContext }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

/**
 * A presented personal access token is the only credential considered: when it is
 * present but unknown, revoked, or expired the request is refused rather than
 * falling back to a session or the proxy header, so a stale token never silently
 * becomes a different identity.
 */
/**
 * One verification per request: the /api/* gate and the route behind it both ask,
 * and each ask would otherwise be another lookup (and possibly a last_used write).
 */
const tokenIdentityByRequest = new WeakMap<Request, Promise<TokenIdentity>>();

function resolveTokenIdentity(c: Context): Promise<TokenIdentity> {
  const cached = tokenIdentityByRequest.get(c.req.raw);
  if (cached) return cached;
  const resolved = verifyTokenIdentity(c);
  tokenIdentityByRequest.set(c.req.raw, resolved);
  return resolved;
}

async function verifyTokenIdentity(c: Context): Promise<TokenIdentity> {
  const token = presentedApiToken(c);
  if (token === undefined) return { kind: 'absent' };
  try {
    const verified = await verifyApiToken(token);
    if (verified === null) return { kind: 'invalid' };
    const user = await userDb.getUserById(verified.userId);
    if (user === null) return { kind: 'invalid' };
    return { kind: 'valid', context: { userId: user.id, role: user.role, viaToken: true } };
  } catch (err) {
    getLog().error({ err: err as Error, path: c.req.path }, 'web.api_token_resolve_failed');
    return { kind: 'unavailable' };
  }
}

/**
 * Whether the request presented a personal access token that does not resolve.
 * The API gate uses it to answer 401 even when the gate is otherwise off.
 */
export async function hasRejectedApiToken(c: Context): Promise<boolean> {
  return (await resolveTokenIdentity(c)).kind === 'invalid';
}

/**
 * Trusted proxy headers require a proxy that strips client-supplied values, or
 * a loopback-only server. Missing identity leaves solo requests unattributed;
 * the API gate maps it to 401 when authentication is required.
 */
export async function resolveAuthContext(c: Context): Promise<WebUserContext | undefined> {
  const token = await resolveTokenIdentity(c);
  if (token.kind === 'valid') return token.context;
  if (token.kind !== 'absent') return undefined;

  const auth = getAuth();
  if (auth) {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        const user = await userDb.findOrCreateUserByPlatformIdentity(
          'web',
          session.user.id,
          session.user.name ?? session.user.email ?? undefined
        );
        return { userId: user.id, role: user.role };
      }
    } catch (err) {
      // Proxy-authenticated installs can keep attributing requests during a
      // session-backend outage. Without a header the API gate fails closed.
      getLog().warn({ err: err as Error, path: c.req.path }, 'web.session_resolve_failed');
    }
  }

  const headerName = webAuthHeaderName();
  const headerVal = c.req.header(headerName)?.trim();
  if (!headerVal) return undefined;
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity('web', headerVal, headerVal);
    return { userId: user.id, role: user.role };
  } catch (err) {
    // Attribution is best-effort; the strict credential guard reports 503.
    getLog().warn(
      { err: err as Error, headerPresent: true, path: c.req.path },
      'web.user_resolve_failed'
    );
    return undefined;
  }
}

export async function resolveRunActor(c: Context): Promise<RunActor> {
  const identity = await resolveAuthContext(c);
  if (identity) return { kind: 'user', userId: identity.userId };
  const headerName = webAuthHeaderName();
  const suppliedIdentity = Boolean(c.req.header(headerName)?.trim());
  return { kind: isWebAuthEnabled() || suppliedIdentity ? 'unidentified' : 'operator' };
}

export async function resolveWebUserId(c: Context): Promise<string | undefined> {
  return (await resolveAuthContext(c))?.userId;
}

/**
 * Credential endpoints must distinguish missing identity (401) from a backend
 * outage (503). Unlike soft attribution, a session outage cannot use a header
 * fallback here.
 */
export async function requireWebUser(
  c: Context,
  failMessage = 'Web authentication required'
): Promise<WebUserContext | { error: Response }> {
  const token = await resolveTokenIdentity(c);
  if (token.kind === 'valid') return token.context;
  if (token.kind === 'invalid') return { error: apiError(c, 401, 'Invalid or expired API token') };
  if (token.kind === 'unavailable') {
    return { error: apiError(c, 503, 'Could not verify API token — backend unavailable') };
  }

  const auth = getAuth();
  if (auth) {
    let session: Awaited<ReturnType<typeof auth.api.getSession>> | undefined;
    try {
      session = await auth.api.getSession({ headers: c.req.raw.headers });
    } catch (err) {
      getLog().error({ err: err as Error }, 'web.session_resolve_failed');
      return { error: apiError(c, 503, 'Could not verify session — backend unavailable') };
    }
    if (session?.user) {
      try {
        const user = await userDb.findOrCreateUserByPlatformIdentity(
          'web',
          session.user.id,
          session.user.name ?? session.user.email ?? undefined
        );
        return { userId: user.id, role: user.role };
      } catch (err) {
        getLog().error({ err: err as Error }, 'web.user_resolve_failed');
        return { error: apiError(c, 503, 'Could not verify web identity — backend unavailable') };
      }
    }
  }

  const headerName = webAuthHeaderName();
  const headerVal = c.req.header(headerName)?.trim();
  if (!headerVal) return { error: apiError(c, 401, failMessage) };
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity('web', headerVal, headerVal);
    return { userId: user.id, role: user.role };
  } catch (err) {
    getLog().error({ err: err as Error, headerPresent: true }, 'web.user_resolve_failed');
    return { error: apiError(c, 503, 'Could not verify web identity — backend unavailable') };
  }
}

/**
 * Token management is for a signed-in browser session only: a personal access
 * token (or the proxy header) cannot mint, list, or revoke tokens, so a leaked
 * token cannot extend or multiply itself. A request carrying a token is 403, not
 * 401, because the credential is valid but not allowed here.
 */
export async function requireSessionUser(
  c: Context
): Promise<WebUserContext | { error: Response }> {
  if (presentedApiToken(c) !== undefined) {
    return { error: apiError(c, 403, 'API tokens are managed from a signed-in browser session') };
  }
  const auth = getAuth();
  if (!auth) {
    return { error: apiError(c, 403, 'API tokens require web authentication to be enabled') };
  }
  let session: Awaited<ReturnType<typeof auth.api.getSession>> | undefined;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch (err) {
    getLog().error({ err: err as Error }, 'web.session_resolve_failed');
    return { error: apiError(c, 503, 'Could not verify session — backend unavailable') };
  }
  if (!session?.user) return { error: apiError(c, 401, 'Authentication required') };
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity(
      'web',
      session.user.id,
      session.user.name ?? session.user.email ?? undefined
    );
    return { userId: user.id, role: user.role };
  } catch (err) {
    getLog().error({ err: err as Error }, 'web.user_resolve_failed');
    return { error: apiError(c, 503, 'Could not verify web identity — backend unavailable') };
  }
}

/**
 * Which conversations this request may reach. Under ownership enforcement the
 * caller resolves on the strict path, so neither a missing identity (401) nor an
 * identity-backend outage (503) can fall back to the whole install.
 */
export async function requireConversationVisibility(
  c: Context
): Promise<ConversationVisibility | { error: Response }> {
  if (!isConversationOwnershipEnforced()) return { kind: 'all' };
  const web = await requireWebUser(c, 'Authentication required');
  if ('error' in web) return web;
  return { kind: 'owner', userId: web.userId };
}

/**
 * Bare platform IDs must resolve uniquely across platforms. Dispatch and SSE
 * prefer the web adapter's row, but a conversation born elsewhere (a Telegram
 * chat, a run transcript) is reachable through an unambiguous non-web row.
 */
type ConversationKey = { platformId: string } | { webFirstPlatformId: string } | { id: string };

async function loadConversation(key: ConversationKey): Promise<Conversation | null> {
  if ('platformId' in key) return conversationDb.findConversationByPlatformId(key.platformId);
  if ('webFirstPlatformId' in key) {
    return (
      (await conversationDb.getConversationByPlatformId('web', key.webFirstPlatformId)) ??
      (await conversationDb.findConversationByPlatformId(key.webFirstPlatformId))
    );
  }
  return conversationDb.getConversationById(key.id);
}

/**
 * The authorization every route naming a conversation goes through. Identity is
 * resolved before the row is loaded, so a refused caller learns nothing about
 * which ids exist, and a non-owner gets the same 404 as a missing row because
 * web conversation ids are guessable. A run's own transcript stays readable to
 * any signed-in user, as the run itself is; writing to it stays the owner's.
 *
 * Throws when the conversation lookup fails; callers map that to their 500.
 */
export async function authorizeConversation(
  c: Context,
  key: ConversationKey,
  access: 'read' | 'write'
): Promise<
  { conversation: Conversation; visibility: ConversationVisibility } | { error: Response }
> {
  const visibility = await requireConversationVisibility(c);
  if ('error' in visibility) return visibility;
  const conversation = await loadConversation(key);
  if (!conversation) return { error: apiError(c, 404, 'Conversation not found') };
  if (isConversationVisible(conversation, visibility)) return { conversation, visibility };
  if (access === 'read' && (await workflowDb.isRunTranscriptConversation(conversation.id))) {
    return { conversation, visibility };
  }
  getLog().warn(
    {
      conversationId: conversation.id,
      platformType: conversation.platform_type,
      access,
      ownerPresent: conversation.user_id !== null,
    },
    'api.conversation_access_denied'
  );
  return { error: apiError(c, 404, 'Conversation not found') };
}

/**
 * Dispatch uses the same caller that authorized the row. The web row wins, but a
 * conversation born on another platform (a Telegram chat continued from the
 * console) is the same conversation, so it is found too — the orchestrator
 * adopts it rather than forking a web twin — and, under ownership enforcement,
 * only its owner may write into it. Solo installs may dispatch to an absent row,
 * but never through a failed lookup.
 */
export async function authorizeDispatchConversation(
  c: Context,
  platformId: string
): Promise<{ conversation: Conversation | null; actor: RunActor } | { error: Response }> {
  try {
    if (isConversationOwnershipEnforced()) {
      const access = await authorizeConversation(c, { webFirstPlatformId: platformId }, 'write');
      if ('error' in access) return access;
      // A chat platform's own access model makes its rows visible to every web user,
      // which is right for reading and wrong for speaking in one: through the web, a
      // conversation born elsewhere is continued only by the account it belongs to
      // (a Telegram chat is owned through the account link).
      const { conversation, visibility } = access;
      if (
        conversation.platform_type !== 'web' &&
        visibility.kind === 'owner' &&
        conversation.user_id !== visibility.userId
      ) {
        getLog().warn(
          { conversationId: conversation.id, platformType: conversation.platform_type },
          'api.conversation_dispatch_denied'
        );
        return { error: apiError(c, 404, 'Conversation not found') };
      }
      const actor: RunActor =
        access.visibility.kind === 'owner'
          ? { kind: 'user', userId: access.visibility.userId }
          : await resolveRunActor(c);
      return { conversation: access.conversation, actor };
    }
    const conversation = await loadConversation({ webFirstPlatformId: platformId });
    return { conversation, actor: await resolveRunActor(c) };
  } catch (err: unknown) {
    getLog().error({ err, conversationId: platformId }, 'conversation_lookup_failed');
    return { error: apiError(c, 500, 'Failed to load conversation') };
  }
}
