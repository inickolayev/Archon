import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { createApiToken, listApiTokens, revokeApiToken } from '@archon/core/db/pat-store';
import { requireSessionUser } from './api-request-auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import {
  apiTokenListResponseSchema,
  apiTokenParamsSchema,
  createApiTokenBodySchema,
  createApiTokenResponseSchema,
  revokeApiTokenResponseSchema,
} from './schemas/api-token.schemas';

const AUTH_REQUIRED = jsonError('Authentication required');
const SESSION_ONLY = jsonError('Not available to API-token requests or without web authentication');
const BACKEND_UNAVAILABLE = jsonError('Identity or token backend unavailable');

function json<T>(schema: T, description: string) {
  return { content: { 'application/json': { schema } }, description };
}

const listRoute = createRoute({
  method: 'get',
  path: '/api/me/tokens',
  tags: ['Auth'],
  summary: 'The signed-in user’s active API tokens',
  responses: {
    200: json(apiTokenListResponseSchema, 'Active tokens, without secrets'),
    401: AUTH_REQUIRED,
    403: SESSION_ONLY,
    503: BACKEND_UNAVAILABLE,
  },
});

const createTokenRoute = createRoute({
  method: 'post',
  path: '/api/me/tokens',
  tags: ['Auth'],
  summary: 'Mint an API token for non-browser clients',
  description:
    'The response is the only time the full token is shown. Requires a browser session; ' +
    'a token cannot mint tokens.',
  request: {
    body: { required: true, content: { 'application/json': { schema: createApiTokenBodySchema } } },
  },
  responses: {
    200: json(createApiTokenResponseSchema, 'The new token'),
    401: AUTH_REQUIRED,
    403: SESSION_ONLY,
    503: BACKEND_UNAVAILABLE,
  },
});

const revokeRoute = createRoute({
  method: 'delete',
  path: '/api/me/tokens/{id}',
  tags: ['Auth'],
  summary: 'Revoke one of the signed-in user’s API tokens',
  request: { params: apiTokenParamsSchema },
  responses: {
    200: json(revokeApiTokenResponseSchema, 'Revoked'),
    401: AUTH_REQUIRED,
    403: SESSION_ONLY,
    404: jsonError('No such active token'),
    503: BACKEND_UNAVAILABLE,
  },
});

/** Personal access token management; all three routes need a browser session. */
export function registerApiTokenRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  registerOpenApiRoute(listRoute, async c => {
    const web = await requireSessionUser(c);
    if ('error' in web) return web.error;
    try {
      return c.json({ tokens: await listApiTokens(web.userId) });
    } catch (err) {
      getLog().error({ err, userId: web.userId }, 'api_token.list_failed');
      return apiError(c, 503, 'Could not read API tokens');
    }
  });

  registerOpenApiRoute(createTokenRoute, async c => {
    const web = await requireSessionUser(c);
    if ('error' in web) return web.error;
    const body = getValidatedBody(c, createApiTokenBodySchema);
    try {
      const created = await createApiToken({
        userId: web.userId,
        name: body.name,
        expiresInDays: body.expiresInDays,
      });
      return c.json(created);
    } catch (err) {
      getLog().error({ err, userId: web.userId }, 'api_token.create_failed');
      return apiError(c, 503, 'Could not create the API token');
    }
  });

  registerOpenApiRoute(revokeRoute, async c => {
    const web = await requireSessionUser(c);
    if ('error' in web) return web.error;
    try {
      const revoked = await revokeApiToken(web.userId, c.req.param('id') ?? '');
      if (!revoked) return apiError(c, 404, 'No such active token');
      return c.json({ revoked: true as const });
    } catch (err) {
      getLog().error({ err, userId: web.userId }, 'api_token.revoke_failed');
      return apiError(c, 503, 'Could not revoke the API token');
    }
  });
}
