/**
 * POST /api/v1/billing/webhook/razorpay/:appSlug   ← per-Application (BYO webhook secret)
 *
 * PERMANENT ALIAS into the shared provider-module pipeline (pipeline.ts;
 * docs/specs/billing-provider-modules.md, P2). Old-route strategy: forward,
 * don't duplicate — this URL is what operators registered with Razorpay, so
 * it must keep working byte-for-byte (same status codes, same response
 * bodies, same idempotency semantics — Razorpay retries depend on them),
 * but the verification/idempotency/dispatch logic now lives in exactly one
 * place. CI's razorpay-webhook suite runs against THIS path and therefore
 * exercises the whole pipeline + Razorpay module + shared appliers.
 *
 * Per-Application ONLY — same trust boundary as Stripe/PayPal. A single
 * shared secret would let one leaked secret forge validly-signed events for
 * any app. The slug names the Application whose OWN webhook secret
 * (HMAC-SHA256 over the raw body) must verify the signature.
 *
 * No bearer auth — the signature IS the auth.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { razorpayModule } from '../providers/modules/razorpay/index.js';
import { handleBillingProviderWebhook } from './pipeline.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

export async function razorpayWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/razorpay/:slug',
    {
      config: { rawBody: true },
      schema: {
        tags: ['Webhooks · Razorpay'],
        security: [],
        summary: 'Receive a Razorpay webhook event for a specific Application (BYO secret)',
        description:
          'The slug must match an Application with Razorpay credentials (including a webhook ' +
          "secret) configured. The signature is verified against THAT Application's webhook " +
          'secret (HMAC-SHA256) — no events from other Razorpay accounts will be accepted.' +
          '\n\n' +
          '**No bearer auth — the provider signature IS the authentication.** Do not send an ' +
          '`Authorization` header; the request is authenticated by verifying the raw body ' +
          "against the Application's own webhook signing secret. `security: []` here means " +
          '"no ReliPay credential", not "unprotected".',
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      },
    },
    async (request, reply) => {
      // Validated for the same 400 the route always produced on junk slugs;
      // the pipeline re-reads it from request.params for resolution.
      SlugParam.parse(request.params);
      return handleBillingProviderWebhook(razorpayModule, request, reply);
    },
  );
}
