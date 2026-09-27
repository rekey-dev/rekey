/**
 * Operator routes for the Rekey checkout page: the readiness preflight and the
 * per-mode "Checkout page" setting. Registered under /api/v1/tenant/applications.
 *
 * Switching a mode to EMBEDDED runs that mode's readiness first and refuses on
 * any FAIL; switching back to REDIRECT is never blocked.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CheckoutReadiness, CheckoutReadinessCheck } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { ensureAppAccess } from '../../../lib/app-access.js';
import { errs, ok, ref } from '../../../lib/openapi.js';
import { recordSecurityEvent, requestContext } from '../../../lib/security-events.js';
import { requireTenantSession } from '../../../middleware/tenant-session.js';
import { runCheckoutReadiness } from './readiness.js';
import { checkoutStatusPanel } from './status-panel.js';

const AppParam = z.object({ id: z.string().min(1) });
const APP_PARAM_SCHEMA = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;

const SettingsBody = z
  .object({
    paymentMode: z.enum(['test', 'live']).optional(),
    checkoutMode: z.enum(['REDIRECT', 'EMBEDDED']).optional(),
    checkoutFailureMode: z.enum(['FALLBACK_TO_REDIRECT', 'REFUSE']).optional(),
  })
  .strict()
  .refine((b) => (b.checkoutMode === undefined) === (b.paymentMode === undefined), {
    message: '`checkoutMode` and `paymentMode` go together: say which mode the setting is for.',
  });

/** A readiness run is reused for this long, so the panel cannot turn the probe into load. */
const RERUN_AFTER_MS = 10_000;

const SESSION_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or TENANT_SESSION_INVALID — ' +
    'the token is invalid, expired, or the operator account no longer exists.',
  404: 'APPLICATION_NOT_FOUND — no application with that id in this workspace.',
} as const;

async function freshReadiness(applicationId: string, cached: boolean): Promise<CheckoutReadiness> {
  const app = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
  const stored = app.checkoutReadiness as Partial<CheckoutReadiness> | null;
  const reusable = stored?.test !== undefined && stored.live !== undefined && stored.ranAt !== undefined;
  const recent = app.checkoutReadinessAt !== null && Date.now() - app.checkoutReadinessAt.getTime() < RERUN_AFTER_MS;
  if (reusable && (cached || recent)) return { test: stored.test!, live: stored.live!, ranAt: stored.ranAt! };
  return runCheckoutReadiness(app);
}

const ReadinessQuery = z.object({ cached: z.enum(['true', 'false']).optional() });

function settingsOf(app: {
  checkoutModeTest: 'REDIRECT' | 'EMBEDDED';
  checkoutModeLive: 'REDIRECT' | 'EMBEDDED';
  checkoutFailureMode: 'FALLBACK_TO_REDIRECT' | 'REFUSE';
}) {
  return {
    checkoutModeTest: app.checkoutModeTest,
    checkoutModeLive: app.checkoutModeLive,
    checkoutFailureMode: app.checkoutFailureMode,
  };
}

