/**
 * POST /api/v1/billing/webhook/razorpay/:appSlug   ← per-Application (BYO webhook secret)
 *
 * Per-Application ONLY — same trust boundary as Stripe/PayPal. A single shared
 * secret would let one leaked secret forge validly-signed events for any app.
 *
 * Verification flow:
 *   1. Resolve the Application from the URL slug; load its BYO Razorpay webhook
 *      secret. No creds / no secret → 503.
 *   2. Verify `x-razorpay-signature` (offline HMAC-SHA256 hex of the raw body
 *      with THAT app's secret) using a timing-safe compare. Bad sig → 401.
 *      The app is identified by the slug, trusted because the secret that
 *      validated the signature is that app's own.
 *   3. Insert into `webhook_events` keyed `(provider, providerEventId)` where
 *      providerEventId is Razorpay's per-delivery `x-razorpay-event-id` header.
 *      P2002 + already processed = duplicate → 200, skip. P2002 + NOT
 *      processed = Razorpay retrying a failed dispatch → re-attempt.
 *   4. Dispatch by event type. On failure persist `processing_error` and
 *      return 500 so Razorpay retries (dispatch is replay-safe).
 *
 * No bearer auth — the signature IS the auth.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { RelipayError } from '../../../lib/error.js';
import { applicationsService } from '../../applications/applications.service.js';
import { billingCredentialsService } from '../credentials.service.js';
import { dispatchRazorpayEvent, type RazorpayEvent } from './razorpay.handler.js';

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

/** Timing-safe hex-digest compare. Returns false on any length/format mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

interface VerifyOk {
  event: RazorpayEvent;
  applicationId: string;
}

async function verifyAndResolve(request: FastifyRequest, applicationSlug: string): Promise<VerifyOk> {
  const raw = (request as RequestWithRawBody).rawBody;
  if (!raw) {
    throw new RelipayError({
      statusCode: 400,
      code: 'WEBHOOK_RAW_BODY_MISSING',
      message: 'Webhook handler did not receive a raw body.',
      fix: 'Internal — fastify-raw-body should be configured. Check src/app.ts plugin order.',
    });
  }
  const sig = request.headers['x-razorpay-signature'];
  if (typeof sig !== 'string') {
    throw new RelipayError({
      statusCode: 401,
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'Missing x-razorpay-signature header.',
      fix: 'Razorpay sets this automatically; for tests sign the raw body with HMAC-SHA256(secret).',
    });
  }

  // Resolve the per-app webhook secret from BYO credentials. No global fallback.
  const application = await applicationsService.getBySlug(applicationSlug);
  const creds = await billingCredentialsService.loadDecrypted(application.id, 'razorpay');
  if (!creds || !creds.webhookSecret) {
    throw new RelipayError({
      statusCode: 503,
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
      message: `Application "${applicationSlug}" has no Razorpay webhook secret configured.`,
      fix: 'Set BYO credentials (including the webhook secret) via PUT /api/v1/tenant/applications/:id/billing-credentials/razorpay, then point the Razorpay webhook URL here.',
    });
  }

  const expected = createHmac('sha256', creds.webhookSecret).update(raw).digest('hex');
  if (!safeEqualHex(expected, sig)) {
    request.log.warn('razorpay webhook signature verification failed');
    throw new RelipayError({
      statusCode: 401,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Razorpay webhook signature is invalid.',
      fix: 'Check the webhook secret matches what Razorpay shows for this endpoint.',
    });
  }

  let parsed: { event?: string; payload?: unknown; created_at?: number };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RelipayError({
      statusCode: 400,
      code: 'WEBHOOK_PAYLOAD_INVALID',
      message: 'Razorpay webhook body is not valid JSON.',
      fix: 'Internal — the signature verified but the body did not parse.',
    });
  }
  if (typeof parsed.event !== 'string' || typeof parsed.payload !== 'object' || parsed.payload === null) {
    throw new RelipayError({
      statusCode: 400,
      code: 'WEBHOOK_PAYLOAD_INVALID',
      message: 'Razorpay webhook body missing event/payload.',
      fix: 'Internal — unexpected Razorpay payload shape.',
    });
  }

  // Razorpay has no event id in the body — its per-delivery unique id rides on
  // the `x-razorpay-event-id` header. Fall back to a deterministic composite if
  // (only ever in non-Razorpay test harnesses) it's absent, so idempotency
  // still has a stable key.
  const headerEventId = request.headers['x-razorpay-event-id'];
  const eventId =
    typeof headerEventId === 'string' && headerEventId.length > 0
      ? headerEventId
      : `rzp_${parsed.event}_${parsed.created_at ?? ''}_${expected.slice(0, 24)}`;

  return {
    event: { ...(parsed as RazorpayEvent), eventId },
    applicationId: application.id,
  };
}

async function persistAndDispatch(
  request: FastifyRequest,
  event: RazorpayEvent,
  applicationId: string,
  reply: FastifyReply,
): Promise<unknown> {
  let webhookRow;
  try {
    webhookRow = await prisma.webhookEvent.create({
      data: {
        applicationId,
        provider: 'razorpay',
        providerEventId: event.eventId,
        eventType: event.event,
        payload: event as never,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    // Event id already exists. processedAt set → true duplicate (200, skip).
    // processedAt null → Razorpay retry of a previously-failed dispatch →
    // re-attempt (dispatch is replay-safe).
    const existing = await prisma.webhookEvent.findUnique({
      where: { provider_providerEventId: { provider: 'razorpay', providerEventId: event.eventId } },
    });
    if (!existing || existing.processedAt) {
      request.log.info({ eventId: event.eventId }, 'duplicate razorpay webhook skipped');
      return reply.send({ received: true, processed: false, reason: 'duplicate' });
    }
    request.log.info({ eventId: event.eventId }, 'retrying previously-failed razorpay webhook');
    webhookRow = existing;
  }

  try {
    await dispatchRazorpayEvent(event, { log: request.log, applicationId });
    await prisma.webhookEvent.update({
      where: { id: webhookRow.id },
      data: { processedAt: new Date(), processingError: null },
    });
  } catch (err) {
    request.log.error({ err, eventId: event.eventId }, 'razorpay webhook dispatch failed');
    await prisma.webhookEvent.update({
      where: { id: webhookRow.id },
      data: { processingError: err instanceof Error ? err.message : String(err) },
    });
    return reply.status(500).send({ received: true, processed: false, eventId: event.eventId });
  }

  return reply.send({ received: true, processed: true, eventId: event.eventId });
}

export async function razorpayWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/razorpay/:slug',
    {
      config: { rawBody: true },
      schema: {
        tags: ['Webhooks · Razorpay'],
        summary: 'Receive a Razorpay webhook event for a specific Application (BYO secret)',
        description:
          'The slug must match an Application with Razorpay credentials (including a webhook ' +
          "secret) configured. The signature is verified against THAT Application's webhook " +
          'secret (HMAC-SHA256) — no events from other Razorpay accounts will be accepted.',
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
