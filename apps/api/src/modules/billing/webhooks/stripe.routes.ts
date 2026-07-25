/**
 * POST /api/v1/billing/webhook/stripe/:appSlug     ← per-Application (BYO webhook secret)
 *
 * PERMANENT ALIAS into the shared provider-module pipeline (pipeline.ts;
 * docs/specs/billing-provider-modules.md, P1). Old-route strategy: forward,
 * don't duplicate — this URL is what operators registered with Stripe, so
 * it must keep working byte-for-byte (same status codes, same response
 * bodies, same idempotency semantics — Stripe retries depend on them), but
 * the verification/idempotency/dispatch logic now lives in exactly one
 * place. CI's stripe-webhook suite runs against THIS path and therefore
 * exercises the whole pipeline + Stripe module + shared appliers.
 *
 * Per-Application ONLY. There is no deployment-wide endpoint: a single
 * shared `STRIPE_WEBHOOK_SECRET` would be a cross-tenant trust boundary —
 * one leaked secret lets a forged-but-validly-signed event target any app
 * (via `metadata.applicationId`) and move money state. The slug names the
 * Application whose OWN webhook secret must verify the signature — a
 * Stripe account can't sign payloads for someone else's endpoint.
 *
 * No bearer auth — the signature IS the auth.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stripeModule } from '../providers/modules/stripe/index.js';
import { handleBillingProviderWebhook } from './pipeline.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

export async function stripeWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/stripe/:slug',
    {
      config: { rawBody: true },
      schema: {
        tags: ['Webhooks · Stripe'],
        security: [],
        summary: 'Receive a Stripe webhook event for a specific Application (BYO secret)',
        description:
          'The slug must match an Application with Stripe credentials (including a webhook ' +
          "signing secret) configured. The signature is verified against THAT Application's " +
          'webhook secret — no events from other Stripe accounts will be accepted.' +
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
      return handleBillingProviderWebhook(stripeModule, request, reply);
    },
  );
}
