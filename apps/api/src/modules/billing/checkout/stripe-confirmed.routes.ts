/**
 * `POST /api/v1/checkout-sessions/:token/stripe/confirmed`, registered by
 * `checkoutSessionRoutes` with its per-IP ceiling, token buckets and portal
 * origin check, so it is limited exactly like the PayPal approval.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { STRIPE_CHECKOUT_SESSION_ID_PATTERN } from '@rekey.dev/shared-types/checkout';
import { errs, ok } from '../../../lib/openapi.js';
import { confirmStripePayment } from './stripe-confirmation.js';

const ConfirmedBody = z
  .object({ sessionId: z.string().regex(STRIPE_CHECKOUT_SESSION_ID_PATTERN), via: z.enum(['page', 'return']).optional() })
  .strict();

const TokenParam = z.object({ token: z.string().min(1).max(200) });

/**
 * @example
 * registerStripeConfirmedRoute(app, { onRequest: ipCeiling, bucket: tokenBucket('ckstripe'), assertPortalOrigin, … });
 */
export function registerStripeConfirmedRoute(
  app: FastifyInstance,
  deps: {
    onRequest: (req: FastifyRequest) => Promise<void>;
    bucket: (req: FastifyRequest) => string;
    assertPortalOrigin: (req: FastifyRequest) => void;
    tokenParamSchema: Record<string, unknown>;
    notFound: string;
    rateLimited: string;
  },
): void {
  app.post(
    '/:token/stripe/confirmed',
    {
      onRequest: deps.onRequest,
      config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: deps.bucket } },
      schema: {
        tags: ['Public · Checkout'],
        security: [],
        summary: "Report Stripe's payment from the checkout page",
        description:
          'Reads the Checkout Session back from Stripe and moves the session to `confirming` only when ' +
          "it is this session's Checkout Session, for this session's Application, buyer and plan " +
          '(and amount, for a one-time order), and `complete` at Stripe: paid, needing no payment ' +
          '(a trial), or a bank debit still settling. Activates nothing: the purchase completes from ' +
          "Stripe's webhook. Idempotent.",
        params: deps.tokenParamSchema,
        body: {
          type: 'object',
          required: ['sessionId'],
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', maxLength: 210, pattern: STRIPE_CHECKOUT_SESSION_ID_PATTERN.source },
            via: {
              type: 'string',
              enum: ['page', 'return'],
              description:
                '`return` when the portal checks the session Stripe returned the buyer with on a page load; its refusals do not count toward the limit.',
            },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string', enum: ['confirming', 'complete'] } },
            },
            'The session status after the payment was checked.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR: the body is not `{ sessionId }` with a Stripe Checkout Session id.',
            403: 'ORIGIN_NOT_ALLOWED: a browser called this from a site other than the hosted portal.',
            404: deps.notFound,
            409:
              'CHECKOUT_CONFIRMATION_REFUSED: Stripe does not confirm this payment for this checkout; ' +
              'CHECKOUT_CONFIRMATION_LIMIT: too many refused confirmations, start again; ' +
              'CHECKOUT_SESSION_EXPIRED; or CHECKOUT_MODE_MISMATCH.',
            429: deps.rateLimited,
          }),
        },
      },
    },
    async (req) => {
      deps.assertPortalOrigin(req);
      const { token } = TokenParam.parse(req.params);
      const { sessionId, via } = ConfirmedBody.parse(req.body);
      return { success: true, data: await confirmStripePayment(token, sessionId, via) };
    },
  );
}
