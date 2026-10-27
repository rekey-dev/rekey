/**
 * Operator routes for refunding a recorded payment and reading its refunds.
 * Registered under /api/v1/tenant/applications.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { errs, ok, okPage } from '../../lib/openapi.js';
import { requireOperatorAuth } from '../../middleware/operator-auth.js';
import { refundsService } from './refunds.service.js';

const Params = z.object({ id: z.string().min(1), paymentId: z.string().min(1) });
const PARAMS_SCHEMA = {
  type: 'object',
  required: ['id', 'paymentId'],
  properties: {
    id: { type: 'string', description: 'The Application id.' },
    paymentId: { type: 'string', description: "The payment's id, as the payments list returns it." },
  },
} as const;

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const RefundBody = z
  .object({
    amount: z.number().int().positive().optional(),
    reason: z.string().min(1).max(500).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

const REFUND_SCHEMA = {
  type: 'object',
  required: ['id', 'paymentId', 'providerRefundId', 'amount', 'currency', 'status', 'reason', 'initiatedBy', 'createdAt'],
  properties: {
    id: { type: 'string', description: "The refund's id in Rekey." },
    paymentId: { type: 'string', description: 'The payment this refund pays back.' },
    providerRefundId: { type: 'string', nullable: true, description: "The provider's id for the refund. Null when the provider's event named none." },
    amount: { type: 'integer', description: 'Smallest unit of `currency`.' },
    currency: { type: 'string', description: "The payment's currency, ISO 4217." },
    status: { type: 'string', enum: ['pending', 'succeeded', 'failed'], description: 'A failed refund counts for nothing in `refundedAmount`.' },
    reason: { type: 'string', nullable: true, description: 'Why, as the operator or the provider gave it. Null when none was given.' },
    initiatedBy: {
      type: 'string',
      enum: ['operator', 'provider', 'system'],
      description: 'Who started it: an `operator` through Rekey, the `provider` (its dashboard or a dispute), or Rekey itself (`system`).',
    },
    createdAt: { type: 'string', format: 'date-time', description: 'When Rekey recorded the refund.' },
  },
} as const;

const REFUNDED_PAYMENT_SCHEMA = {
  type: 'object',
  required: ['id', 'amount', 'currency', 'refundedAmount', 'status'],
  properties: {
    id: { type: 'string', description: "The payment's id." },
    amount: { type: 'integer', description: 'What was charged, in the smallest unit of `currency`.' },
    currency: { type: 'string', description: 'ISO 4217, upper-case.' },
    refundedAmount: { type: 'integer', description: 'The sum of this payment\'s refunds that have not failed.' },
    status: {
      type: 'string',
      enum: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
      description: 'REFUNDED once the whole amount is paid back, PARTIALLY_REFUNDED while some of it is.',
    },
  },
} as const;

const SESSION_ERRORS = {
  401: 'TENANT_SESSION_MISSING or TENANT_SESSION_INVALID.',
  403: 'TENANT_MEMBERSHIP_REVOKED, APP_ACCESS_DENIED, or SCOPE_INSUFFICIENT: the `billing:read` scope (to list) or `billing:write` (to refund) is not held.',
  404: 'APPLICATION_NOT_FOUND, or PAYMENT_NOT_FOUND: no payment with that id in this Application.',
} as const;

export async function refundsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireOperatorAuth);

  app.get(
    '/:id/payments/:paymentId/refunds',
    {
      config: { access: { scope: 'billing:read' } },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'The refunds of one payment',
        description:
          'Every refund recorded against the payment, oldest first: those a provider reported and those ' +
          "issued through Rekey. The payment's `refundedAmount` is the sum of the ones that have not failed.",
        params: PARAMS_SCHEMA,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Refunds to return, at most 100.' },
            offset: { type: 'integer', minimum: 0, default: 0, description: 'Refunds to skip before the first one returned.' },
          },
        },
        response: { 200: okPage(REFUND_SCHEMA, 'A page of refunds.'), ...errs(SESSION_ERRORS) },
      },
    },
    async (req) => {
      const { id, paymentId } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { limit, offset } = PageQuery.parse(req.query ?? {});
      return { success: true, data: await refundsService.listForPayment(id, paymentId, { limit, offset }) };
    },
  );

  app.post(
    '/:id/payments/:paymentId/refunds',
    {
      config: { access: { scope: 'billing:write' }, operatorToken: false },
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'Refund a payment, in full or in part',
        description:
          'Requires **write** access to this Application.\n\n' +
          'Asks the provider that took the payment to pay money back, then records the refund. Omit `amount` ' +
          'to refund everything that has not been refunded. A payment can be refunded more than once, up to its ' +
          'amount.\n\n' +
          'Repeating a request is safe: without `idempotencyKey`, the key sent to the provider is derived from ' +
          'the payment, what was already refunded and the amount, so the same request made twice is one refund. ' +
          'Refunding does not cancel a subscription or take back credits or licences.\n\n' +
          'Whether a payment can be refunded is judged before any provider is asked. ' +
          '`GET /tenant/applications/{id}/payments/{paymentId}` reports the same judgement as `refundable` and `refundBlockedReason`.',
        params: PARAMS_SCHEMA,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            amount: { type: 'integer', minimum: 1, description: "Smallest unit of the payment's currency. Omit to refund everything that remains." },
            reason: { type: 'string', maxLength: 500, description: 'Kept on the refund. Sent to the provider where it takes one.' },
            idempotencyKey: {
              type: 'string',
              maxLength: 200,
              description:
                'What makes two requests the same refund at the provider. Leave it out and it is derived from the ' +
                'payment, what was already refunded and the amount.',
            },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              required: ['refund', 'payment'],
              properties: {
                refund: { ...REFUND_SCHEMA, description: 'The refund just recorded.' },
                payment: { ...REFUNDED_PAYMENT_SCHEMA, description: 'The payment after it, with its new refunded total.' },
              },
            },
            'The refund, and the payment with its new refunded total.',
          ),
          ...errs({
            ...SESSION_ERRORS,
            400:
              'BILLING_REFUND_AMOUNT_EXCEEDED: `amount` is more than what has not been refunded; or ' +
              'BILLING_CREDENTIALS_NOT_CONFIGURED: the provider that took the payment has no credentials on this Application.',
            409:
              'BILLING_PAYMENT_NOT_REFUNDABLE, BILLING_PAYMENT_ALREADY_REFUNDED, BILLING_REFUND_UNSUPPORTED, ' +
              'BILLING_REFUND_REJECTED, or BILLING_REFUND_EXCEEDS_PAYMENT.',
          }),
        },
      },
    },
    async (req) => {
      const { id, paymentId } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = RefundBody.parse(req.body ?? {});
      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      return {
        success: true,
        data: await refundsService.issue({
          application,
          paymentId,
          amount: body.amount,
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
          actorId: req.tenantUser!.id,
          log: req.log,
        }),
      };
    },
  );
}
