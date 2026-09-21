/**
 * GET /api/v1/users?email=   ·   GET /api/v1/users/:id
 *
 * Secret-key-only end-user lookup, for the customer's own backend.
 *
 * Without these, a server holding a secret key has no way to find an end-user
 * it does not already have a token for: `/users/me` needs the user's JWT, and
 * the operator list at `/tenant/applications/:id/end-users?search=` needs a
 * panel session and does a substring search. A licence server answering "which
 * account does this email belong to", or a migration script reconciling
 * records, needs an exact, server-to-server answer.
 *
 * Exact match, one Application, secret key only. The publishable key is
 * refused by `requireApiKey`: looking up OTHER users is not something a
 * browser-shipped credential may do, and an exact-match lookup is an
 * enumeration oracle in a browser's hands.
 *
 * Responses use the same `PublicEndUser` shape as `/users/me` (passwordHash
 * stripped, erased users rejected by `getById`).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { RekeyError } from '../lib/error.js';
import { assertEndUserInApplication } from '../lib/end-users.js';
import { authService } from '../modules/auth/auth.service.js';
import { requireApiKey, requireScope } from '../middleware/api-key-auth.js';
import { ok, errs, ref } from '../lib/openapi.js';

const USERS_ERRORS = {
  401: 'API_KEY_MISSING / API_KEY_INVALID — the secret key is missing, unknown, revoked, or expired (a publishable key is refused here).',
  403: "IP_NOT_ALLOWED — the caller's IP is outside the key's allowlist; or API_KEY_SCOPE_INSUFFICIENT — the key lacks `auth:read`.",
  404: 'END_USER_NOT_FOUND — no end-user matches in this Application.',
} as const;

function notFound(what: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'END_USER_NOT_FOUND',
    message: `No end-user ${what} in this Application.`,
    fix: 'Confirm the value belongs to the Application this secret key represents.',
  });
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireScope('auth:read'));

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Look up an end-user by exact email (server-side)',
        description:
          'Exact, case-insensitive match on the address, scoped to the calling Application. ' +
          'Secret key only. Returns the same shape as GET /users/me.',
        security: [{ apiKey: [] }],
        querystring: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email', maxLength: 254 } },
        },
        response: {
          200: ok(ref('EndUser'), 'The matching end-user.'),
          ...errs({
            400: 'VALIDATION_ERROR — `email` is missing or malformed.',
            410: 'END_USER_ERASED — the account was erased (GDPR); only a tombstone remains.',
            ...USERS_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { email } = z.object({ email: z.string().email().max(254) }).parse(req.query);
      const row = await prisma.endUser.findUnique({
        where: { applicationId_email: { applicationId: req.application!.id, email: email.toLowerCase() } },
        select: { id: true },
      });
      if (!row) throw notFound(`with email "${email}"`);
      return { success: true, data: await authService.getById(req.application!.id, row.id) };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Get an end-user by id (server-side)',
        description: 'Scoped to the calling Application; an id from another Application is a 404. Secret key only.',
        security: [{ apiKey: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(ref('EndUser'), 'The end-user.'),
          ...errs({ 410: 'END_USER_ERASED — the account was erased (GDPR); only a tombstone remains.', ...USERS_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      await assertEndUserInApplication(
        req.application!.id,
        id,
        'Confirm the id belongs to the Application this secret key represents.',
      );
      return { success: true, data: await authService.getById(req.application!.id, id) };
    },
  );
}
