/**
 * POST /api/v1/webhooks/billing/:provider[/:slug]
 *
 * The generic route into the shared provider-module pipeline (pipeline.ts),
 * for any registered provider module, with the response shapes it documents.
 * The per-provider URLs (stripe, razorpay, paypal .routes.ts) forward to the
 * same handler.
 *
 * No bearer auth, the signature IS the auth.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RekeyError } from '../../../lib/error.js';
import { errs, type JsonSchema } from '../../../lib/openapi.js';
import { getModule } from '../providers/registry.js';
import { handleBillingProviderWebhook } from './pipeline.js';

// ---------------------------------------------------------------------------
// Response modelling. This is provider ingress: no credential, the provider
// signature IS the auth, and every ack body below reproduces the legacy
// stripe.routes.ts contract exactly (see the module header), NONE of it is
// the Rekey `{success, data}` / `{success, error}` envelope. Errors, by
// contrast, ARE the Rekey envelope: everything the pipeline itself throws
// below is a `RekeyError`, which `rekeyErrorHandler` renders in the standard
// shape, the ONE exception is the 500 in the catch block at the bottom of
// `handleBillingProviderWebhook`, which is a bare `reply.send()` and so
// deliberately modelled separately from `errs()`.
// ---------------------------------------------------------------------------

/** The two shapes a 200 ack can take, see `handleBillingProviderWebhook`. */
const WebhookAckSuccess: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      description: 'Applied for the first time (or a retry of a previously-failed dispatch).',
      properties: {
        received: { type: 'boolean', enum: [true] },
        processed: { type: 'boolean', enum: [true] },
        eventId: { type: 'string', description: "The provider's event id, the idempotency key." },
      },
      required: ['received', 'processed', 'eventId'],
    },
    {
      type: 'object',
      description:
        'A replay of an event already fully processed (`processedAt` set), re-acknowledged so ' +
        'the provider stops retrying, nothing re-applied.',
      properties: {
        received: { type: 'boolean', enum: [true] },
        processed: { type: 'boolean', enum: [false] },
        reason: { type: 'string', enum: ['duplicate'] },
      },
      required: ['received', 'processed', 'reason'],
    },
  ],
};

/**
 * 500, an applier threw while dispatching a not-yet-processed event. Still
 * `received: true` (the idempotency row is durable, so a provider retry takes
 * the re-attempt path rather than being skipped as a duplicate) but this is
 * NOT the Rekey error envelope, a provider retry loop expects a body it can
 * log, not `{success, error}`.
 */
const WebhookApplyFailed: JsonSchema = {
  type: 'object',
  properties: {
    received: { type: 'boolean', enum: [true] },
    processed: { type: 'boolean', enum: [false] },
    eventId: { type: 'string', description: "The provider's event id, the idempotency key." },
  },
  required: ['received', 'processed', 'eventId'],
};

/**
 * Every error status this route can actually raise. Every one of these is a
 * `RekeyError` thrown before the pipeline's own `reply.send()` calls, so they
 * ARE the Rekey envelope (see `errs()`).
 */
