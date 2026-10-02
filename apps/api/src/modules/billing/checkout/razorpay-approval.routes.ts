/**
 * `POST /api/v1/checkout-sessions/:token/razorpay/approved`, registered by
 * `checkoutSessionRoutes` with its per-IP ceiling, token buckets and portal
 * origin check, so it is limited exactly like the PayPal approval.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  RAZORPAY_ORDER_ID as ORDER_ID,
  RAZORPAY_PAYMENT_ID as PAYMENT_ID,
  RAZORPAY_SIGNATURE as SIGNATURE,
  RAZORPAY_SUBSCRIPTION_ID as SUBSCRIPTION_ID,
  type RazorpayPaymentResponse,
} from '@rekey.dev/shared-types/checkout';
import { errs, ok } from '../../../lib/openapi.js';
import { confirmRazorpayApproval } from './razorpay-approval.js';

const ApprovedBody = z.union([
  z.object({ paymentId: z.string().regex(PAYMENT_ID), signature: z.string().regex(SIGNATURE), subscriptionId: z.string().regex(SUBSCRIPTION_ID) }).strict(),
  z.object({ paymentId: z.string().regex(PAYMENT_ID), signature: z.string().regex(SIGNATURE), orderId: z.string().regex(ORDER_ID) }).strict(),
]);

const TokenParam = z.object({ token: z.string().min(1).max(200) });

/**
 * @example
 * registerRazorpayApprovedRoute(app, { onRequest: ipCeiling, bucket: tokenBucket('ckrzp'), assertPortalOrigin });
 */
export function registerRazorpayApprovedRoute(
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
    '/:token/razorpay/approved',
    {
      onRequest: deps.onRequest,
      config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: deps.bucket } },
      schema: {
        tags: ['Public · Checkout'],
        security: [],
        summary: "Report Razorpay's payment from the checkout page",
        description:
          "Verifies the signature Razorpay's checkout handler returned (HMAC-SHA256 with the key secret) " +
          "for this session's subscription or order and, for an order, reads the payment back from Razorpay " +
          'and captures it if the account is on manual capture. Moves the session to `confirming` only. ' +
          "Activates nothing: the purchase completes from Razorpay's webhook. Idempotent.",
        params: deps.tokenParamSchema,
        body: {
          type: 'object',
          required: ['paymentId', 'signature'],
          additionalProperties: false,
          properties: {
            paymentId: { type: 'string', pattern: PAYMENT_ID.source, description: '`razorpay_payment_id`.' },
            signature: { type: 'string', pattern: SIGNATURE.source, description: '`razorpay_signature`.' },
            subscriptionId: { type: 'string', pattern: SUBSCRIPTION_ID.source, description: '`razorpay_subscription_id`, for a subscription.' },
            orderId: { type: 'string', pattern: ORDER_ID.source, description: '`razorpay_order_id`, for a one-time purchase.' },
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
            400: 'VALIDATION_ERROR: the body is not `{ paymentId, signature }` with exactly one of `subscriptionId` or `orderId`.',
            403: 'ORIGIN_NOT_ALLOWED: a browser called this from a site other than the hosted portal.',
            404: deps.notFound,
            409:
              'CHECKOUT_CONFIRMATION_REFUSED: Razorpay does not confirm this payment for this checkout; ' +
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
      const body: RazorpayPaymentResponse = ApprovedBody.parse(req.body);
      return { success: true, data: await confirmRazorpayApproval(token, body) };
    },
  );
}
