/**
 * Operator routes for a plan's prices in additional currencies. Registered
 * under /api/v1/tenant/applications, beside the tenant plan routes.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensureAppAccess } from '../../lib/app-access.js';
import { errs, ok, ref } from '../../lib/openapi.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { requireOperatorAuth } from '../../middleware/operator-auth.js';
import { planPricesService } from './plan-prices.service.js';

const PriceParam = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  currency: z.string().min(1).max(8),
});

const PutPriceBody = z
  .object({
    amount: z.number().int().positive().optional(),
    countries: z.array(z.string()).max(250).optional(),
  })
  .strict();

const PRICE_PARAMS = {
  type: 'object',
  required: ['id', 'planId', 'currency'],
  properties: {
    id: { type: 'string', description: 'The Application id.' },
    planId: { type: 'string', description: "The plan's id. Its slug is accepted too." },
    currency: { type: 'string', description: 'ISO 4217, any case. Stored upper-case.' },
  },
} as const;

const BILLING_WRITE_ERRORS = {
  401:
    'TENANT_SESSION_MISSING: no `Authorization: Bearer` header; or TENANT_SESSION_INVALID: ' +
    'the token is invalid, expired, or the operator account no longer exists.',
  403:
    'TENANT_MEMBERSHIP_REVOKED: the operator is no longer a member of this workspace; or ' +
    'TENANT_ROLE_INSUFFICIENT: a legacy MEMBER attempted a billing write; or ' +
    "APP_ACCESS_DENIED: the operator's grant on this Application (needs APP_BILLING or " +
    'APP_ADMIN) does not permit this action.',
} as const;

export async function planPricesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireOperatorAuth);

  app.put(
    '/:id/plans/:planId/prices/:currency',
    {
      config: { access: { scope: 'billing:write' } },
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Set a Plan price in another currency',
        description:
          'Requires **billing-write** access to this Application, OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.\n\n' +
          "Creates or updates the plan's price in `currency`. The plan's default price is a " +
          'price row like any other and is listed in `prices` with `isDefault: true`, but it is ' +
          'set through the plan (`PATCH .../plans/:slug` with `price`), not here: this route ' +
          'adds or changes the others. Checkout charges it to a buyer ' +
          'whose country is in `countries`, or, when `countries` is empty, to a buyer whose ' +
          'country uses that currency. The country has to be one a secret key declared or a ' +
          'trusted proxy vouched for, unless the Application sets `billingConfig.localPrices` ' +
          'to `any`.\n\n' +
          '`countries` can change at any time. `amount` can change only until a provider has ' +
          'registered the price, which happens at its first recurring checkout, or a record names ' +
          'it: a live subscription, an open checkout, or an ended subscription, a payment or a ' +
          'credit grant. To charge a different amount after that, `DELETE` the price once nobody ' +
          'is on it (it is kept, archived) and `PUT` the new amount. The plan list says which it ' +
          'is on each price, as `amountEditable`.',
        params: PRICE_PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            amount: {
              type: 'integer',
              minimum: 1,
              description:
                "The price in the currency's smallest unit (paise, cents, pence). Required to create a price. " +
                'Omit it to change only `countries` on a price that exists.',
            },
            countries: {
              type: 'array',
              maxItems: 250,
              items: { type: 'string' },
              description:
                'ISO 3166-1 alpha-2 codes where this price applies. Omit on an update to leave ' +
                'the list as it is. Empty means wherever the currency is the local one.',
            },
          },
        },
        response: {
          200: ok(
            ref('PlanPrice'),
            'The price as stored, with whether its amount can still change (`amountEditable`) and who is on it ' +
              '(`liveSubscriptions`, `openCheckouts`).',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR: the body failed schema validation; or PLAN_PRICE_CURRENCY_INVALID: ' +
              'not an ISO 4217 code; or PLAN_PRICE_CURRENCY_UNSUPPORTED: a currency no price can be in, ' +
              'which includes every three-decimal currency (BHD, IQD, JOD, KWD, LYD, OMR, TND); or ' +
              'PLAN_PRICE_IS_DEFAULT: `currency` is that of the plan\'s default price, which is changed ' +
              'through the plan; or ' +
              'or PLAN_PRICE_NOT_APPLICABLE: the plan is free or bills usage; or ' +
              'PLAN_PRICE_AMOUNT_INVALID; or PLAN_PRICE_COUNTRY_INVALID.',
            ...BILLING_WRITE_ERRORS,
            404: 'APPLICATION_NOT_FOUND; or PLAN_NOT_FOUND: no plan with that id or slug on this Application.',
            409:
              'PLAN_PRICE_IMMUTABLE: a provider has registered this price, so its amount is fixed; or ' +
              'PLAN_PRICE_REFERENCED: a subscription, an open checkout, a payment or a credit grant names ' +
              'this price, so its amount is fixed.',
          }),
        },
      },
    },
    async (req) => {
      const { id, planId, currency } = PriceParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const body = PutPriceBody.parse(req.body);
      const price = await planPricesService.put({
        applicationId: id,
        plan: planId,
        currency,
        amount: body.amount,
        countries: body.countries,
        actor: { operatorId: req.tenantUser!.id },
      });
      void recordSecurityEvent({
        type: 'app.plan_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { plan: planId, price: price.currency, amount: price.amount, countries: price.countries },
      });
      return { success: true, data: price };
    },
  );

  app.delete(
    '/:id/plans/:planId/prices/:currency',
    {
      config: { access: { scope: 'billing:write' } },
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Remove a Plan price in another currency',
        description:
          'Requires **billing-write** access to this Application, OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.\n\n' +
          'Refused while a live subscription or an open checkout is on this price: a subscriber ' +
          "keeps their currency for the life of the subscription. The plan list reports both counts " +
          "on each price as `liveSubscriptions` and `openCheckouts`.\n\n" +
          'A price that a payment or an ended subscription still names is archived, not deleted: ' +
          'it stops being sold and the rows that name it keep pointing at it. A price nothing ' +
          "names is deleted. The plan's default price is a price row too, but it is not removed " +
          'here: change it through the plan. This route answers PLAN_PRICE_NOT_FOUND for its currency.',
        params: PRICE_PARAMS,
        response: {
          200: ok(
            {
              type: 'object',
              required: ['deleted'],
              properties: {
                deleted: {
                  type: 'boolean',
                  description:
                    'Always true: the price is no longer sold. A price a payment or an ended subscription still names is kept, archived.',
                },
              },
            },
            'The price is no longer sold: archived when a row still names it, deleted otherwise.',
          ),
          ...errs({
            ...BILLING_WRITE_ERRORS,
            404:
              'APPLICATION_NOT_FOUND; or PLAN_NOT_FOUND; or PLAN_PRICE_NOT_FOUND: the plan has no ' +
              'price in that currency.',
            409: 'PLAN_PRICE_IN_USE: a live subscription or an open checkout is on this price.',
          }),
        },
      },
    },
    async (req) => {
      const { id, planId, currency } = PriceParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      await planPricesService.remove({ applicationId: id, plan: planId, currency, actor: { operatorId: req.tenantUser!.id } });
      void recordSecurityEvent({
        type: 'app.plan_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { plan: planId, priceDeleted: currency.toUpperCase() },
      });
      return { success: true, data: { deleted: true } };
    },
  );
}
