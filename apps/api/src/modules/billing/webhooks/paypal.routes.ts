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
import { errs, type JsonSchema } from '../../../lib/openapi.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

/**
 * The webhook pipeline's own ack body — NOT the `{success, data}` envelope.
 * Matches what `handleBillingProviderWebhook` (pipeline.ts) actually sends:
 *   - 200 `{received: true, processed: true, eventId}` — applied.
 *   - 200 `{received: true, processed: false, reason: 'duplicate'}` — replay.
 *   - 500 `{received: true, processed: false, eventId}` — applier threw;
 *     PayPal retries with backoff.
 * A thrown `RekeyError` (bad slug, no rawBody, no credentials, bad/
 * unreachable signature verification, malformed payload) instead falls
 * through to the standard `ErrorResponse` envelope via the global error
 * handler.
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
              'Event was durably stored but applying it threw. `processed` is `false`; PayPal ' +
              'retries with backoff, and the retry re-attempts rather than duplicate-skips.',
          },
          ...errs({
            400:
              'VALIDATION_ERROR — the `:slug` path segment is empty; or WEBHOOK_RAW_BODY_MISSING ' +
              '— internal misconfiguration (fastify-raw-body not wired); or ' +
              'WEBHOOK_PAYLOAD_INVALID — the body is not a recognisable PayPal event (missing ' +
              '`id` / `event_type`).',
            401: 'WEBHOOK_SIGNATURE_INVALID — the transmission signature failed PayPal\'s verify-webhook-signature check.',
            404: 'APPLICATION_NOT_FOUND — no application with that slug.',
            503:
              'BILLING_CREDENTIALS_NOT_CONFIGURED — this Application has no PayPal webhook id ' +
              'configured; or WEBHOOK_VERIFICATION_UNAVAILABLE — PayPal\'s verify-webhook-signature ' +
              'call did not answer in time (fail-closed; PayPal will retry).',
          }),
        },
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
