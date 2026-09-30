/**
 * `PATCH /api/v1/tenant/applications/:id/settings`: Application settings that
 * are not auth, billing or portal configuration. Today that is the reporting
 * timezone the daily analytics rollup counts days in.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApplicationSettingsPatchSchema } from '@rekey.dev/shared-types';
import { ok, errs } from '../../lib/openapi.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { prisma } from '../../lib/prisma.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { onReportingTimezoneChanged } from './timezone-change.js';
import { requestRollup } from './rollup/trigger.js';
import { env } from '../../config/env.js';
import { resolveReportingTimezone } from './pg-timezones.js';
import { RekeyError } from '../../lib/error.js';

const Params = z.object({ id: z.string().min(1) });

function timezoneUnsupported(zone: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'REPORTING_TIMEZONE_UNSUPPORTED',
    message: `The database does not know the time zone "${zone}", so days cannot be counted in it.`,
    fix: 'Use the current IANA name, for example Asia/Kolkata rather than Asia/Calcutta or Europe/Kyiv rather than Europe/Kiev.',
  });
}

const SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    reportingTimezone: {
      type: 'string',
      description:
        'IANA zone the daily analytics rollup counts days in. A change applies to days computed after it; ' +
        'days already rolled up keep the zone they were computed in, and the live 63-day path is always UTC.',
    },
  },
  required: ['reportingTimezone'],
} as const;

export async function applicationSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.patch(
    '/:id/settings',
    {
      config: { access: { scope: 'overview:write' } },
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Patch Application settings (the analytics reporting timezone)',
        description:
          'Requires **write** access to this Application, OWNER/ADMIN, or a MEMBER with an `APP_ADMIN` grant ' +
          'holding `overview:write`.\n\n`reportingTimezone` is an IANA zone name (`UTC`, `Europe/Berlin`, ' +
          '`Asia/Kolkata`). The daily analytics rollup counts days in it from the next computation on; days ' +
          'already rolled up keep the zone they were computed in, and the Users overview labels every series ' +
          'with its zone. See docs/analytics.md.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: { reportingTimezone: { type: 'string', maxLength: 64 } },
        },
        response: {
          200: ok(SETTINGS_SCHEMA, 'The settings after the patch.'),
          ...errs({
            400:
              'VALIDATION_ERROR: `reportingTimezone` is not an IANA zone name; REPORTING_TIMEZONE_UNSUPPORTED: ' +
              'the database does not know it (a legacy alias such as Asia/Calcutta).',
            401: 'TENANT_SESSION_MISSING / TENANT_SESSION_INVALID: no valid operator session.',
            403:
              'TENANT_ROLE_INSUFFICIENT / APP_ACCESS_DENIED: the grant does not allow writes here; or ' +
              'SCOPE_INSUFFICIENT: the membership does not hold `overview:write`.',
            404: 'APPLICATION_NOT_FOUND: no application with that id in this workspace.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const patch = ApplicationSettingsPatchSchema.parse(req.body ?? {});
      const zone = patch.reportingTimezone === undefined ? undefined : await resolveReportingTimezone(patch.reportingTimezone);
      if (zone === null) throw timezoneUnsupported(patch.reportingTimezone!);
      const before = await prisma.application.findUniqueOrThrow({
        where: { id },
        select: { reportingTimezone: true },
      });
      const updated =
        zone === undefined
          ? before
          : await prisma.application.update({
              where: { id },
              data: { reportingTimezone: zone },
              select: { reportingTimezone: true },
            });
      if (updated.reportingTimezone !== before.reportingTimezone) {
        onReportingTimezoneChanged(id);
        if (env.ANALYTICS_ROLLUP_ENABLED) void requestRollup(id, req.log);
        void recordSecurityEvent({
          type: 'app.settings_updated',
          actorType: 'operator',
          actorId: req.tenantUser!.id,
          tenantId: req.tenantId!,
          applicationId: id,
          ...requestContext(req),
          metadata: { reportingTimezone: { from: before.reportingTimezone, to: updated.reportingTimezone } },
        });
      }
      return { success: true, data: { reportingTimezone: updated.reportingTimezone } };
    },
  );
}
