/**
 * Operator route for reading one recorded payment. Registered under
 * /api/v1/tenant/applications.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensureAppAccess } from '../../lib/app-access.js';
import { errs, ok } from '../../lib/openapi.js';
import { requireOperatorAuth } from '../../middleware/operator-auth.js';
import { TENANT_PAYMENT_JSON_SCHEMA, getTenantPayment } from './tenant-payments.js';

const Params = z.object({ id: z.string().min(1), paymentId: z.string().min(1) });

export async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireOperatorAuth);

  app.get(
    '/:id/payments/:paymentId',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'One payment',
        description:
          'Requires **read** access to this Application.\n\n' +
          'The payment as the payments list returns it, by id. `refundable` says whether a refund request would ' +
          'reach the provider that took it, and `refundBlockedReason` why not: the judgement ' +
          '`POST /tenant/applications/{id}/payments/{paymentId}/refunds` makes before it asks a provider.',
        params: {
          type: 'object',
          required: ['id', 'paymentId'],
          properties: {
            id: { type: 'string', description: 'The Application id.' },
            paymentId: { type: 'string', description: "The payment's id, as the payments list returns it." },
          },
        },
        response: {
          200: ok(TENANT_PAYMENT_JSON_SCHEMA, 'The payment.'),
          ...errs({
            401:
              'TENANT_SESSION_MISSING: no `Authorization: Bearer` header; or TENANT_SESSION_INVALID: ' +
              'the token is invalid, expired, or the operator account no longer exists.',
            403:
              'TENANT_MEMBERSHIP_REVOKED: the operator is no longer a member of this workspace; or ' +
              'SCOPE_INSUFFICIENT: the operator token or membership lacks the `billing:read` scope.',
            404:
              'APPLICATION_NOT_FOUND: no application with that id in this workspace (also returned to a ' +
              'MEMBER who holds no grant on it, so its existence is not disclosed); or PAYMENT_NOT_FOUND: ' +
              'no payment with that id in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, paymentId } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await getTenantPayment(id, paymentId) };
    },
  );
}
