/**
 * Operator routes over a licence's activations, under
 * /api/v1/tenant/applications/:id/licenses/:licenseId/activations.
 *
 * An activation is a machine's hold on a seat. Operators can see which
 * machines hold a licence's seats and give one back on the holder's behalf
 * (a re-imaged laptop, a departed employee). The public counterpart the
 * customer's own software calls is POST /licenses/deactivate.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { licensesService } from './licenses.service.js';

const TENANT_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or TENANT_SESSION_INVALID — ' +
    'the token is invalid, expired, or the operator account no longer exists.',
  403:
    'TENANT_MEMBERSHIP_REVOKED — the operator is no longer a member of this workspace; or ' +
    "TENANT_ROLE_INSUFFICIENT / APP_ACCESS_DENIED — the operator's grant on this Application " +
    'does not allow this.',
} as const;

const LicenseParams = z.object({ id: z.string().min(1), licenseId: z.string().min(1) });
const ActivationParams = LicenseParams.extend({ activationId: z.string().min(1) });

export async function tenantLicenseActivationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/licenses/:licenseId/activations',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Licenses'],
        security: [{ tenantSession: [] }],
        summary: "List a license's activations (the machines holding its seats)",
        description:
          'Requires **read** access to this Application. Every machine that has verified this ' +
          'license, newest activity first. `releasedAt` is set on activations that gave their seat ' +
          'back; `deviceId` points at the device the same fingerprint resolved to under the holder.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, licenseId: { type: 'string' } },
          required: ['id', 'licenseId'],
        },
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('LicenseActivation'), "A page of the license's activations."),
          ...errs({
            400: 'VALIDATION_ERROR — a query parameter is out of range.',
            401: TENANT_ERRORS[401],
            403: TENANT_ERRORS[403],
            404: 'APPLICATION_NOT_FOUND; or LICENSE_NOT_FOUND — no license with that id on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, licenseId } = LicenseParams.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const license = await prisma.license.findUnique({ where: { id: licenseId }, select: { applicationId: true } });
      if (!license || license.applicationId !== id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'LICENSE_NOT_FOUND',
          message: `License "${licenseId}" not found in this application.`,
          fix: 'List licenses to see what exists.',
        });
      }
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const where = { licenseId };
      const [items, total] = await Promise.all([
        prisma.licenseActivation.findMany({
          where,
          orderBy: { lastSeenAt: 'desc' },
          take,
          skip,
        }),
        prisma.licenseActivation.count({ where }),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/:id/licenses/:licenseId/activations/:activationId/release',
    {
      config: { access: { scope: 'billing:write' } },
      schema: {
        tags: ['Tenant · Licenses'],
        security: [{ tenantSession: [] }],
        summary: 'Release a license seat held by one machine',
        description:
          'Requires **write** access to this Application. The activation stops counting toward ' +
          '`seatsAllowed`; a later verify from the same machine reactivates it in place, consuming ' +
          'a seat again only if one is free. Idempotent.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, licenseId: { type: 'string' }, activationId: { type: 'string' } },
          required: ['id', 'licenseId', 'activationId'],
        },
        response: {
          200: ok(ref('LicenseActivation'), 'The released activation.'),
          ...errs({
            401: TENANT_ERRORS[401],
            403: TENANT_ERRORS[403],
            404: 'APPLICATION_NOT_FOUND; or LICENSE_ACTIVATION_NOT_FOUND — no such activation on that license in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, licenseId, activationId } = ActivationParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const released = await licensesService.releaseActivation({ applicationId: id, licenseId, activationId });
      return { success: true, data: released };
    },
  );
}
