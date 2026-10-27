/**
 * Operator routes that read one Application's billing log: the whole log, the
 * trail of one subscription, payment or end user, and the reconciliation
 * report. Registered under /api/v1/tenant/applications.
 *
 * Reads only, behind `billing:read`. A publishable key and an end user never
 * reach these.
 *
 * Entries name people by id. `?include=actors` adds who those ids are to the
 * page, looked up as it is read: operators for every caller, end users only
 * for a caller who may read end users.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BILLING_EVENT_TIERS,
  BILLING_EVENT_TYPES,
  BILLING_LOG_DEFAULT_LIMIT,
  BILLING_LOG_MAX_LIMIT,
  BillingLogQuerySchema,
  type BillingLogPage,
  type BillingLogQuery,
} from '@rekey.dev/shared-types';
import { ensureAppAccess, type AppAccess } from '../../lib/app-access.js';
import { errs, ok, ref } from '../../lib/openapi.js';
import { requireOperatorAuth } from '../../middleware/operator-auth.js';
import { resolveBillingLogActors } from './actors.js';
import { priceFallbackSummary } from './price-fallbacks.js';
import { readBillingLog } from './reader.js';
import { reconcileApplication, reconciliationPeriod } from './reconciliation.js';

const AppParam = z.object({ id: z.string().min(1) });
const EntityParam = z.object({ id: z.string().min(1), entityId: z.string().min(1).max(64) });
const PeriodQuery = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict();

const READ_ERRORS = {
  400: 'VALIDATION_ERROR: an unknown query parameter, or one that failed validation (an event type that does not exist, a cursor that is not a number, a time that is not ISO 8601).',
  401:
    'TENANT_SESSION_MISSING: no `Authorization: Bearer` header; or TENANT_SESSION_INVALID: ' +
    'the token is invalid, expired, or the operator account no longer exists.',
  403: 'SCOPE_INSUFFICIENT: the operator token or membership does not hold the `billing:read` scope.',
  404:
    'APPLICATION_NOT_FOUND: no application with that id in this workspace (also returned to a ' +
    'MEMBER who holds no grant on it, so its existence is not disclosed).',
} as const;

const FILTERS = {
  cursor: { type: 'string', description: 'The `nextCursor` of the previous page. Entries older than it are returned.' },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: BILLING_LOG_MAX_LIMIT,
    default: BILLING_LOG_DEFAULT_LIMIT,
    description: `Entries to return, at most ${BILLING_LOG_MAX_LIMIT}.`,
  },
  type: {
    type: 'string',
    description: `One event type, or several separated by commas. One of: ${BILLING_EVENT_TYPES.join(', ')}.`,
  },
  tier: {
    type: 'string',
    enum: [...BILLING_EVENT_TIERS],
    description:
      '`PERMANENT` events are kept for the life of the Application. `DIAGNOSTIC` events (opened and refused ' +
      'checkouts, refused coupons, reconciliation findings) are kept 90 days and bounded per hour.',
  },
  currency: { type: 'string', description: 'ISO 4217, any case. Only events about money in this currency.' },
  from: { type: 'string', format: 'date-time', description: 'Events that happened at or after this instant.' },
  to: { type: 'string', format: 'date-time', description: 'Events that happened before this instant.' },
  include: {
    type: 'string',
    enum: ['actors'],
    description:
      '`actors` fills the page\'s `actors`: the email of each end user its entries name and the name and email of each ' +
      'operator who acted, looked up as the page is read and stored nowhere in the log. End users are resolved only ' +
      'for a caller holding the `end-users:read` scope; without it `actors.endUsers` is null. An erased end user ' +
      'comes back with `state: "erased"` and no email.',
  },
} as const;

const ENTITY_FILTERS = {
  endUserId: { type: 'string', description: 'Only entries about this end user.' },
  subscriptionId: { type: 'string', description: 'Only entries that name this subscription.' },
  paymentId: { type: 'string', description: 'Only entries that name this payment, its refunds included.' },
} as const;

const APP_ID_PARAM = { type: 'string', description: 'The Application id.' } as const;
const APP_PARAMS = { type: 'object', properties: { id: APP_ID_PARAM }, required: ['id'] } as const;
const PERIOD_QUERY = {
  type: 'object',
  properties: {
    from: { type: 'string', format: 'date-time', description: 'Start of the period. Seven days before `to` when left out.' },
    to: { type: 'string', format: 'date-time', description: 'End of the period. Now when left out.' },
  },
} as const;

const PAGE = ok(ref('BillingLogPage'), 'One page of the log, newest first. `nextCursor` is null on the last page.');

async function pageFor(
  applicationId: string,
  access: AppAccess,
  query: BillingLogQuery,
  fixed: Partial<BillingLogQuery> = {},
): Promise<BillingLogPage> {
  const filter = { ...query, ...fixed };
  const page = await readBillingLog({
    applicationId,
    limit: filter.limit,
    cursor: filter.cursor,
    types: filter.type,
    tier: filter.tier,
    endUserId: filter.endUserId,
    subscriptionId: filter.subscriptionId,
    paymentId: filter.paymentId,
    currency: filter.currency,
    from: filter.from === undefined ? undefined : new Date(filter.from),
    to: filter.to === undefined ? undefined : new Date(filter.to),
  });
  const actors = query.include?.includes('actors')
    ? await resolveBillingLogActors(applicationId, page.items, { mayReadEndUsers: access.scopes.has('end-users:read') })
    : null;
  return { ...page, actors };
}

/** The trail of one entity: the log with one filter fixed by the path. */
function trail(key: 'endUserId' | 'subscriptionId' | 'paymentId') {
  return async (req: FastifyRequest) => {
    const { id, entityId } = EntityParam.parse(req.params);
    const access = await ensureAppAccess(req, id, 'read');
    const query = BillingLogQuerySchema.parse(req.query ?? {});
    return { success: true, data: await pageFor(id, access, query, { [key]: entityId }) };
  };
}

