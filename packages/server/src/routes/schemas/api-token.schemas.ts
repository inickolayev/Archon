/**
 * Zod schemas for personal access token management (`/api/me/tokens`).
 */
import { z } from '@hono/zod-openapi';

/** A token as listed: identifying metadata only, never the secret or its hash. */
export const apiTokenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  })
  .openapi('ApiToken');

export const apiTokenListResponseSchema = z
  .object({ tokens: z.array(apiTokenSchema) })
  .openapi('ApiTokenListResponse');

export const DEFAULT_API_TOKEN_EXPIRY_DAYS = 90;
const MAX_API_TOKEN_EXPIRY_DAYS = 3650;

/** `expiresInDays: null` mints a token that never expires. */
export const createApiTokenBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_API_TOKEN_EXPIRY_DAYS)
      .nullable()
      .default(DEFAULT_API_TOKEN_EXPIRY_DAYS),
  })
  .openapi('CreateApiTokenBody');

/** The only response that ever carries the full token. */
export const createApiTokenResponseSchema = z
  .object({ token: z.string(), record: apiTokenSchema })
  .openapi('CreateApiTokenResponse');

export const apiTokenParamsSchema = z.object({ id: z.string().min(1) });

export const revokeApiTokenResponseSchema = z
  .object({ revoked: z.literal(true) })
  .openapi('RevokeApiTokenResponse');
