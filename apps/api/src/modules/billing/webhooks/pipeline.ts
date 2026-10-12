/**
 * Shared inbound-webhook pipeline
 * (docs/specs/billing-provider-modules.md, P1), behind the generic route
 * `POST /api/v1/webhooks/billing/:provider[/:slug]` (generic.routes.ts) and
 * the per-provider aliases.
 *
 * One pipeline replaces the per-provider route bodies:
 *
 *   parse rawBody (size-capped)
 *   → module.webhook.resolveApplication
 *   → load + decrypt app credentials (503 when the webhook secret/id is absent)
 *   → module.webhook.verify         (test-skip decided HERE, never per-module)
 *   → 401 on failure
 *   → idempotency insert UNIQUE(provider, providerEventId), same
 *     webhook_events storage/constraint as always; conflict = 200 replay-ack
 *     (unless the earlier dispatch failed, then re-attempt)
 *   → module.webhook.eventMode vs the credential's mode: a contradiction is
 *     recorded on the receipt and refused 409, left unprocessed so a retry
 *     after the credential is fixed applies it
 *   → module.webhook.translate → null = 200 ignored (receipt still marked)
 *   → any event naming another Application = 400 WEBHOOK_APPLICATION_MISMATCH
 *   → per event: applyBillingEvent, appliers own atomicity + post-commit
 *   → 200; applier throw = processing_error persisted + 5xx so the provider
 *     retries (the retry takes the re-attempt path, not the duplicate skip)
 *
 * Parse-before-verify is forced by reality: verification needs app-scoped
 * credentials, and resolution needs the URL slug or ONE payload field.
 * Mitigation: body size cap, and nothing but resolveApplication executes
 * pre-verify.
 *
 * The legacy per-provider URLs stay registered forever, providers have
 * them configured, as thin aliases forwarding here
 * (stripe/razorpay/paypal .routes.ts).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { applicationsService } from '../../applications/applications.service.js';
import { billingCredentialsService, type BillingProviderName } from '../credentials.service.js';
import type { ProviderModule, RawWebhookReq } from '../providers/module-types.js';
import { applyBillingEvent } from './apply.js';
import { withRenewalPriceIds } from './renewal-price-id.js';

/**
 * Applier refusals that no retry of the same body can fix. They answer with
 * their own 4xx instead of the 500 that asks the sender to retry.
 * BILLING_ORGANIZATION_REQUIRED is not one: the operator can switch the
 * Application to per-user billing, after which the same body applies.
 */
const UNAPPLICABLE_AS_SENT = new Set([
  'ORGANIZATION_NOT_FOUND',
  'END_USER_NOT_FOUND',
  'END_USER_ERASED',
]);

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