function trailSchema(summary: string, what: string, entity: string) {
  return {
    tags: ['Tenant · Billing'],
    security: [{ tenantSession: [] }, { operatorPat: [] }],
    summary,
    description:
      'Requires **read** access to this Application and the `billing:read` scope.\n\n' +
      `${what} The same entries, filters, paging and \`include=actors\` as \`GET /:id/billing/events\`. An id that belongs to ` +
      'another Application matches nothing here: the answer is an empty page.',
    params: {
      type: 'object',
      required: ['id', 'entityId'],
      properties: { id: APP_ID_PARAM, entityId: { type: 'string', description: `The id of the ${entity}.` } },
    },
    // Not closed here: Fastify would drop an unknown parameter silently, and the
    // strict parse in the handler is what refuses it.
    querystring: { type: 'object', properties: FILTERS },
    response: { 200: PAGE, ...errs(READ_ERRORS) },
  };
}

export async function tenantBillingLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireOperatorAuth);

  app.get(
    '/:id/billing/events',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: "Read an Application's billing log",
        description:
          'Requires **read** access to this Application and the `billing:read` scope.\n\n' +
          'Every money change and every pricing decision of this Application, newest first: checkouts ' +
          'opened, completed and refused, a price that fell back to the default because its currency could ' +
          'not be charged (`checkout.price_fallback`), payments recorded, failed, not applied and refunded, ' +
          'subscriptions, coupons, credits, and changes to prices and billing settings.\n\n' +
          'Paged on a cursor, never an offset: pass `nextCursor` back as `cursor`. An event written while ' +
          'you page never repeats or displaces an entry. An entry names people by id only, and carries no ' +
          'email address, IP address or user agent. `?include=actors` adds `actors` to the page: who those ids are ' +
          'now, looked up as the page is read. Without it `actors` is null.',
        params: APP_PARAMS,
        querystring: { type: 'object', properties: { ...FILTERS, ...ENTITY_FILTERS } },
        response: { 200: PAGE, ...errs(READ_ERRORS) },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      const access = await ensureAppAccess(req, id, 'read');
      return { success: true, data: await pageFor(id, access, BillingLogQuerySchema.parse(req.query ?? {})) };
    },
  );

  app.get(
    '/:id/billing/subscriptions/:entityId/events',
    {
      config: { access: { scope: 'billing:read' } },
      schema: trailSchema('Read the billing log of one subscription', 'Every log entry that names this subscription.', 'subscription'),
    },
    trail('subscriptionId'),
  );

  app.get(
    '/:id/billing/payments/:entityId/events',
    {
      config: { access: { scope: 'billing:read' } },
      schema: trailSchema(
        'Read the billing log of one payment',
        'Every log entry that names this payment, its refunds included.',
        'payment',
      ),
    },
    trail('paymentId'),
  );

  app.get(
    '/:id/end-users/:entityId/billing-events',
    {
      config: { access: { scope: 'billing:read' } },
      schema: trailSchema(
        'Read the billing log of one end user',
        'Every log entry about this end user. After the end user is erased the entries remain, without the country they checked out from.',
        'end user',
      ),
    },
    trail('endUserId'),
  );

  app.get(
    '/:id/billing/reconciliation',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Compare the billing log with payments, refunds and subscriptions',
        description:
          'Requires **read** access to this Application and the `billing:read` scope.\n\n' +
          'Reports, for one period: a payment with no log entry, a log entry naming a payment that does not ' +
          'exist, a payment whose refunds add up differently in the payment, the refund records and the log, ' +
          'and a subscription with no activation entry. It reads only and changes nothing. The same ' +
          'comparison runs every hour and writes what it finds to the log as `reconciliation.finding`.\n\n' +
          'The period is the last 7 days unless `from` and `to` say otherwise, and at most 31 days. ' +
          'Payments and subscriptions older than the log itself were never logged and are not reported: ' +
          '`paymentsLoggedSince` and `subscriptionsLoggedSince` say where each check starts. It compares ' +
          'Rekey\'s own records with each other, not with the provider\'s list of charges.',
        params: APP_PARAMS,
        querystring: PERIOD_QUERY,
        response: {
          200: ok(ref('ReconciliationReport'), 'What the period held and where the log and the records disagree.'),
          ...errs({
            ...READ_ERRORS,
            400: `${READ_ERRORS[400]} Or BILLING_LOG_PERIOD_INVALID: the period ends before it starts or covers more than 31 days.`,
            503: 'ANALYTICS_TIMEOUT: the comparison exceeded its statement budget; retry with a shorter period.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const period = reconciliationPeriod(PeriodQuery.parse(req.query ?? {}));
      return { success: true, data: await reconcileApplication(id, period) };
    },
  );

  app.get(
    '/:id/billing/price-fallbacks',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Count the checkouts that fell back to the default price',
        description:
          'Requires **read** access to this Application and the `billing:read` scope.\n\n' +
          'How often a buyer was charged a plan\'s default price because no enabled provider could charge ' +
          'the price selected for them, grouped by plan, the currency asked for, the currency charged and ' +
          'the buyer\'s country, most frequent first. Counted from `checkout.price_fallback` in the billing ' +
          'log. The period is the last 7 days unless `from` and `to` say otherwise, and at most 31 days. ' +
          'To stop a group recurring, add its `requestedCurrency` to a provider that can charge it.',
        params: APP_PARAMS,
        querystring: PERIOD_QUERY,
        response: {
          200: ok(ref('PriceFallbackSummary'), 'The fallbacks of the period, grouped.'),
          ...errs({
            ...READ_ERRORS,
            400: `${READ_ERRORS[400]} Or BILLING_LOG_PERIOD_INVALID: the period ends before it starts or covers more than 31 days.`,
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const period = reconciliationPeriod(PeriodQuery.parse(req.query ?? {}));
      return { success: true, data: await priceFallbackSummary(id, period) };
    },
  );
}
