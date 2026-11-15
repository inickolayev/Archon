import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import * as accountLinks from '@archon/core/db/account-links';
import { getAuth } from '../auth';
import { linkTokens } from '../auth/link-tokens';
import type { TelegramAdapterSource } from './api-message-dispatch';
import { requireWebUser, resolveAuthContext } from './api-request-auth';
import { apiError, getLog, jsonError, openApiRouteRegistrar } from './api-route-kit';
import {
  accountIdentitiesResponseSchema,
  accountMeResponseSchema,
  accountSignOutResponseSchema,
  identityPlatformParamsSchema,
  linkTokenParamsSchema,
  telegramLinkPreviewSchema,
  telegramLinkResultSchema,
  unlinkIdentityResponseSchema,
  userDirectoryResponseSchema,
} from './schemas/account.schemas';

const AUTH_REQUIRED = jsonError('Authentication required');
const IDENTITY_UNAVAILABLE = jsonError('Identity backend unavailable');

function json<T>(schema: T, description: string) {
  return { content: { 'application/json': { schema } }, description };
}

const accountMeRoute = createRoute({
  method: 'get',
  path: '/api/auth/me',
  tags: ['Auth'],
  summary: 'The signed-in account and the platform identities linked to it',
  responses: {
    200: json(accountMeResponseSchema, 'The account'),
    401: AUTH_REQUIRED,
    503: IDENTITY_UNAVAILABLE,
  },
});

const signOutRoute = createRoute({
  method: 'post',
  path: '/api/auth/me/sign-out',
  tags: ['Auth'],
  summary: 'End the session and drop every pending account-link token',
  description:
    'Answers `{ ok: true }` without a session too: there is nothing to end. Only a real ' +
    'session drops the pending link tokens.',
  responses: {
    200: json(accountSignOutResponseSchema, 'Signed out'),
    503: jsonError('Could not sign out'),
  },
});

const identitiesRoute = createRoute({
  method: 'get',
  path: '/api/auth/me/identities',
  tags: ['Auth'],
  summary: 'Platform identities linked to the signed-in account',
  responses: {
    200: json(accountIdentitiesResponseSchema, 'Linked identities'),
    401: AUTH_REQUIRED,
    503: IDENTITY_UNAVAILABLE,
  },
});

const unlinkIdentityRoute = createRoute({
  method: 'delete',
  path: '/api/auth/me/identities/{platform}',
  tags: ['Auth'],
  summary: 'Stop a platform identity from resolving to this account (telegram only)',
  description: 'History written through the identity stays with the account.',
  request: { params: identityPlatformParamsSchema },
  responses: {
    200: json(unlinkIdentityResponseSchema, 'Unlinked'),
    400: jsonError('Only the telegram link can be removed here'),
    401: AUTH_REQUIRED,
    503: IDENTITY_UNAVAILABLE,
  },
});

const telegramLinkPreviewRoute = createRoute({
  method: 'get',
  path: '/api/auth/telegram/link/{token}',
  tags: ['Auth'],
  summary: 'What a one-time Telegram link would connect to the signed-in account',
  request: { params: linkTokenParamsSchema },
  responses: {
    200: json(telegramLinkPreviewSchema, 'The pending link'),
    401: AUTH_REQUIRED,
    404: jsonError('The link has expired or was already used'),
    503: IDENTITY_UNAVAILABLE,
  },
});

const telegramLinkConfirmRoute = createRoute({
  method: 'post',
  path: '/api/auth/telegram/link/{token}',
  tags: ['Auth'],
  summary: 'Spend a one-time Telegram link: link the identity and tell the chat',
  request: { params: linkTokenParamsSchema },
  responses: {
    200: json(telegramLinkResultSchema, 'Linked'),
    401: AUTH_REQUIRED,
    404: jsonError('The link has expired or was already used'),
    503: jsonError('Could not link the account'),
  },
});

const userDirectoryRoute = createRoute({
  method: 'get',
  path: '/api/users/directory',
  tags: ['Auth'],
  summary: 'Every user who has written here, for authorship labels',
  responses: {
    200: json(userDirectoryResponseSchema, 'The directory'),
    401: AUTH_REQUIRED,
    503: IDENTITY_UNAVAILABLE,
  },
});

function toApiIdentity(identity: accountLinks.LinkedIdentity): {
  platform: string;
  platformUserId: string;
  displayName: string | null;
  linkedAt: string | null;
} {
  return {
    platform: identity.platform,
    platformUserId: identity.platformUserId,
    displayName: identity.displayName,
    linkedAt:
      identity.linkedAt instanceof Date ? identity.linkedAt.toISOString() : identity.linkedAt,
  };
}

/**
 * The account layer: who am I, what is linked, and the Telegram handshake.
 *
 * Every /api/auth/* path here is listed in isArchonOwnedAuthPath, or Better
 * Auth would swallow it.
 */