/**
 * Run one inbound webhook request through the pipeline for `module`.
 * Response bodies/status codes reproduce the legacy stripe.routes.ts
 * contract exactly, the alias routes forward here and MUST stay
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
      fix: 'Internal, fastify-raw-body should be configured. Check src/app.ts plugin order.',
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
  // BYO, per-application only, a deployment-wide secret would be a
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
  // Centralized test-skip, in ONE place, never per-module. Only ONLINE
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
        // 401 unless the module says otherwise, an ONLINE verifier that
        // could not reach its provider answers 503 so the provider retries
        // instead of reading "your signature is bad".
        statusCode: result.statusCode ?? 401,
        code: result.code,
        message: result.message,
        ...(result.fix !== undefined && { fix: result.fix }),
      });
    }
  }

  // --- Durable idempotency ----------------------------------------------
  // Storage: webhook_events UNIQUE(applicationId, provider, providerEventId).
  // The DB is the source of truth, never Redis.
  //
  // The applicationId is IN the key, and has to be: a provider event id is
  // unique within the provider ACCOUNT, and two Applications can share one
  // (staging + production, a cloned app). While the key was global, the second
  // tenant's genuine event collided with the first's, took the duplicate-skip
  // branch below, and answered 200, so the provider stopped retrying and that
  // tenant's invoice.paid was lost for good.
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
        mode: credsRow!.mode,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    // The event id already exists. Two cases:
    //   - processedAt set → a true duplicate, skip (200 so the provider stops).
    //   - processedAt null → a provider RETRY of an event whose dispatch
    //     failed earlier (we returned 5xx below). Re-attempt it now,
    //     the appliers are replay-safe (payments dedupe on providerPaymentId,
    //     coupon redemption commits atomically with the payment, provision
    //     is idempotent per period, status updates are absolute).
    const existing = await prisma.webhookEvent.findUnique({
      where: {
        applicationId_provider_providerEventId: {
          applicationId: application.id,
          provider: module.name,
          providerEventId,
        },
      },
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
    // The retry may carry a different body than the delivery that failed
    // (a sender that fixed its payload and re-sent under the same id). What
    // is applied below is THIS body, so the receipt records this body.
    webhookRow = await prisma.webhookEvent.update({
      where: { id: existing.id },
      data: { eventType, payload: req.payload as never, mode: credsRow!.mode },
    });
  }

  // --- Mode ---------------------------------------------------------------
  // A live event verified by a test credential (or the reverse) means the
  // stored secret belongs to the other mode's endpoint. Applying it would put
  // real money into a sandbox's books, or sandbox money into real revenue.
  // Recorded and refused with 409, never applied. Not acknowledged: once the
  // operator corrects the credential, the provider's next retry of this same
  // event takes the re-attempt path below (processedAt stays null) and
  // applies. A 2xx here would have lost the event for good.
  const eventMode = module.webhook.eventMode?.(req.payload) ?? null;
  if (eventMode !== null && eventMode !== credsRow!.mode) {
    request.log.error(
      { provider: module.name, eventId: providerEventId, eventMode, credentialMode: credsRow!.mode },
      'billing webhook event mode contradicts the credential that verified it',
    );
    const mismatch = new RekeyError({
      statusCode: 409,
      code: 'WEBHOOK_MODE_MISMATCH',
      message: `A ${eventMode}-mode event was verified by this Application's ${credsRow!.mode}-mode ${module.display.label} credential and was not applied.`,
      fix: `Save ${eventMode}-mode ${module.display.label} credentials for this Application, or save the signing secret of the ${credsRow!.mode}-mode endpoint. The provider's retry of this event then applies it.`,
    });
    await prisma.webhookEvent.update({
      where: { id: webhookRow.id },
      data: { processingError: `${mismatch.code}: ${mismatch.message}` },
    });
    throw mismatch;
  }

  // --- Translate + apply -------------------------------------------------
  // Appliers that deliberately apply nothing say why here; it lands on the
  // receipt so an operator reading the event log sees it.
  const notes: string[] = [];
  try {
    const translated = await module.webhook.translate(req.payload, {
      log: request.log,
      applicationId: application.id,
      providerEventId,
      credentials: creds,
    });
    const events =
      translated !== null && module.webhook.renewalPriceFromSubscription === true
        ? await withRenewalPriceIds(translated, application, module.name, request.log)
        : translated;
    if (events === null) {
      // Unhandled event type: deliberately conservative, receipt is still
      // marked processed below so replays short-circuit as duplicates.
      request.log.info(
        { provider: module.name, eventType, eventId: providerEventId },
        'unhandled billing provider event',
      );
    }
    // The event's Application MUST be the one whose secret verified this
    // request. Stripe's translator reads the id from `payload.metadata`,
    // which is attacker-controlled: a tenant signing with THEIR OWN webhook
    // secret could name another tenant's application and write payments
    // into it, cancel its subscriptions, or pre-poison a provider payment id
    // so the victim's genuine `invoice.paid` was later swallowed as a
    // duplicate. No shared provider account required.
    //
    // Checked for every event before any is applied, and refused with 400
    // rather than the 500 an applier failure gets: a mismatch is either an
    // attack or a translator bug, retrying cannot fix either, and both
    // deserve to be loud.
    const foreign = (events ?? []).find((ev) => ev.applicationId !== application.id);
    if (foreign) {
      request.log.error(
        {
          provider: module.name,
          eventId: providerEventId,
          routeApplicationId: application.id,
          payloadApplicationId: foreign.applicationId,
        },
        'billing webhook event named a different Application than the one that signed it',
      );
      const mismatch = new RekeyError({
        statusCode: 400,
        code: 'WEBHOOK_APPLICATION_MISMATCH',
        message: 'Event names a different Application than the credential that signed it.',
        fix: 'Send the event to the route for the Application whose webhook secret signed it.',
      });
      await prisma.webhookEvent.update({
        where: { id: webhookRow.id },
        data: { processingError: `${mismatch.code}: ${mismatch.message}` },
      });
      throw mismatch;
    }
    for (const ev of events ?? []) {
      await applyBillingEvent(ev, {
        log: request.log,
        provider: module.name,
        mode: credsRow!.mode,
        note: (text) => notes.push(text),
      });
    }
    await prisma.webhookEvent.update({
      where: { id: webhookRow.id },
      data: { processedAt: new Date(), processingError: notes.length > 0 ? notes.join('; ') : null },
    });
  } catch (err) {
    if (err instanceof RekeyError && err.code === 'WEBHOOK_APPLICATION_MISMATCH') throw err;
    // Refused as sent: answering 500 would ask for a retry of the same body,
    // which can never apply. Still unprocessed, so the sender can post a
    // corrected body under the same event id and it re-attempts.
    if (err instanceof RekeyError && UNAPPLICABLE_AS_SENT.has(err.code)) {
      await prisma.webhookEvent.update({
        where: { id: webhookRow.id },
        data: { processingError: `${err.code}: ${err.message}` },
      });
      throw err;
    }
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
