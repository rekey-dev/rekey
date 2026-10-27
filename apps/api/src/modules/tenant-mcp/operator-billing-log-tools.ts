/**
 * Operator MCP tool for the billing log: the same entries, filters and paging
 * as `GET /tenant/applications/:id/billing/events`, behind the same scope.
 */

import { z } from 'zod';
import { BILLING_EVENT_TYPES, BILLING_LOG_INCLUDES, BillingLogQuerySchema } from '@rekey.dev/shared-types';
import { accessContextFromTool, applicationAccess } from '../../lib/access-context.js';
import { readBillingLog, resolveBillingLogActors } from '../billing-log/index.js';
import { parseArgs } from './operator-contact-tools.js';
import type { OperatorTool } from './operator-tools.js';
import { loadAppInTenant } from './operator-write-tools.js';

const ID_MAX = 200;
const ID_ARG = { type: 'string', minLength: 1, maxLength: 64 } as const;
const LIMIT_MAX = 100;

const Args = BillingLogQuerySchema
  .extend({
    applicationId: z.string().min(1).max(ID_MAX),
    limit: z.number().int().min(1).max(LIMIT_MAX).default(25),
  })
  .strict();

export const operatorBillingLogTools: OperatorTool[] = [
  {
    name: 'recent_billing_events',
    description:
      "One Application's billing log, newest first: checkouts opened, completed and refused, a price that " +
      'fell back to the default because its currency could not be charged (checkout.price_fallback), ' +
      'payments recorded, failed, not applied and refunded, subscriptions, coupons, credits, and changes ' +
      'to prices and billing settings. Filter by `type` (one or several, comma-separated), `endUserId`, ' +
      '`subscriptionId`, `paymentId`, `currency`, `from` and `to`. Pass `nextCursor` back as `cursor` for ' +
      'older entries. Amounts are in the smallest unit of each entry\'s `currency`. Entries name people by ' +
      'id only. Pass `include: "actors"` to also get `actors`: the email of each end user the entries name ' +
      '(`state` known, erased or unknown) and the name and email of each operator who acted, looked up now and ' +
      'stored nowhere in the log. `actors.endUsers` is null for a caller without the end-users:read scope.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1, maxLength: ID_MAX },
        limit: { type: 'integer', minimum: 1, maximum: LIMIT_MAX, default: 25 },
        cursor: { type: 'string', description: 'The `nextCursor` of the previous call.' },
        type: { type: 'string', description: `One of, or several of, comma-separated: ${BILLING_EVENT_TYPES.join(', ')}.` },
        tier: { type: 'string', enum: ['PERMANENT', 'DIAGNOSTIC'] },
        endUserId: ID_ARG,
        subscriptionId: ID_ARG,
        paymentId: ID_ARG,
        currency: { type: 'string', description: 'ISO 4217.' },
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        include: {
          type: 'string',
          enum: [...BILLING_LOG_INCLUDES],
          description: '`actors` adds who the end users and operators named in the entries are.',
        },
      },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const args = parseArgs(Args, 'recent_billing_events', raw);
      const app = await loadAppInTenant(ctx, args.applicationId, 'read');
      const page = await readBillingLog({
        applicationId: app.id,
        limit: args.limit,
        cursor: args.cursor,
        types: args.type,
        tier: args.tier,
        endUserId: args.endUserId,
        subscriptionId: args.subscriptionId,
        paymentId: args.paymentId,
        currency: args.currency,
        from: args.from === undefined ? undefined : new Date(args.from),
        to: args.to === undefined ? undefined : new Date(args.to),
      });
      if (!args.include?.includes('actors')) return { events: page.items, nextCursor: page.nextCursor, actors: null };
      const access = await applicationAccess(accessContextFromTool(ctx), app.id, 'read');
      const actors = await resolveBillingLogActors(app.id, page.items, {
        mayReadEndUsers: access.scopes.has('end-users:read'),
      });
      return { events: page.items, nextCursor: page.nextCursor, actors };
    },
  },
];
