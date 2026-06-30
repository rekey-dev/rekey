/**
 * POST /api/v1/billing/webhook/stripe/:appSlug     ← per-Application (BYO webhook secret)
 *
 * Per-Application ONLY. There is no deployment-wide endpoint: a single shared
 * `STRIPE_WEBHOOK_SECRET` would be a cross-tenant trust boundary — one leaked
 * secret lets a forged-but-validly-signed event target any app (via
 * `metadata.applicationId`) and move money state. (Mirrors PayPal, which has
 * always been per-app only.)
 *
 * Verification flow:
 *   1. Resolve the Application from the URL slug; load its BYO Stripe webhook
 *      secret. No creds / no secret → 503.
 *   2. Verify `stripe-signature` against the raw body using THAT app's secret.
 *      Bad sig → 401. The app is identified by the slug, and the slug is
 *      trusted because the secret that validated the signature is that app's
 *      own — a Stripe account can't sign payloads for someone else's endpoint.
 *   3. Insert into `webhook_events` with the unique constraint
 *      `(provider, providerEventId)`. P2002 + already processed = duplicate
 *      → 200, skip. P2002 + NOT processed = Stripe retrying a failed
 *      dispatch → re-attempt it.
 *   4. Dispatch by event type. On failure persist `processing_error` and
 *      return 500 so Stripe retries (dispatch is replay-safe — see
 *      persistAndDispatch).
 *
 * No bearer auth — the signature IS the auth.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { prisma } from '../../../lib/prisma.js';
import { RelipayError } from '../../../lib/error.js';
import { dispatchStripeEvent } from './stripe.handler.js';
import { applicationsService } from '../../applications/applications.service.js';
import { billingCredentialsService } from '../credentials.service.js';

// Stripe doesn't need a real API key just to verify webhook signatures —
// `webhooks.constructEvent` is offline HMAC. Use a placeholder if STRIPE_API_KEY
// isn't set, since Stripe's constructor requires one even when we won't make
// outbound calls.
const stripeForVerification = new Stripe(env.STRIPE_API_KEY ?? 'sk_for_verify_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

interface VerifyOk {
  kind: 'ok';
  event: Stripe.Event;
  applicationId: string;
}

/** Verification + application-resolution for the per-app endpoint. Returns the
 * verified event + application id, or throws a `RelipayError`. */
async function verifyAndResolve(
  request: FastifyRequest,
  applicationSlug: string,
): Promise<VerifyOk> {
  const raw = (request as RequestWithRawBody).rawBody;
  if (!raw) {
    throw new RelipayError({
      statusCode: 400,
      code: 'WEBHOOK_RAW_BODY_MISSING',
      message: 'Webhook handler did not receive a raw body.',
      fix: 'Internal — fastify-raw-body should be configured. Check src/app.ts plugin order.',
    });
  }
  const sig = request.headers['stripe-signature'];
  if (typeof sig !== 'string') {
    throw new RelipayError({
      statusCode: 401,
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'Missing stripe-signature header.',
      fix: "Stripe sets this automatically; for tests use stripe.webhooks.generateTestHeaderString().",
    });
  }

  // Resolve the per-app webhook secret from BYO credentials. No global fallback.
  const application = await applicationsService.getBySlug(applicationSlug);
  const creds = await billingCredentialsService.loadDecrypted(application.id, 'stripe');
  if (!creds || !creds.webhookSecret) {
    throw new RelipayError({
      statusCode: 503,
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
      message: `Application "${applicationSlug}" has no Stripe webhook secret configured.`,
      fix: 'Set BYO credentials (including the webhook signing secret) via PUT /api/v1/tenant/applications/:id/billing-credentials/stripe, then point the Stripe webhook URL here.',
    });
  }

  let event: Stripe.Event;
  try {
    event = stripeForVerification.webhooks.constructEvent(raw, sig, creds.webhookSecret);
  } catch (err) {
    request.log.warn({ err }, 'stripe webhook signature verification failed');
    throw new RelipayError({
      statusCode: 401,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Stripe webhook signature is invalid.',
      fix: 'Check the webhook secret matches what Stripe shows for this endpoint.',
    });
  }

  // The app is identified by the URL slug — the signing secret used above is
  // that app's own, so the slug is trustworthy. No metadata lookup needed.
  return { kind: 'ok', event, applicationId: application.id };
}

async function persistAndDispatch(
  request: FastifyRequest,
  event: Stripe.Event,
  applicationId: string,
  reply: FastifyReply,
): Promise<unknown> {
  let webhookRow;
  try {
    webhookRow = await prisma.webhookEvent.create({
      data: {
        applicationId,
        provider: 'stripe',
        providerEventId: event.id,
        eventType: event.type,
        payload: event as never,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    // The event id already exists. Two cases:
    //   - processedAt set → a true duplicate, skip (200 so Stripe stops).
    //   - processedAt null → a Stripe RETRY of an event whose dispatch
    //     failed earlier (we returned 5xx below). Re-attempt it now —
    //     dispatch is replay-safe (payments dedupe on providerPaymentId,
    //     coupon redemption commits atomically with the payment, provision
    //     is idempotent per period, status updates are absolute).
    const existing = await prisma.webhookEvent.findUnique({
      where: { provider_providerEventId: { provider: 'stripe', providerEventId: event.id } },
    });
    if (!existing || existing.processedAt) {
      request.log.info({ eventId: event.id }, 'duplicate stripe webhook skipped');
      return reply.send({ received: true, processed: false, reason: 'duplicate' });
    }
    request.log.info({ eventId: event.id }, 'retrying previously-failed stripe webhook');
    webhookRow = existing;
  }

  try {
    await dispatchStripeEvent(event, { log: request.log });
    await prisma.webhookEvent.update({
      where: { id: webhookRow.id },
      data: { processedAt: new Date(), processingError: null },
    });
  } catch (err) {
    request.log.error({ err, eventId: event.id }, 'stripe webhook dispatch failed');
    await prisma.webhookEvent.update({
      where: { id: webhookRow.id },
      data: { processingError: err instanceof Error ? err.message : String(err) },
    });
    // 5xx → Stripe retries with backoff. The row above keeps processedAt
    // null, so the retry takes the re-attempt path instead of the
    // duplicate skip.
    return reply
      .status(500)
      .send({ received: true, processed: false, eventId: event.id });
  }

  return reply.send({ received: true, processed: true, eventId: event.id });
}

export async function stripeWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Per-app endpoint — uses the BYO webhook secret stored on the Application.
  // This is the ONLY Stripe webhook endpoint (no deployment-wide fallback).
  app.post(
    '/stripe/:slug',
    {
      config: { rawBody: true },
      schema: {
        tags: ['Webhooks · Stripe'],
        summary: 'Receive a Stripe webhook event for a specific Application (BYO secret)',
        description:
          'The slug must match an Application with Stripe credentials (including a webhook ' +
          "signing secret) configured. The signature is verified against THAT Application's " +
          'webhook secret — no events from other Stripe accounts will be accepted.',
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      },
    },
    async (request, reply) => {
      const { slug } = SlugParam.parse(request.params);
      const verified = await verifyAndResolve(request, slug);
      return persistAndDispatch(request, verified.event, verified.applicationId, reply);
    },
  );
}
