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
import { SUPPORT_MODE_SCHEMA, supportModeFor } from '../modules/support-cases/support-mode.js';

const USERS_ERRORS = {
  401: 'API_KEY_MISSING / API_KEY_INVALID: the secret key is missing, unknown, revoked, or expired (a publishable key is refused here).',
  403: "IP_NOT_ALLOWED: the caller's IP is outside the key's allowlist; or API_KEY_SCOPE_INSUFFICIENT: the key lacks `auth:read`.",
  404: 'END_USER_NOT_FOUND: no end-user matches in this Application.',
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
            400: 'VALIDATION_ERROR: `email` is missing or malformed.',
            410: 'END_USER_ERASED: the account was erased (GDPR); only a tombstone remains.',
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
      return { success: true, data: await authService.getByIdForServer(req.application!.id, row.id) };
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
          ...errs({ 410: 'END_USER_ERASED: the account was erased (GDPR); only a tombstone remains.', ...USERS_ERRORS }),
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
      return { success: true, data: await authService.getByIdForServer(req.application!.id, id) };
    },
  );

  app.get(
    '/:id/support',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: "Read an end-user's support mode (server-side)",
        description:
          'Whether an operator has an open support case on this end-user, and which capabilities ' +
          'it turns on. The same object `GET /users/me?include=support` returns. Pass `deviceId` ' +
          'to ask about one device; without it only a case covering every device reads as active. ' +
          'A `deviceId` the case does not name, including one that is not this end-user\'s, reads ' +
          'as inactive. Secret key only.',
        security: [{ apiKey: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: { deviceId: { type: 'string', description: 'A device id from the devices routes.' } },
        },
        response: {
          200: ok(SUPPORT_MODE_SCHEMA, 'Support mode for the end-user, or for that device.'),
          ...errs(USERS_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const { deviceId } = z.object({ deviceId: z.string().min(1).max(200).optional() }).parse(req.query);
      await assertEndUserInApplication(
        req.application!.id,
        id,
        'Confirm the id belongs to the Application this secret key represents.',
      );
      return {
        success: true,
        data: await supportModeFor({ applicationId: req.application!.id, endUserId: id, deviceId }),
      };
    },
  );
}
