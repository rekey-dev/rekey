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
import { errs, type JsonSchema } from '../../../lib/openapi.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

/**
 * The webhook pipeline's own ack body — NOT the `{success, data}` envelope.
 * Matches what `handleBillingProviderWebhook` (pipeline.ts) actually sends:
 *   - 200 `{received: true, processed: true, eventId}` — applied.
 *   - 200 `{received: true, processed: false, reason: 'duplicate'}` — replay.
 *   - 500 `{received: true, processed: false, eventId}` — applier threw;
 *     Razorpay retries with backoff.
 * A thrown `RekeyError` (bad slug, no rawBody, no credentials, bad
 * signature) instead falls through to the standard `ErrorResponse` envelope
 * via the global error handler.
 */
const WebhookAck: JsonSchema = {
  type: 'object',
  description: 'The webhook pipeline acknowledgement body (not the `{success, data}` envelope).',
  properties: {
    received: { type: 'boolean', enum: [true] },
    processed: { type: 'boolean' },
    eventId: { type: 'string', description: "The provider's event id, when known." },
    reason: { type: 'string', enum: ['duplicate'], description: 'Present only on a duplicate-skip.' },
  },
  required: ['received', 'processed'],
};

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
          '"no Rekey credential", not "unprotected".',
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        response: {
          200: {
            ...WebhookAck,
            description:
              'Event durably recorded. `processed` is `true` once applied, or `false` on a ' +
              'duplicate replay (`reason: "duplicate"`) or an unhandled event type.',
          },
          500: {
            ...WebhookAck,
            description:
              'Event was durably stored but applying it threw. `processed` is `false`; Razorpay ' +
              'retries with backoff, and the retry re-attempts rather than duplicate-skips.',
          },
          ...errs({
            400:
              'VALIDATION_ERROR — the `:slug` path segment is empty; or WEBHOOK_RAW_BODY_MISSING ' +
              '— internal misconfiguration (fastify-raw-body not wired).',
            401:
              'WEBHOOK_SIGNATURE_MISSING — no `x-razorpay-signature` header; or ' +
              "WEBHOOK_SIGNATURE_INVALID — the HMAC-SHA256 signature does not match this " +
              "Application's stored webhook secret.",
            404: 'APPLICATION_NOT_FOUND — no application with that slug.',
            503:
              'BILLING_CREDENTIALS_NOT_CONFIGURED — this Application has no Razorpay webhook ' +
              'secret configured.',
          }),
        },
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