const WEBHOOK_ERRORS = {
  400:
    'WEBHOOK_RAW_BODY_MISSING: internal: fastify-raw-body did not run for this route; or ' +
    'WEBHOOK_PAYLOAD_INVALID: (PayPal, external) the body is not a recognisable event shape, or an external event fails envelope validation; or ' +
    'WEBHOOK_APPLICATION_MISMATCH: the event names a different Application than the one whose ' +
    'BYO credentials verified the signature.',
  401:
    'WEBHOOK_APPLICATION_UNRESOLVED: (Stripe/Razorpay, slug-less route only) no application ' +
    'slug in the URL and none resolvable from the payload; or WEBHOOK_SIGNATURE_MISSING / ' +
    "WEBHOOK_SIGNATURE_INVALID: the provider signature header is absent or does not verify " +
    "against this Application's BYO secret; or WEBHOOK_SIGNATURE_STALE: (external only) the " +
    'signature timestamp is outside the five-minute window.',
  404:
    'WEBHOOK_PROVIDER_UNKNOWN: the `:provider` segment is not a registered billing provider; or ' +
    'APPLICATION_NOT_FOUND: no Application matches the resolved slug/id; or ' +
    'ORGANIZATION_NOT_FOUND or END_USER_NOT_FOUND: the event names an organization or end-user ' +
    'id this Application does not have. Recorded on the receipt and left unprocessed.',
  410:
    'END_USER_ERASED: the event names an end-user who was erased. Recorded on the receipt and ' +
    'left unprocessed.',
  409:
    'WEBHOOK_MODE_MISMATCH: the event states a test/live mode (Stripe `livemode`) that ' +
    "contradicts the mode of the credential that verified it. Recorded on the receipt and " +
    'left unprocessed, so a retry after the credential is corrected applies it.',
  429: 'RATE_LIMITED: too many requests. Honour the `Retry-After` header.',
  503:
    'BILLING_CREDENTIALS_NOT_CONFIGURED: this Application has no BYO webhook secret/id set for ' +
    'this provider; or WEBHOOK_VERIFICATION_UNAVAILABLE: (PayPal only) the online signature-' +
    'verification call to the provider did not answer in time.',
} as const;

/**
 * Body size cap. Matches Fastify's default limit (which already governed
 * the legacy routes), made explicit here because the spec's
 * parse-before-verify mitigation depends on it, not on a framework default
 * someone might raise globally.
 */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576; // 1 MiB

const RouteParams = z.object({
  provider: z.string().min(1).max(40),
  slug: z.string().min(1).max(40).optional(),
});

/**
 * The generic provider-module webhook route. Fastify 5 dropped optional
 * path params, so the slug-less and slug-scoped forms register separately
 * onto one handler.
 */
export async function billingProviderWebhookRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const params = RouteParams.parse(request.params);
    const module = getModule(params.provider);
    if (!module) {
      throw new RekeyError({
        statusCode: 404,
        code: 'WEBHOOK_PROVIDER_UNKNOWN',
        message: `"${params.provider}" is not a registered billing provider.`,
        fix: 'Check the webhook URL, the segment after /webhooks/billing/ must be a provider name (e.g. "stripe").',
      });
    }
    return handleBillingProviderWebhook(module, request, reply);
  };

  const routeConfig = {
    config: { rawBody: true },
    bodyLimit: MAX_WEBHOOK_BODY_BYTES,
    schema: {
      tags: ['Webhooks · Billing'],
      security: [] as Array<Record<string, string[]>>,
      summary: 'Receive a billing-provider webhook event (provider-module pipeline)',
      description:
        'Generic ingress for registered provider modules. The optional slug scopes the ' +
        "Application whose BYO credentials verify the signature; providers whose payloads carry " +
        '`metadata.applicationId` (Stripe) may omit it. No bearer auth, the signature IS the auth.',
      response: {
        200: {
          description:
            'Webhook received and acknowledged, NOT the Rekey `{success, data}` envelope, and ' +
            'byte-compatible with the legacy per-provider routes providers already have configured.',
          ...WebhookAckSuccess,
        },
        500: {
          description:
            'An applier threw while dispatching the event. Still acknowledges receipt, the ' +
            "idempotency row is left unprocessed so the provider's retry re-attempts rather than " +
            'being skipped as a duplicate. NOT the Rekey error envelope.',
          ...WebhookApplyFailed,
        },
        ...errs(WEBHOOK_ERRORS),
      },
    },
  };

  app.post(
    '/:provider',
    {
      ...routeConfig,
      schema: {
        ...routeConfig.schema,
        params: {
          type: 'object',
          properties: { provider: { type: 'string' } },
          required: ['provider'],
        },
      },
    },
    handler,
  );
  app.post(
    '/:provider/:slug',
    {
      ...routeConfig,
      schema: {
        ...routeConfig.schema,
        params: {
          type: 'object',
          properties: { provider: { type: 'string' }, slug: { type: 'string' } },
          required: ['provider', 'slug'],
        },
      },
    },
    handler,
  );
}
