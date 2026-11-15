/**
 * Zod schemas for the account layer: the signed-in account, its linked platform
 * identities, the one-time Telegram link handshake, and the authorship directory.
 */
import { z } from '@hono/zod-openapi';
import { userRoleSchema } from '@archon/core/schemas/user';

/** A platform identity that resolves to this account. */
export const linkedIdentitySchema = z
  .object({
    platform: z.string(),
    platformUserId: z.string(),
    displayName: z.string().nullable(),
    linkedAt: z.string().nullable(),
  })
  .openapi('LinkedIdentity');

/** GET /api/auth/me response. */
export const accountMeResponseSchema = z
  .object({
    userId: z.string(),
    role: userRoleSchema,
    name: z.string().nullable(),
    email: z.string().nullable(),
    identities: z.array(linkedIdentitySchema),
  })
  .openapi('AccountMeResponse');

/** POST /api/auth/me/sign-out response. */
export const accountSignOutResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi('AccountSignOutResponse');

/** GET /api/auth/me/identities response. */
export const accountIdentitiesResponseSchema = z
  .object({ identities: z.array(linkedIdentitySchema) })
  .openapi('AccountIdentitiesResponse');

export const identityPlatformParamsSchema = z.object({ platform: z.string() });

/** DELETE /api/auth/me/identities/{platform} response: how many identity rows went. */
export const unlinkIdentityResponseSchema = z
  .object({ removed: z.number().int() })
  .openapi('UnlinkIdentityResponse');

export const linkTokenParamsSchema = z.object({ token: z.string() });

/** GET /api/auth/telegram/link/{token} response: what confirming would connect. */
export const telegramLinkPreviewSchema = z
  .object({
    telegram: z.object({ displayName: z.string().nullable() }),
    account: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
    alreadyLinkedToThisAccount: z.boolean(),
    expiresAt: z.string(),
  })
  .openapi('TelegramLinkPreview');

/** POST /api/auth/telegram/link/{token} response. */
export const telegramLinkResultSchema = z
  .object({
    linked: z.literal(true),
    alreadyLinked: z.boolean(),
    /** History rows moved onto this account from the Telegram identity's old user. */
    movedRows: z.number().int(),
    email: z.string().nullable(),
  })
  .openapi('TelegramLinkResult');

export const directoryUserSchema = z
  .object({
    id: z.string(),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
  })
  .openapi('DirectoryUser');

/** GET /api/users/directory response. */
export const userDirectoryResponseSchema = z
  .object({ me: z.string(), users: z.array(directoryUserSchema) })
  .openapi('UserDirectoryResponse');
