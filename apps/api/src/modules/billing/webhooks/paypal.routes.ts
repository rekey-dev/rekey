/**
 * POST /api/v1/billing/webhook/paypal/:appSlug   ← per-Application (BYO webhook id)
 *
 * PERMANENT ALIAS into the shared provider-module pipeline (pipeline.ts;
 * docs/specs/billing-provider-modules.md, P2). Old-route strategy: forward,
 * don't duplicate — this URL is what operators registered with PayPal, so
 * it must keep working byte-for-byte (same status codes, same response
 * bodies, same idempotency semantics — PayPal retries depend on them), but
 * the verification/idempotency/dispatch logic now lives in exactly one
 * place. CI's paypal-webhook + dunning + outbound-events suites run against
 * THIS path and therefore exercise the whole pipeline + PayPal module +
 * shared appliers.
 *
 * PayPal verification is ONLINE (one outbound call), unlike Stripe's
 * offline HMAC; the test skip is the PIPELINE's centralized gate,
 * keyed on capabilities.onlineVerify and never active in production. There
 * is no global (non-slug) endpoint: verification requires the per-app
 * webhook id, so the slug is mandatory.
 *
 * No bearer auth — the signature IS the auth.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paypalModule } from '../providers/modules/paypal/index.js';
import { handleBillingProviderWebhook } from './pipeline.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

export async function paypalWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/paypal/:slug',
    {
      config: { rawBody: true },
      schema: {
        tags: ['Webhooks · PayPal'],
        security: [],
        summary: 'Receive a PayPal webhook event for a specific Application (BYO webhook id)',
        description:
          'The slug must match an Application with PayPal credentials configured. ' +
          "Signature is verified against THAT Application's webhook id via PayPal's " +
          'verify-webhook-signature API.' +
          '\n\n' +
          '**No bearer auth — the provider signature IS the authentication.** Do not send an ' +
          '`Authorization` header; the request is authenticated by verifying the raw body ' +
          "against the Application's own webhook signing secret. `security: []` here means " +
          '"no Rekey credential", not "unprotected".',
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      },
    },
    async (request, reply) => {
      // Validated for the same 400 the route always produced on junk slugs;
      // the pipeline re-reads it from request.params for resolution.
      SlugParam.parse(request.params);
      return handleBillingProviderWebhook(paypalModule, request, reply);
    },
  );
}
