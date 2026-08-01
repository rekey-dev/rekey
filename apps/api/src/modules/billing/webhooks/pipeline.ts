/**
 * Shared inbound-webhook pipeline + generic route
 * (docs/specs/billing-provider-modules.md, P1).
 *
 *   POST /api/v1/webhooks/billing/:provider[/:slug]
 *
 * One pipeline replaces the per-provider route bodies:
 *
 *   parse rawBody (size-capped)
 *   → module.webhook.resolveApplication
 *   → load + decrypt app credentials (503 when the webhook secret/id is absent)
 *   → module.webhook.verify         (test-skip decided HERE, never per-module)
 *   → 401 on failure
 *   → idempotency insert UNIQUE(provider, providerEventId) — same
 *     webhook_events storage/constraint as always; conflict = 200 replay-ack
 *     (unless the earlier dispatch failed, then re-attempt)
 *   → module.webhook.translate → null = 200 ignored (receipt still marked)
 *   → per event: applyBillingEvent — appliers own atomicity + post-commit
 *   → 200; applier throw = processing_error persisted + 5xx so the provider
 *     retries (the retry takes the re-attempt path, not the duplicate skip)
 *
 * Parse-before-verify is forced by reality: verification needs app-scoped
 * credentials, and resolution needs the URL slug or ONE payload field.
 * Mitigation: body size cap, and nothing but resolveApplication executes
 * pre-verify.
 *
 * The legacy per-provider URLs stay registered forever — providers have
 * them configured — as thin aliases forwarding here
 * (stripe/razorpay/paypal .routes.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { applicationsService } from '../../applications/applications.service.js';
import { billingCredentialsService, type BillingProviderName } from '../credentials.service.js';
import { getModule } from '../providers/registry.js';
import type { ProviderModule, RawWebhookReq } from '../providers/module-types.js';
import { applyBillingEvent } from './apply.js';

/**
 * Body size cap. Matches Fastify's default limit (which already governed
 * the legacy routes) — made explicit here because the spec's
 * parse-before-verify mitigation depends on it, not on a framework default
 * someone might raise globally.
 */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576; // 1 MiB

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

const RouteParams = z.object({
  provider: z.string().min(1).max(40),
  slug: z.string().min(1).max(40).optional(),
});

/**
 * Run one inbound webhook request through the pipeline for `module`.
 * Response bodies/status codes reproduce the legacy stripe.routes.ts
 * contract exactly — the alias routes forward here and MUST stay
 * byte-compatible for provider retries (CI's webhook suites pin this).
 */
