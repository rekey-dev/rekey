/**
 * POST /api/v1/users/import, bring end-users over from another auth system.
 *
 * A migration is one batch call per few hundred users: email, the password
 * hash the old system already holds (argon2id or bcrypt, verified as-is at
 * sign-in and upgraded to argon2id on first success, see lib/passwords.ts),
 * whether the address was verified, a role, metadata, and the OAuth identities
 * the old system had linked, so a Google or Discord user is not re-prompted.
 *
 * Secret key only, `auth:write`. This creates accounts with credentials the
 * caller asserts, which is the operator's authority, not a browser's.
 *
 * Idempotent per email: an address that already exists in the Application is
 * reported as `skipped`, never updated, an import must not be a way to
 * overwrite a live account's password. Each row is validated before any row is
 * written, so a malformed batch is refused whole rather than half-applied.
 * Workspace end-user quota applies exactly as it does to sign-up.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { RekeyError } from '../lib/error.js';
import { requireApiKey, requireScope } from '../middleware/api-key-auth.js';
import { isSupportedPasswordHash, MAX_BCRYPT_COST } from '../lib/passwords.js';
import { assertEndUserQuota } from '../lib/tenant-limits.js';
import { assertMetadataWithinLimit } from '../modules/auth/auth.service.js';
import { applicationRolesService } from '../modules/application-roles/application-roles.service.js';
import { emitDetached } from '../modules/webhooks/webhook.service.js';
import { ok, errs } from '../lib/openapi.js';

const MAX_BATCH = 500;

const ImportUser = z.object({
  email: z.string().email().max(254),
  /** argon2id PHC string within the parameter budget, or bcrypt (`$2a$`/`$2b$`/`$2y$`) at cost 12 or below. Omit for OAuth-only users. */
  passwordHash: z.string().min(20).max(512).optional(),
  /** Defaults to false: an address is verified only when the caller says so. */
  emailVerified: z.boolean().optional(),
  role: z.string().min(1).max(40).optional(),
  metadata: z.record(z.unknown()).optional(),
  oauthIdentities: z
    .array(
      z.object({
        provider: z.string().min(1).max(40),
        providerAccountId: z.string().min(1).max(256),
        email: z.string().email().max(254).optional(),
      }),
    )
    .max(10)
    .optional(),
});

const Body = z.object({ users: z.array(ImportUser).min(1).max(MAX_BATCH) });