export function registerAccountRoutes(
  app: OpenAPIHono,
  getTelegramAdapter?: TelegramAdapterSource
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  /** GET /api/auth/me — the signed-in account, as Profile shows it. */
  registerOpenApiRoute(accountMeRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      const [account, identities] = await Promise.all([
        accountLinks.findWebAccountForUser(web.userId),
        accountLinks.listIdentitiesForUser(web.userId),
      ]);
      return c.json({
        userId: web.userId,
        role: web.role,
        name: account?.name ?? null,
        email: account?.email ?? null,
        identities: identities.map(toApiIdentity),
      });
    } catch (err) {
      getLog().error({ err, userId: web.userId }, 'account.me_failed');
      return apiError(c, 503, 'Could not read the account');
    }
  });

  /**
   * POST /api/auth/me/sign-out — end the session server-side.
   *
   * Archon's own, so that signing out also drops every pending link token: a
   * one-time link left open in another window must not survive the session it
   * was meant for.
   */
  registerOpenApiRoute(signOutRoute, async c => {
    const auth = getAuth();
    if (auth === null) return c.json({ ok: true });
    // Only a real session may drop the pending links. Clearing them for anyone
    // who can POST here would let an unauthenticated caller break the link
    // handshake for everybody — cheap to do, annoying to diagnose. No session
    // is not an error though: there is nothing to end, and the caller should
    // still be allowed to walk to the sign-in page.
    const session = await resolveAuthContext(c);
    if (session === undefined) return c.json({ ok: true });
    linkTokens.clear();
    try {
      const response = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
      // Forward Better Auth's cookie clearing verbatim.
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    } catch (err) {
      getLog().warn({ err }, 'account.sign_out_failed');
      return apiError(c, 503, 'Could not sign out');
    }
  });

  /** GET /api/auth/me/identities — linked external sources. */
  registerOpenApiRoute(identitiesRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      const identities = await accountLinks.listIdentitiesForUser(web.userId);
      return c.json({ identities: identities.map(toApiIdentity) });
    } catch (err) {
      getLog().error({ err, userId: web.userId }, 'account.identities_failed');
      return apiError(c, 503, 'Could not read the linked identities');
    }
  });

  /**
   * DELETE /api/auth/me/identities/:platform — stop a platform from resolving
   * to this account. History stays with the account (see db/account-links).
   */
  registerOpenApiRoute(unlinkIdentityRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    const platform = c.req.param('platform');
    if (platform !== 'telegram') {
      return apiError(c, 400, 'Only the telegram link can be removed here');
    }
    try {
      const { removed } = await accountLinks.unlinkIdentity('telegram', web.userId);
      return c.json({ removed });
    } catch (err) {
      getLog().error({ err, userId: web.userId }, 'account.unlink_failed');
      return apiError(c, 503, 'Could not unlink');
    }
  });

  /**
   * GET /api/auth/telegram/link/:token — what this link would connect.
   *
   * Requires a session: the confirmation screen is only meaningful to someone
   * already signed in, and an anonymous visitor learns nothing from the link.
   */
  registerOpenApiRoute(telegramLinkPreviewRoute, async c => {
    const web = await requireWebUser(c, 'Sign in first, then open the link again');
    if ('error' in web) return web.error;
    const claim = linkTokens.peek(c.req.param('token') ?? '');
    if (claim === null) {
      return apiError(c, 404, 'This link has expired or was already used');
    }
    const account = await accountLinks.findWebAccountForUser(web.userId);
    const current = await accountLinks.findUserByIdentity('telegram', claim.platformUserId);
    return c.json({
      telegram: { displayName: claim.displayName ?? null },
      account: { name: account?.name ?? null, email: account?.email ?? null },
      // Honest about what confirming will do to history.
      alreadyLinkedToThisAccount: current?.id === web.userId,
      expiresAt: new Date(claim.expiresAt).toISOString(),
    });
  });

  /** POST /api/auth/telegram/link/:token — confirm, link, and tell the chat. */
  registerOpenApiRoute(telegramLinkConfirmRoute, async c => {
    const web = await requireWebUser(c, 'Sign in first, then open the link again');
    if ('error' in web) return web.error;
    // Spending the token here is what makes it single-use — even if the link
    // is confirmed twice, the second attempt finds nothing.
    const claim = linkTokens.consume(c.req.param('token') ?? '');
    if (claim === null) {
      return apiError(c, 404, 'This link has expired or was already used');
    }
    try {
      const outcome = await accountLinks.linkIdentityToUser(
        'telegram',
        claim.platformUserId,
        web.userId
      );
      const account = await accountLinks.findWebAccountForUser(web.userId);
      const moved = Object.values(outcome.moved).reduce((sum, n) => sum + n, 0);

      // Confirm in the chat too: the operator started this on the phone.
      const telegram = getTelegramAdapter?.() ?? null;
      if (telegram !== null) {
        const who = account?.email ?? account?.name ?? 'your account';
        await telegram
          .sendMessage(claim.chatId, `This chat is now linked to ${who}.`)
          .catch((err: unknown) => {
            getLog().warn({ err }, 'account.link_chat_confirm_failed');
          });
      }

      return c.json({
        linked: true,
        alreadyLinked: outcome.alreadyLinked,
        movedRows: moved,
        email: account?.email ?? null,
      });
    } catch (err) {
      getLog().error({ err, userId: web.userId }, 'account.link_failed');
      return apiError(c, 503, 'Could not link the account');
    }
  });

  /**
   * GET /api/users/directory — who wrote what, for authorship labels.
   *
   * Everyone who can open the console administers this install, so the email
   * is not a leak here; the day that changes, this is the surface to gate.
   */
  registerOpenApiRoute(userDirectoryRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      const users = await accountLinks.listDirectoryUsers();
      return c.json({ me: web.userId, users });
    } catch (err) {
      getLog().error({ err }, 'account.directory_failed');
      return apiError(c, 503, 'Could not read the user directory');
    }
  });
}