export async function handleBillingProviderWebhook(
  module: ProviderModule,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const rawBody = (request as RequestWithRawBody).rawBody;
  if (!rawBody) {
    throw new RekeyError({
      statusCode: 400,
      code: 'WEBHOOK_RAW_BODY_MISSING',
      message: 'Webhook handler did not receive a raw body.',
      fix: 'Internal — fastify-raw-body should be configured. Check src/app.ts plugin order.',
    });
  }
  const req: RawWebhookReq = {
    rawBody,
    headers: request.headers,
    // Fastify already JSON-parsed the body (rawBody is kept alongside);
    // reuse it rather than parsing twice.
    payload: request.body,
    params: request.params as { provider?: string; slug?: string },
  };

  // --- Application resolution (the only pre-verify payload read) ---------
  const ref = module.webhook.resolveApplication(req);
  const application =
    'slug' in ref
      ? await applicationsService.getBySlug(ref.slug)
      : await applicationsService.get(ref.applicationId);

  // --- Credentials ------------------------------------------------------
  // BYO, per-application only — a deployment-wide secret would be a
  // cross-tenant trust boundary (one leak signs events for every app).
  // Loaded with the row's mode: online verifiers (PayPal) have per-mode
  // base URLs.
  const credsRow = await billingCredentialsService.loadDecryptedWithMode(
    application.id,
    module.name as BillingProviderName,
  );
  const creds = (credsRow?.data ?? null) as Record<string, string> | null;
  const webhookField = module.credentialSchema.find((f) => f.webhookRole);
  if (!creds || (webhookField && !creds[webhookField.key])) {
    throw new RekeyError({
      statusCode: 503,
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
      message: `Application "${application.slug}" has no ${module.display.label} webhook ${
        webhookField?.webhookRole === 'id' ? 'id' : 'secret'
      } configured.`,
      fix:
        `Set BYO credentials (including the webhook ${webhookField?.webhookRole === 'id' ? 'id' : 'signing secret'}) via ` +
        `PUT /api/v1/tenant/applications/:id/billing-credentials/${module.name}, then point the ${module.display.label} webhook URL here.`,
    });
  }

  // --- Signature verification -------------------------------------------
  // Centralized test-skip, in ONE place — never per-module. Only ONLINE
  // verification (a call to the provider's API, e.g. PayPal) is skipped
  // under NODE_ENV=test; offline-HMAC providers verify even in tests, which
  // sign their fixtures with the app's stored secret. NEVER skipped in
  // production: the explicit !isProduction guard reproduces the legacy
  // paypal.routes gate exactly, so nothing a running process can be handed
  // turns a forgeable webhook into a trusted one.
  const isProduction = process.env.NODE_ENV === 'production';
  const skipVerification =
    module.capabilities.onlineVerify && !isProduction && process.env.NODE_ENV === 'test';
  if (!skipVerification) {
    const result = await module.webhook.verify(req, creds, { mode: credsRow!.mode });
    if (!result.ok) {
      request.log.warn(
        { provider: module.name, code: result.code },
        'billing webhook signature verification failed',
      );
      throw new RekeyError({
        statusCode: 401,
        code: result.code,
        message: result.message,
        ...(result.fix !== undefined && { fix: result.fix }),
      });
    }
  }

  // --- Durable idempotency ----------------------------------------------
  // Same storage + unique key as always: webhook_events UNIQUE(provider,
  // providerEventId). The DB is the source of truth — never Redis.
  const providerEventId = module.webhook.extractEventId(req.payload, req);
  const eventType = module.webhook.extractEventType(req.payload);
  let webhookRow;
  try {
    webhookRow = await prisma.webhookEvent.create({
      data: {
        applicationId: application.id,
        provider: module.name,
        providerEventId,
        eventType,
        payload: req.payload as never,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    // The event id already exists. Two cases:
    //   - processedAt set → a true duplicate, skip (200 so the provider stops).
    //   - processedAt null → a provider RETRY of an event whose dispatch
    //     failed earlier (we returned 5xx below). Re-attempt it now —
    //     the appliers are replay-safe (payments dedupe on providerPaymentId,
    //     coupon redemption commits atomically with the payment, provision
    //     is idempotent per period, status updates are absolute).
    const existing = await prisma.webhookEvent.findUnique({
      where: { provider_providerEventId: { provider: module.name, providerEventId } },
    });
    if (!existing || existing.processedAt) {
      request.log.info(
        { provider: module.name, eventId: providerEventId },
        'duplicate billing webhook skipped',
      );
      return reply.send({ received: true, processed: false, reason: 'duplicate' });
    }
    request.log.info(
      { provider: module.name, eventId: providerEventId },
      'retrying previously-failed billing webhook',
    );
    webhookRow = existing;
  }

  // --- Translate + apply -------------------------------------------------
  try {
    const events = module.webhook.translate(req.payload, {
      log: request.log,
      applicationId: application.id,
      providerEventId,
    });
    if (events === null) {
      // Unhandled event type: deliberately conservative — receipt is still
      // marked processed below so replays short-circuit as duplicates.
      request.log.info(
        { provider: module.name, eventType, eventId: providerEventId },
        'unhandled billing provider event',
      );
    }
    for (const ev of events ?? []) {
      await applyBillingEvent(ev, { log: request.log });
    }
    await prisma.webhookEvent.update({
      where: { id: webhookRow.id },
      data: { processedAt: new Date(), processingError: null },
    });
  } catch (err) {
    request.log.error(
      { err, provider: module.name, eventId: providerEventId },
      'billing webhook dispatch failed',
    );
    await prisma.webhookEvent.update({
      where: { id: webhookRow.id },
      data: { processingError: err instanceof Error ? err.message : String(err) },
    });
    // 5xx → the provider retries with backoff. The row above keeps
    // processedAt null, so the retry takes the re-attempt path instead of
    // the duplicate skip.
    return reply.status(500).send({ received: true, processed: false, eventId: providerEventId });
  }

  return reply.send({ received: true, processed: true, eventId: providerEventId });
}

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
        fix: 'Check the webhook URL — the segment after /webhooks/billing/ must be a provider name (e.g. "stripe").',
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
        '`metadata.applicationId` (Stripe) may omit it. No bearer auth — the signature IS the auth.',
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