export async function usersImportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireScope('auth:write'));

  app.post(
    '/import',
    {
      config: { idempotency: true },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Import end-users from another auth system (server-side)',
        description:
          'Up to 500 users per call. Password hashes are stored as given, argon2id or bcrypt, ' +
          'and verified as-is at sign-in; a bcrypt hash is upgraded to argon2id on the first ' +
          'successful sign-in. OAuth identities are linked so social-login users are not ' +
          're-prompted. Existing addresses are skipped, never updated. The whole batch is ' +
          'validated before any row is written. Secret key only.',
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          required: ['users'],
          properties: {
            users: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_BATCH,
              items: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email', maxLength: 254 },
                  passwordHash: { type: 'string', minLength: 20, maxLength: 512 },
                  emailVerified: { type: 'boolean' },
                  role: { type: 'string', minLength: 1, maxLength: 40 },
                  metadata: { type: 'object', additionalProperties: true },
                  oauthIdentities: {
                    type: 'array',
                    maxItems: 10,
                    items: {
                      type: 'object',
                      required: ['provider', 'providerAccountId'],
                      properties: {
                        provider: { type: 'string', minLength: 1, maxLength: 40 },
                        providerAccountId: { type: 'string', minLength: 1, maxLength: 256 },
                        email: { type: 'string', format: 'email', maxLength: 254 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                created: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' } }, required: ['id', 'email'] } },
                skipped: { type: 'array', items: { type: 'object', properties: { email: { type: 'string' }, reason: { type: 'string' } }, required: ['email', 'reason'] } },
                unlinked: {
                  type: 'array',
                  description: 'OAuth identities NOT linked because the provider account already belongs to another end-user here. The user was still created.',
                  items: { type: 'object', properties: { email: { type: 'string' }, provider: { type: 'string' }, providerAccountId: { type: 'string' } }, required: ['email', 'provider', 'providerAccountId'] },
                },
              },
              required: ['created', 'skipped'],
            },
            'Which rows were created and which were skipped (with why).',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR — a row failed schema validation; or PASSWORD_HASH_UNSUPPORTED — a ' +
              '`passwordHash` is neither argon2id nor bcrypt; or END_USER_ROLE_UNKNOWN — a `role` is ' +
              'not defined for this Application; or METADATA_TOO_LARGE; or IMPORT_DUPLICATE_EMAIL — ' +
              'the same address appears twice in the batch.',
            401: 'API_KEY_MISSING / API_KEY_INVALID — the secret key is missing, unknown, revoked, or expired (a publishable key is refused here).',
            403: "IP_NOT_ALLOWED — the caller's IP is outside the key's allowlist; or API_KEY_SCOPE_INSUFFICIENT — the key lacks `auth:write`; or TENANT_QUOTA_EXCEEDED — the batch would exceed the workspace end-user limit.",
          }),
        },
      },
    },
    async (req) => {
      const application = req.application!;
      const { users } = Body.parse(req.body);

      // Validate everything before writing anything.
      const seen = new Set<string>();
      for (const u of users) {
        const email = u.email.toLowerCase();
        if (seen.has(email)) {
          throw new RekeyError({
            statusCode: 400,
            code: 'IMPORT_DUPLICATE_EMAIL',
            message: `"${email}" appears more than once in this batch.`,
            fix: 'Send each address once.',
          });
        }
        seen.add(email);
        if (u.passwordHash !== undefined && !isSupportedPasswordHash(u.passwordHash)) {
          throw new RekeyError({
            statusCode: 400,
            code: 'PASSWORD_HASH_UNSUPPORTED',
            message: `The password hash for "${email}" is not a well-formed argon2id hash within the parameter budget, or a bcrypt hash at cost ${MAX_BCRYPT_COST} or below.`,
            fix:
              'Send hashes as your current system stores them: $argon2id$v=19$m=…,t=…,p=…$salt$hash with m <= 262144 KiB, t <= 10, p <= 8, ' +
              'or $2a$/$2b$/$2y$ at cost <= ' + MAX_BCRYPT_COST + '. Otherwise omit passwordHash and let the user reset.',
          });
        }
        if (u.metadata !== undefined) assertMetadataWithinLimit(u.metadata);
        if (u.role !== undefined) await applicationRolesService.assertExists(application.id, u.role);
      }
      const defaultRole = (await applicationRolesService.getDefault(application.id)).name;

      const created: Array<{ id: string; email: string }> = [];
      const skipped: Array<{ email: string; reason: string }> = [];
      // Identities that could not be linked because the provider account is
      // already attached to another end-user in this Application. The row is
      // still created; the caller must know the Google sign-in will land on
      // the OTHER account.
      const unlinked: Array<{ email: string; provider: string; providerAccountId: string }> = [];
      for (const u of users) {
        const email = u.email.toLowerCase();
        const existing = await prisma.endUser.findUnique({
          where: { applicationId_email: { applicationId: application.id, email } },
          select: { id: true },
        });
        if (existing) {
          skipped.push({ email, reason: 'already_exists' });
          continue;
        }
        // Quota re-checked per row: a 500-row batch on a workspace with 10
        // slots left creates 10 and reports the rest, rather than 0 or 500.
        try {
          await assertEndUserQuota(application.tenantId);
        } catch (e) {
          if (e instanceof RekeyError && e.code === 'TENANT_QUOTA_EXCEEDED') {
            skipped.push({ email, reason: 'quota_exceeded' });
            continue;
          }
          throw e;
        }
        let row: { id: string; email: string };
        try {
          row = await prisma.$transaction(async (tx) => {
            const endUser = await tx.endUser.create({
              data: {
                applicationId: application.id,
                email,
                passwordHash: u.passwordHash ?? null,
                role: u.role ?? defaultRole,
                // Unverified unless the caller says otherwise. An Application
                // that requires verification would otherwise trust every
                // imported address on the strength of an omitted field.
                emailVerified: u.emailVerified ?? false,
                ...(u.metadata !== undefined && { metadata: u.metadata as never }),
              },
              select: { id: true, email: true },
            });
            for (const ident of u.oauthIdentities ?? []) {
              // A provider account already linked elsewhere is not re-linked;
              // the row is still created so the user can sign in another way.
              const taken = await tx.oAuthIdentity.findUnique({
                where: {
                  applicationId_provider_providerAccountId: {
                    applicationId: application.id,
                    provider: ident.provider,
                    providerAccountId: ident.providerAccountId,
                  },
                },
                select: { id: true },
              });
              if (taken) {
                unlinked.push({ email, provider: ident.provider, providerAccountId: ident.providerAccountId });
                continue;
              }
              await tx.oAuthIdentity.create({
                data: {
                  applicationId: application.id,
                  endUserId: endUser.id,
                  provider: ident.provider,
                  providerAccountId: ident.providerAccountId,
                  email: ident.email?.toLowerCase() ?? email,
                },
              });
            }
            return endUser;
          });
        } catch (e) {
          // A sign-up for the same address landed between the existence check
          // and the create: the row exists, which is what "skipped" means.
          if ((e as { code?: string }).code !== 'P2002') throw e;
          skipped.push({ email, reason: 'already_exists' });
          continue;
        }
        created.push(row);
        emitDetached({
          applicationId: application.id,
          type: 'user.created',
          data: { user: { id: row.id, email: row.email }, via: 'import' },
        });
      }
      return { success: true, data: { created, skipped, unlinked } };
    },
  );
}