export async function tenantCheckoutRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/checkout/readiness',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Readiness of the Rekey checkout page, per payment mode',
        description:
          'Runs the eight checks for every provider a buyer can be routed to, each in the column of ' +
          'its credential mode, and probes the hosted portal. A mode with no credentials is N/A. ' +
          'A run is reused for 10 seconds. `?cached=true` returns the last stored run without ' +
          'probing, and runs only when none is stored.',
        params: APP_PARAM_SCHEMA,
        querystring: { type: 'object', properties: { cached: { type: 'string', enum: ['true', 'false'] } } },
        response: {
          200: ok(ref('CheckoutReadiness'), 'The Test and Live columns.'),
          ...errs({ ...SESSION_ERRORS, 403: 'TENANT_MEMBERSHIP_REVOKED, or APP_ACCESS_DENIED.' }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      const { cached } = ReadinessQuery.parse(req.query ?? {});
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await freshReadiness(id, cached === 'true') };
    },
  );

  app.get(
    '/:id/checkout/status',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'How the Rekey checkout page is doing for this Application',
        description:
          'The settings, the last readiness run counted per mode, the last verified webhook per ' +
          'provider and mode, the last completed Rekey-page checkout per mode, and the checkouts ' +
          'that fell back to the provider page in the last 7 days with the check that failed.',
        params: APP_PARAM_SCHEMA,
        response: {
          200: ok(ref('CheckoutStatusPanel'), 'The status panel.'),
          ...errs({ ...SESSION_ERRORS, 403: 'TENANT_MEMBERSHIP_REVOKED, or APP_ACCESS_DENIED.' }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await checkoutStatusPanel(id) };
    },
  );

  app.get(
    '/:id/checkout',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'The checkout page setting, per payment mode, and the failure behaviour',
        params: APP_PARAM_SCHEMA,
        response: {
          200: ok(ref('CheckoutSettings'), 'The current settings.'),
          ...errs({ ...SESSION_ERRORS, 403: 'TENANT_MEMBERSHIP_REVOKED, or APP_ACCESS_DENIED.' }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const current = await prisma.application.findUniqueOrThrow({ where: { id } });
      return { success: true, data: settingsOf(current) };
    },
  );

  app.patch(
    '/:id/checkout',
    {
      config: { access: { scope: 'billing:write' } },
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Choose the checkout page for one payment mode, or the failure behaviour',
        description:
          '`{ paymentMode, checkoutMode }` sets the page for test or live checkouts. Switching to ' +
          'EMBEDDED runs that mode\'s readiness first and answers 409 CHECKOUT_READINESS_FAILED with ' +
          'the check list on any FAIL; WARNs do not block. Switching to REDIRECT is never blocked. ' +
          '`checkoutFailureMode` decides what an EMBEDDED checkout does when a check fails at ' +
          "checkout time: fall back to the provider's page, or refuse.",
        params: APP_PARAM_SCHEMA,
        body: {
          type: 'object',
          properties: {
            paymentMode: { type: 'string', enum: ['test', 'live'] },
            checkoutMode: { type: 'string', enum: ['REDIRECT', 'EMBEDDED'] },
            checkoutFailureMode: { type: 'string', enum: ['FALLBACK_TO_REDIRECT', 'REFUSE'] },
          },
        },
        response: {
          200: ok(ref('CheckoutSettings'), 'The settings after the change.'),
          ...errs({
            400: 'VALIDATION_ERROR — an unknown key, or `checkoutMode` without `paymentMode`.',
            ...SESSION_ERRORS,
            403: 'TENANT_MEMBERSHIP_REVOKED, TENANT_ROLE_INSUFFICIENT or APP_ACCESS_DENIED.',
            409: 'CHECKOUT_READINESS_FAILED — a readiness check FAILs for that mode. `details.checks` lists every check.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = SettingsBody.parse(req.body ?? {});

      if (body.checkoutMode === 'EMBEDDED' && body.paymentMode !== undefined) {
        const readiness = await runCheckoutReadiness(await prisma.application.findUniqueOrThrow({ where: { id } }));
        const column: CheckoutReadinessCheck[] = readiness[body.paymentMode];
        const failed = column.filter((c) => c.status === 'FAIL' || c.status === 'N/A');
        if (failed.length > 0) {
          throw new RekeyError({
            statusCode: 409,
            code: 'CHECKOUT_READINESS_FAILED',
            message: `The Rekey checkout page is not ready for ${body.paymentMode} checkouts: ${failed.map((c) => c.message).join(' ')}`,
            fix: failed[0]!.fix ?? 'Run the checks in Panel → Application → Billing → Checkout page.',
            details: { checks: column },
          });
        }
      }

      const updated = await prisma.application.update({
        where: { id },
        data: {
          ...(body.paymentMode === 'test' && body.checkoutMode !== undefined && { checkoutModeTest: body.checkoutMode }),
          ...(body.paymentMode === 'live' && body.checkoutMode !== undefined && { checkoutModeLive: body.checkoutMode }),
          ...(body.checkoutFailureMode !== undefined && { checkoutFailureMode: body.checkoutFailureMode }),
        },
      });
      void recordSecurityEvent({
        type: 'app.checkout_settings_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: updated.tenantId,
        applicationId: id,
        ...requestContext(req),
        metadata: { ...body },
      });
      return { success: true, data: settingsOf(updated) };
    },
  );
}
