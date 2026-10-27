/**
 * Operator routes for the reporting currency and the routing preview.
 * Registered under /api/v1/tenant/applications.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RoutingPreviewRequestSchema, SetReportingCurrencyRequestSchema } from '@rekey.dev/shared-types';
import { ensureAppAccess } from '../../lib/app-access.js';
import { errs, ok, ref } from '../../lib/openapi.js';
import { requireOperatorAuth } from '../../middleware/operator-auth.js';
import { applicationsService } from '../applications/applications.service.js';
import { reportingCurrency, reportingCurrencyDto, setReportingCurrency } from './reporting-currency.js';
import { previewRouting } from './routing-preview.js';

const AppParam = z.object({ id: z.string().min(1) });
const APP_PARAMS = {
  type: 'object',
  properties: { id: { type: 'string', description: 'The Application id.' } },
  required: ['id'],
} as const;

const SESSION_401 =
  'TENANT_SESSION_MISSING: no `Authorization: Bearer` header; or TENANT_SESSION_INVALID: ' +
  'the token is invalid, expired, or the operator account no longer exists.';
const APP_404 =
  'APPLICATION_NOT_FOUND: no application with that id in this workspace (also returned to a ' +
  'MEMBER who holds no grant on it, so its existence is not disclosed).';

export async function tenantBillingReportingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireOperatorAuth);

  app.get(
    '/:id/billing/reporting-currency',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Read the currency an Application reports in',
        description:
          'Requires **read** access to this Application and the `billing:read` scope.\n\n' +
          'The reporting currency is the headline of the Revenue page and the MRR tile, the currency ' +
          'offered first for a new price or coupon, and the currency of a plan with no flat price. Nothing ' +
          'is converted into it: totals in other currencies are listed beside it. `USD` until set.',
        params: APP_PARAMS,
        response: {
          200: ok(ref('ReportingCurrency'), 'The reporting currency.'),
          ...errs({ 401: SESSION_401, 403: 'SCOPE_INSUFFICIENT: the `billing:read` scope is not held.', 404: APP_404 }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const application = await applicationsService.get(id, { tenantId: req.tenantId! });
      return { success: true, data: reportingCurrencyDto(reportingCurrency(application)) };
    },
  );

  app.put(
    '/:id/billing/reporting-currency',
    {
      config: { access: { scope: 'billing:write' } },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Set the currency an Application reports in',
        description:
          'Requires **write** access to this Application (OWNER/ADMIN, or a MEMBER with an `APP_ADMIN` ' +
          'grant on it) and the `billing:write` scope.\n\n' +
          'Changes which currency the stats lead with. It changes no price, no subscription and no ' +
          'payment, and converts nothing. The change is written to the billing log as ' +
          '`settings.reporting_currency_changed` with the value before and after. Sending the current ' +
          'value changes nothing and logs nothing.',
        params: APP_PARAMS,
        body: {
          type: 'object',
          required: ['reportingCurrency'],
          properties: {
            reportingCurrency: {
              type: 'string',
              description: 'ISO 4217, any case, stored upper-case. Must be a currency a plan can be priced in.',
            },
          },
        },
        response: {
          200: ok(ref('ReportingCurrency'), 'The reporting currency as stored.'),
          ...errs({
            400:
              'VALIDATION_ERROR: the body is not `{ reportingCurrency }` with a three-letter code; or ' +
              'BILLING_REPORTING_CURRENCY_INVALID: the code is not a currency a plan can be priced in ' +
              '(unknown, not money, withdrawn, or three-decimal).',
            401: SESSION_401,
            403:
              'TENANT_ROLE_INSUFFICIENT or APP_ACCESS_DENIED: the operator may not change billing settings ' +
              'on this Application; or SCOPE_INSUFFICIENT: the `billing:write` scope is not held.',
            404: APP_404,
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = SetReportingCurrencyRequestSchema.parse(req.body ?? {});
      const result = await setReportingCurrency({
        applicationId: id,
        currency: body.reportingCurrency,
        operatorId: req.tenantUser!.id,
      });
      return { success: true, data: reportingCurrencyDto(result.reportingCurrency) };
    },
  );

  app.post(
    '/:id/billing/checkout/preview',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Preview which price and provider a buyer in a country would get',
        description:
          'Requires **read** access to this Application and the `billing:read` scope.\n\n' +
          'Answers, for a buyer in `country`, which price and currency each plan would be charged at, ' +
          'which provider would charge it, and why, with the functions checkout itself runs. When the ' +
          'currency selected for the buyer cannot be charged and the default price is charged instead, ' +
          '`priceFallback` says so. When checkout would refuse, `refusal` carries the error it would ' +
          'answer with. It opens no checkout, writes nothing and calls no provider.\n\n' +
          '`countrySource` says how the checkout would learn the country, which decides whether a local ' +
          'price is offered: `vouched` (a trusted proxy, the default), `hint` (the browser\'s own word) or ' +
          '`declared` (the operator\'s server with the secret key, which may also name `currency`). Omit ' +
          '`plan` to preview every active plan, at most 100.\n\n' +
          'Send `couponCode` and each item carries `coupon`: the `discount` it takes off the price charged ' +
          'and the total, or the `refusal` a checkout carrying it would answer with (for example ' +
          '`COUPON_CURRENCY_NOT_COVERED`), decided by the functions checkout uses. With `endUserId` the ' +
          "coupon's per-buyer limits are judged for that end user; without it only its overall limit is. " +
          'A previewed refusal is not written to the billing log.',
        params: APP_PARAMS,
        body: {
          type: 'object',
          required: ['country'],
          properties: {
            country: { type: 'string', description: 'ISO 3166-1 alpha-2, any case.' },
            plan: { type: 'string', description: "A plan's id or slug. Omit for every active plan." },
            countrySource: {
              type: 'string',
              enum: ['declared', 'vouched', 'hint'],
              default: 'vouched',
              description:
                "How the checkout would learn the country: `vouched` by a trusted proxy, a `hint` from the browser, or `declared` by the operator's server.",
            },
            endUserId: { type: 'string', description: 'Preview for this end user, given what they already pay for.' },
            currency: { type: 'string', description: 'A currency the server would name. `declared` only.' },
            onUnavailableCurrency: {
              type: 'string',
              enum: ['fallback', 'refuse'],
              description:
                'What a checkout naming `currency` asks for when no provider can charge it: `fallback` to the default price, or `refuse`. ' +
                "Left out, the Application's `billingConfig.onUnavailableCurrency` applies, as at checkout. The response's " +
                '`onUnavailableCurrency` is the rule that was applied.',
            },
            provider: { type: 'string', description: 'A provider the checkout would name.' },
            couponCode: { type: 'string', description: 'A coupon code the checkout would carry.' },
          },
        },
        response: {
          200: ok(ref('RoutingPreview'), 'One entry per plan previewed.'),
          ...errs({
            400: 'VALIDATION_ERROR: the body failed validation (an unknown key, a country that is not two letters).',
            401: SESSION_401,
            403: 'SCOPE_INSUFFICIENT: the `billing:read` scope is not held.',
            404: `${APP_404} Or PLAN_NOT_FOUND: no plan with that id or slug on this Application.`,
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const body = RoutingPreviewRequestSchema.parse(req.body ?? {});
      const application = await applicationsService.get(id, { tenantId: req.tenantId! });
      return { success: true, data: await previewRouting(application, body) };
    },
  );
}
