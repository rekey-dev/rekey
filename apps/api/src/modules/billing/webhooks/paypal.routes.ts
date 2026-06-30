/**
 * POST /api/v1/billing/webhook/paypal/:appSlug   ← per-Application (BYO webhook id)
 *
 * Verification flow:
 *   1. Resolve the Application from the URL slug, load its PayPal creds.
 *   2. Verify the transmission headers against PayPal's online
 *      verify-webhook-signature API (uses the app's webhook id). Bad → 401.
 *   3. Insert into `webhook_events` (provider='paypal') with the unique
 *      `(provider, providerEventId)` constraint. P2002 + already processed =
 *      duplicate → 200, skip. P2002 + NOT processed = PayPal retrying a
 *      failed dispatch → re-attempt it.
 *   4. Dispatch by event type. On failure persist `processing_error` and
 *      return 500 so PayPal retries (dispatch is replay-safe).
 *
 * PayPal verification is ONLINE (one outbound call), unlike Stripe's offline
 * HMAC. In tests (`NODE_ENV === 'test'`) we skip the online call and trust the
 * payload — the same posture as the billing provider stub. There is no global
 * (non-slug) endpoint: PayPal verification requires the per-app webhook id, so
 * the slug is mandatory.
 *
 * No bearer auth — the signature IS the auth.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { RelipayError } from '../../../lib/error.js';
import { applicationsService } from '../../applications/applications.service.js';
import { billingCredentialsService, type PaypalCredentials } from '../credentials.service.js';
import { verifyPaypalWebhook } from '../providers/paypal.js';
import { dispatchPaypalEvent, type PaypalEvent } from './paypal.handler.js';

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

function parseEvent(raw: string): PaypalEvent | null {
  try {
    const parsed = JSON.parse(raw) as PaypalEvent;
    if (typeof parsed?.id !== 'string' || typeof parsed?.event_type !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function paypalWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/paypal/:slug',
    {
      config: { rawBody: true },
      schema: {
        tags: ['Webhooks · PayPal'],
        summary: 'Receive a PayPal webhook event for a specific Application (BYO webhook id)',
        description:
          'The slug must match an Application with PayPal credentials configured. ' +
          'Signature is verified against THAT Application\'s webhook id via PayPal\'s ' +
          'verify-webhook-signature API.',
        params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      },
    },
    async (request, reply) => {
      const { slug } = SlugParam.parse(request.params);
      const raw = (request as RequestWithRawBody).rawBody;
      if (!raw) {
        throw new RelipayError({
          statusCode: 400,
          code: 'WEBHOOK_RAW_BODY_MISSING',
          message: 'Webhook handler did not receive a raw body.',
          fix: 'Internal — fastify-raw-body should be configured. Check src/app.ts plugin order.',
        });
      }
      const event = parseEvent(raw);
      if (!event) {
        throw new RelipayError({
          statusCode: 400,
          code: 'WEBHOOK_PAYLOAD_INVALID',
          message: 'PayPal webhook body is not a recognisable event.',
          fix: 'Expect a JSON object with `id` and `event_type`.',
        });
      }

      const application = await applicationsService.getBySlug(slug);
      const row = await billingCredentialsService.loadDecryptedWithMode(application.id, 'paypal');
      if (!row) {
        throw new RelipayError({
          statusCode: 503,
          code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
          message: `Application "${slug}" has no PayPal credentials set.`,
          fix: 'Set BYO credentials via PUT /api/v1/tenant/applications/:id/billing-credentials/paypal, then point the PayPal webhook here.',
        });
      }

      // Online signature verification. Skipped only OUTSIDE production — in
      // tests (no network) and in dev with the provider stub forced. In
      // production it ALWAYS runs: a runtime flag must never be able to turn
      // a forgeable webhook into a trusted one. (env.ts also refuses to boot
      // a production process with RELIPAY_BILLING_FORCE_STUB=true.)
      const isProduction = process.env.NODE_ENV === 'production';
      const skipVerification =
        !isProduction &&
        (process.env.NODE_ENV === 'test' ||
          process.env.RELIPAY_BILLING_FORCE_STUB === 'true');
      if (!skipVerification) {
        const ok = await verifyPaypalWebhook({
          creds: row.data as PaypalCredentials,
          mode: row.mode,
          headers: request.headers,
          event,
        });
        if (!ok) {
          throw new RelipayError({
            statusCode: 401,
            code: 'WEBHOOK_SIGNATURE_INVALID',
            message: 'PayPal webhook signature verification failed.',
            fix: 'Check the webhook id matches what PayPal shows for this endpoint, and that the transmission headers are intact.',
          });
        }
      }

      let webhookRow;
      try {
        webhookRow = await prisma.webhookEvent.create({
          data: {
            applicationId: application.id,
            provider: 'paypal',
            providerEventId: event.id,
            eventType: event.event_type,
            payload: event as never,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        // The event id already exists. Two cases:
        //   - processedAt set → a true duplicate, skip (200 so PayPal stops).
        //   - processedAt null → a PayPal RETRY of an event whose dispatch
        //     failed earlier (we returned 5xx below). Re-attempt it now —
        //     dispatch is replay-safe (payments dedupe on providerPaymentId,
        //     coupon redemption commits atomically with the payment,
        //     provision is idempotent per period, status updates are absolute).
        const existing = await prisma.webhookEvent.findUnique({
          where: { provider_providerEventId: { provider: 'paypal', providerEventId: event.id } },
        });
        if (!existing || existing.processedAt) {
          request.log.info({ eventId: event.id }, 'duplicate paypal webhook skipped');
          return reply.send({ received: true, processed: false, reason: 'duplicate' });
        }
        request.log.info({ eventId: event.id }, 'retrying previously-failed paypal webhook');
        webhookRow = existing;
      }

      try {
        await dispatchPaypalEvent(event, { log: request.log, applicationId: application.id });
        await prisma.webhookEvent.update({
          where: { id: webhookRow.id },
          data: { processedAt: new Date(), processingError: null },
        });
      } catch (err) {
        request.log.error({ err, eventId: event.id }, 'paypal webhook dispatch failed');
        await prisma.webhookEvent.update({
          where: { id: webhookRow.id },
          data: { processingError: err instanceof Error ? err.message : String(err) },
        });
        // 5xx → PayPal retries with backoff. The row above keeps processedAt
        // null, so the retry takes the re-attempt path instead of the
        // duplicate skip.
        return reply
          .status(500)
          .send({ received: true, processed: false, eventId: event.id });
      }

      return reply.send({ received: true, processed: true, eventId: event.id });
    },
  );
}
