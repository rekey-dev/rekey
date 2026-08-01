/**
 * The GENERIC billing-webhook pipeline —
 * `POST /api/v1/webhooks/billing/:provider[/:slug]`.
 *
 * Every other webhook suite in this repo goes through the legacy per-provider
 * aliases (`/api/v1/billing/webhook/stripe/:slug`). The generic route those
 * aliases forward to, and specifically the **slug-less** form where Stripe's
 * Application is resolved from `payload.metadata.applicationId`, had no test —
 * and `WEBHOOK_APPLICATION_UNRESOLVED` was never asserted anywhere.
 *
 * The slug-less form is the interesting one because resolution happens BEFORE
 * signature verification: the payload is attacker-writable at that point. The
 * design's answer (docs in `billing/AGENTS.md` and `pipeline.ts`) is that
 * verification then runs with THAT Application's own secret, so naming someone
 * else's app buys you nothing. That claim is the centrepiece of this file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { createHmac } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const GENERIC = '/api/v1/webhooks/billing';

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

interface App {
  id: string;
  slug: string;
  webhookSecret: string;
}

describe('generic billing-webhook pipeline', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function rand(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  /** An Application with BYO Stripe credentials, including its own secret. */
  async function bootstrap(prefix: string): Promise<App> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T-${prefix}`, ownerEmail: `${prefix}-${rand()}@example.com` },
      })
      .then((r) => r.json().data as { id: string });
    const slug = `${prefix}-${rand()}`;
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: prefix, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });

    // Per-app secret, deliberately distinct per Application: the whole point
    // below is that one app's secret cannot sign for another.
    const webhookSecret = `whsec_${prefix}_${rand()}`;
    await billingCredentialsService.upsertCredentials(
      application.id,
      'stripe',
      { apiKey: 'sk_test_for_ci_only', webhookSecret },
      { enabled: true, mode: 'test' },
    );
    return { id: application.id, slug, webhookSecret };
  }

  function signStripe(body: unknown, secret: string): { payload: string; headers: Record<string, string> } {
    const payload = JSON.stringify(body);
    return {
      payload,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret }),
      },
    };
  }

  function stripeEvent(id: string, metadata: unknown): Record<string, unknown> {
    return {
      id,
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: `cs_${id}`, metadata } },
    };
  }

  // ---------- slug-less resolution ----------

  it('resolves the Application from payload metadata when the URL has no slug', async () => {
    const a = await bootstrap('slugless');
    const { payload, headers } = signStripe(
      stripeEvent('evt_slugless_1', { applicationId: a.id }),
      a.webhookSecret,
    );

    const res = await app.inject({ method: 'POST', url: `${GENERIC}/stripe`, headers, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, processed: true });

    // Receipt is filed against the resolved Application, not "unknown".
    const row = await prisma.webhookEvent.findUniqueOrThrow({
      // The receipt's unique key is scoped by Application now — two tenants
      // sharing one provider account previously collided here, and the loser's
      // event was acknowledged 200 and dropped.
      where: {
        applicationId_provider_providerEventId: {
          applicationId: a.id,
          provider: 'stripe',
          providerEventId: 'evt_slugless_1',
        },
      },
    });
    expect(row.applicationId).toBe(a.id);
    expect(row.processedAt).not.toBeNull();
  });

  it('the slug-scoped form of the generic route works too', async () => {
    const a = await bootstrap('scoped');
    const { payload, headers } = signStripe(stripeEvent('evt_scoped_1', {}), a.webhookSecret);

    const res = await app.inject({
      method: 'POST',
      url: `${GENERIC}/stripe/${a.slug}`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, processed: true });
  });

  it('the generic route and the legacy alias share one idempotency space', async () => {
    const a = await bootstrap('shared');
    const evt = stripeEvent('evt_shared_1', { applicationId: a.id });
    const { payload, headers } = signStripe(evt, a.webhookSecret);

    const viaGeneric = await app.inject({
      method: 'POST',
      url: `${GENERIC}/stripe`,
      headers,
      payload,
    });
    expect(viaGeneric.json()).toMatchObject({ processed: true });

    // Same event id arriving on the legacy URL must not be applied twice —
    // the money-moving appliers dedupe on the WebhookEvent row, not the route.
    const viaLegacy = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${a.slug}`,
      headers,
      payload,
    });
    expect(viaLegacy.statusCode).toBe(200);
    expect(viaLegacy.json()).toMatchObject({ processed: false, reason: 'duplicate' });
    expect(
      await prisma.webhookEvent.count({ where: { providerEventId: 'evt_shared_1' } }),
    ).toBe(1);
  });

  // ---------- WEBHOOK_APPLICATION_UNRESOLVED ----------

  it('401 WEBHOOK_APPLICATION_UNRESOLVED when neither the slug nor the metadata is present', async () => {
    const a = await bootstrap('unresolved');
    // Signed correctly — the refusal is about scoping, not the signature.
    const { payload, headers } = signStripe(stripeEvent('evt_unresolved_1', {}), a.webhookSecret);

    const res = await app.inject({ method: 'POST', url: `${GENERIC}/stripe`, headers, payload });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_APPLICATION_UNRESOLVED');
    // Nothing was recorded — an unscoped event has no Application to file under.
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it.each([
    ['a non-string applicationId (array)', { applicationId: ['a', 'b'] }],
    ['a non-string applicationId (number)', { applicationId: 42 }],
    ['an empty applicationId', { applicationId: '' }],
    ['null metadata', null],
  ])('401 WEBHOOK_APPLICATION_UNRESOLVED for %s', async (_label, metadata) => {
    const a = await bootstrap('shape');
    const { payload, headers } = signStripe(
      stripeEvent(`evt_shape_${rand()}`, metadata),
      a.webhookSecret,
    );
    const res = await app.inject({ method: 'POST', url: `${GENERIC}/stripe`, headers, payload });
    // A crafted body must never flow onward as an AppRef — the runtime shape
    // check in the Stripe module is the only thing standing between a JSON
    // array and a credential lookup.
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_APPLICATION_UNRESOLVED');
  });

  it('Razorpay has no payload hint, so the slug-less form is always unresolved', async () => {
    const body = JSON.stringify({ event: 'subscription.charged', payload: {} });
    const res = await app.inject({
      method: 'POST',
      url: `${GENERIC}/razorpay`,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', 'whatever').update(body).digest('hex'),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_APPLICATION_UNRESOLVED');
  });

  it('PayPal is slug-only too, and shape-checks the body before resolving', async () => {
    const unresolved = await app.inject({
      method: 'POST',
      url: `${GENERIC}/paypal`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.SALE.COMPLETED' }),
    });
    expect(unresolved.statusCode).toBe(401);
    expect(unresolved.json().error.code).toBe('WEBHOOK_APPLICATION_UNRESOLVED');

    const malformed = await app.inject({
      method: 'POST',
      url: `${GENERIC}/paypal`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ not: 'an event' }),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('WEBHOOK_PAYLOAD_INVALID');
  });

  // ---------- the security claim ----------

  it('naming another Application in the payload buys nothing without that app\'s secret', async () => {
    const victim = await bootstrap('victim');
    const attacker = await bootstrap('attacker');

    // Signed with the attacker's own secret, but claiming to be the victim's
    // Application. Resolution honours the claim; verification then runs with
    // the VICTIM's secret and fails.
    const { payload, headers } = signStripe(
      stripeEvent('evt_forged_1', { applicationId: victim.id }),
      attacker.webhookSecret,
    );

    const res = await app.inject({ method: 'POST', url: `${GENERIC}/stripe`, headers, payload });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    // No receipt against either Application — verification precedes storage.
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it('a valid signature for one app cannot be replayed at another app\'s slug', async () => {
    const a = await bootstrap('appa');
    const b = await bootstrap('appb');
    const { payload, headers } = signStripe(stripeEvent('evt_replay_1', {}), a.webhookSecret);

    const res = await app.inject({
      method: 'POST',
      url: `${GENERIC}/stripe/${b.slug}`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  // ---------- routing + credentials refusals ----------

  it('an unregistered provider name is 404 WEBHOOK_PROVIDER_UNKNOWN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${GENERIC}/bogus-provider/some-slug`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('WEBHOOK_PROVIDER_UNKNOWN');
  });

  it('503 when the resolved Application has no webhook secret configured', async () => {
    const signer = await bootstrap('signer');
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'NoCreds', ownerEmail: `nocreds-${rand()}@example.com` },
      })
      .then((r) => r.json().data as { id: string });
    const bare = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'Bare', slug: `bare-${rand()}` },
      })
      .then((r) => r.json().data as { id: string });

    const { payload, headers } = signStripe(
      stripeEvent('evt_nocreds_1', { applicationId: bare.id }),
      signer.webhookSecret,
    );
    const res = await app.inject({ method: 'POST', url: `${GENERIC}/stripe`, headers, payload });
    // 503, not 401: the request may well be genuine — it is the deployment
    // that is not ready, so the provider should retry rather than give up.
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
  });

  it('a well-formed but unknown applicationId is a 404, not a credential probe', async () => {
    const signer = await bootstrap('unknownid');
    const { payload, headers } = signStripe(
      stripeEvent('evt_unknown_app', { applicationId: 'clzzzzzzzzzzzzzzzzzzzzzzz' }),
      signer.webhookSecret,
    );
    const res = await app.inject({ method: 'POST', url: `${GENERIC}/stripe`, headers, payload });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('APPLICATION_NOT_FOUND');
  });

  it('a missing signature header is refused before anything is stored', async () => {
    const a = await bootstrap('nosig');
    const res = await app.inject({
      method: 'POST',
      url: `${GENERIC}/stripe`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(stripeEvent('evt_nosig_1', { applicationId: a.id })),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNATURE_MISSING');
    expect(await prisma.webhookEvent.count()).toBe(0);
  });
});
