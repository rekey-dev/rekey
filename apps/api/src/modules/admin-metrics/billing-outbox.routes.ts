/**
 * Super-admin view of the billing-event outbox: how much is waiting to reach
 * the billing log, and which rows keep failing. Registered under
 * /api/v1/admin/metrics, behind SUPER_ADMIN_KEY like the rest of it.
 */

import type { FastifyInstance } from 'fastify';
import { errs, ok, ref } from '../../lib/openapi.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { billingOutboxStatus } from '../billing-log/index.js';

export async function adminBillingOutboxRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/billing-outbox',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Billing events waiting to reach the billing log',
        description:
          'Counts the billing-event outbox across every Application: rows not yet written to the log, how ' +
          'many of those are due now, and how many have failed `failingThreshold` times or more. `stuck` ' +
          'lists the failing rows with the error of their last attempt, most attempts first, at most 100. ' +
          'Each stuck row is an event missing from its Application\'s billing log until a build that can ' +
          'read it drains it. No event payload is returned.',
        response: {
          200: ok(ref('BillingOutboxStatus'), 'The outbox counts and its stuck rows.'),
          ...errs({
            401: 'ADMIN_AUTH_MISSING: no `Authorization: Bearer` header; or ADMIN_AUTH_INVALID: the value does not match `SUPER_ADMIN_KEY`.',
            403: 'ADMIN_IP_NOT_ALLOWED: the caller IP is outside `ADMIN_IP_ALLOWLIST`; or ADMIN_IP_UNVERIFIABLE: an allowlist is set and the API cannot identify the caller address.',
            429: 'RATE_LIMITED: too many requests. Honour the `Retry-After` header.',
          }),
        },
      },
    },
    async () => ({ success: true, data: await billingOutboxStatus() }),
  );
}
