/**
 * PayPal webhook ingress + dispatch.
 *
 * NODE_ENV=test bypasses the online signature verification (no network) —
 * same posture as the billing provider stub. We exercise the full wiring:
 * checkout (stub) creates a PENDING subscription, then synthetic PayPal
 * events flip it through ACTIVE → payment recorded → CANCELED. Idempotency
 * via the (provider, providerEventId) constraint is asserted by replay.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const SLUG = 'pp-app';

describe('PayPal webhook', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(): Promise<void> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'PPT', ownerEmail: 'pp@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'PPApp', slug: SLUG, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    applicationId = application.id;
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    liveKey = key.rawKey;

    // BYO PayPal creds so the webhook route resolves + checkout can route to paypal.
    await billingCredentialsService.upsertCredentials(
      applicationId,
      'paypal',
      { clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-TEST' },
      { enabled: true, mode: 'test' },
    );
  }

  async function createPlan(slug: string, kind: 'SUBSCRIPTION' | 'LICENSE' = 'SUBSCRIPTION'): Promise<void> {
    if (kind === 'LICENSE') {
      // Admin plan route only accepts SUBSCRIPTION fields today; insert the
      // LICENSE plan directly so the auto-issue path can be exercised.
      await prisma.plan.create({
        data: {
          applicationId,
          slug,
          name: slug,
          amount: 4900,
          currency: 'USD',
          kind: 'LICENSE',
          licenseKind: 'PERPETUAL',
        },
      });
      return;
    }
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug, name: slug, amount: 999 },
    });
    expect(res.statusCode).toBe(201);
  }

  async function signUpUser(email = 'pp-user@example.com'): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { token: data.accessToken, id: data.endUser.id };
  }

  /** Drive a PayPal-routed checkout; returns the local sub + paypal sub id. */
  async function checkoutPaypal(
    accessToken: string,
    planSlug: string,
  ): Promise<{ subId: string; paypalSubId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': accessToken },
      payload: {
        planSlug,
        provider: 'paypal',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      provider: string;
      subscription: { id: string; metadata: { checkoutSessionId: string } };
    };
    expect(data.provider).toBe('paypal');
    return {
      subId: data.subscription.id,
      paypalSubId: data.subscription.metadata.checkoutSessionId,
    };
  }

  function postEvent(eventType: string, resource: Record<string, unknown>, eventId?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/paypal/${SLUG}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: eventId ?? `WH-${randomUUID()}`,
        event_type: eventType,
        resource,
      }),
    });
  }

  beforeEach(async () => {
    await bootstrap();
  });

  it('refuses when the slug has no PayPal credentials', async () => {
    // Different app, no creds.
    const t = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'NoCreds', ownerEmail: 'nc@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId: t.id, name: 'NoCredsApp', slug: 'nc-app' },
    });
    const res = await postEventForSlug('nc-app', 'BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-X' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
  });

  function postEventForSlug(slug: string, eventType: string, resource: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/paypal/${slug}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: `WH-${randomUUID()}`, event_type: eventType, resource }),
    });
  }

  it('BILLING.SUBSCRIPTION.ACTIVATED flips PENDING → ACTIVE + persists providerSubId', async () => {
    await createPlan('pro');
    const user = await signUpUser();
    const { subId, paypalSubId } = await checkoutPaypal(user.token, 'pro');

    const before = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(before.status).toBe('PENDING');

    const res = await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', {
      id: paypalSubId,
      custom_id: `${applicationId}:${user.id}`,
      status: 'ACTIVE',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(true);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('ACTIVE');
    expect(after.providerSubId).toBe(paypalSubId);
  });

  it('PAYMENT.SALE.COMPLETED records a SUCCEEDED Payment linked to the subscription', async () => {
    await createPlan('pro');
    const user = await signUpUser();
    const { subId, paypalSubId } = await checkoutPaypal(user.token, 'pro');
    await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', {
      id: paypalSubId,
      custom_id: `${applicationId}:${user.id}`,
    });

    const res = await postEvent('PAYMENT.SALE.COMPLETED', {
      id: `SALE-${randomUUID()}`,
      billing_agreement_id: paypalSubId,
      amount: { total: '9.99', currency: 'USD' },
    });
    expect(res.statusCode).toBe(200);

    const payments = await prisma.payment.findMany({ where: { subscriptionId: subId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe('SUCCEEDED');
    expect(payments[0]!.amount).toBe(999); // 9.99 → 999 minor units
    expect(payments[0]!.currency).toBe('USD');
  });

  it('BILLING.SUBSCRIPTION.SUSPENDED → PAST_DUE (not a hard cancel)', async () => {
    await createPlan('pro');
    const user = await signUpUser();
    const { subId, paypalSubId } = await checkoutPaypal(user.token, 'pro');
    await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', { id: paypalSubId });

    const res = await postEvent('BILLING.SUBSCRIPTION.SUSPENDED', { id: paypalSubId });
    expect(res.statusCode).toBe(200);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('PAST_DUE');
  });

  it('BILLING.SUBSCRIPTION.CANCELLED → CANCELED with canceledAt', async () => {
    await createPlan('pro');
    const user = await signUpUser();
    const { subId, paypalSubId } = await checkoutPaypal(user.token, 'pro');
    await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', { id: paypalSubId });

    const res = await postEvent('BILLING.SUBSCRIPTION.CANCELLED', { id: paypalSubId });
    expect(res.statusCode).toBe(200);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.status).toBe('CANCELED');
    expect(after.canceledAt).not.toBeNull();
  });

  it('duplicate event id is skipped (idempotent)', async () => {
    await createPlan('pro');
    const user = await signUpUser();
    const { paypalSubId } = await checkoutPaypal(user.token, 'pro');

    const eventId = `WH-${randomUUID()}`;
    const first = await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', { id: paypalSubId }, eventId);
    expect(first.json().processed).toBe(true);

    const replay = await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', { id: paypalSubId }, eventId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().processed).toBe(false);
    expect(replay.json().reason).toBe('duplicate');
  });

  it('LICENSE-kind plan auto-issues a license on ACTIVATED', async () => {
    await createPlan('lifetime', 'LICENSE');
    const user = await signUpUser('license-buyer@example.com');
    const { paypalSubId } = await checkoutPaypal(user.token, 'lifetime');

    await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', {
      id: paypalSubId,
      custom_id: `${applicationId}:${user.id}`,
    });

    const licenses = await prisma.license.findMany({
      where: { applicationId, endUserId: user.id },
    });
    expect(licenses).toHaveLength(1);
    expect(licenses[0]!.kind).toBe('PERPETUAL');
  });

  // ---- Renewal re-provisioning (#72): PayPal has no `subscription.updated`
  // event, so `currentPeriodEnd` never advanced and the per-period credit
  // anchor was permanently "initial" → recurring CREDIT packs never refilled.
  it('recurring CREDIT plan refills credits on each renewal sale (not just first)', async () => {
    // SUBSCRIPTION-kind plan carrying a CREDIT entitlement of 500/period.
    const plan = await prisma.plan.create({
      data: { applicationId, slug: 'pack', name: 'Pack', amount: 1500, currency: 'USD', kind: 'SUBSCRIPTION' },
    });
    await prisma.planEntitlement.create({
      data: { planId: plan.id, kind: 'CREDIT', key: '', quantity: 500 },
    });
    const user = await signUpUser('pp-credit@example.com');
    const { paypalSubId } = await checkoutPaypal(user.token, 'pack');

    // Activation provisions the first period's 500 credits.
    await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', {
      id: paypalSubId,
      custom_id: `${applicationId}:${user.id}`,
    });
    const balance = async (): Promise<number> =>
      (await prisma.creditBalance.findFirst({ where: { applicationId, endUserId: user.id } }))?.balance ?? 0;
    expect(await balance()).toBe(500);

    // FIRST sale pays for that SAME initial period → must NOT double-grant.
    await postEvent('PAYMENT.SALE.COMPLETED', {
      id: `SALE-${randomUUID()}`,
      billing_agreement_id: paypalSubId,
      amount: { total: '15.00', currency: 'USD' },
    });
    expect(await balance()).toBe(500);

    // SECOND sale = a real renewal (a prior succeeded payment exists) → advances
    // the period and refills a fresh 500 (total 1000).
    await postEvent('PAYMENT.SALE.COMPLETED', {
      id: `SALE-${randomUUID()}`,
      billing_agreement_id: paypalSubId,
      amount: { total: '15.00', currency: 'USD' },
    });
    expect(await balance()).toBe(1000);

    // A duplicate of the renewal event id is deduped upstream → no extra grant.
    const dupId = `WH-${randomUUID()}`;
    await postEvent(
      'PAYMENT.SALE.COMPLETED',
      { id: `SALE-${randomUUID()}`, billing_agreement_id: paypalSubId, amount: { total: '15.00', currency: 'USD' } },
      dupId,
    );
    const afterThird = await balance();
    const replay = await postEvent(
      'PAYMENT.SALE.COMPLETED',
      { id: `SALE-${randomUUID()}`, billing_agreement_id: paypalSubId, amount: { total: '15.00', currency: 'USD' } },
      dupId,
    );
    expect(replay.json().processed).toBe(false);
    expect(await balance()).toBe(afterThird);
  });

  // ---- Renewal re-provisioning (#73): a TIMED license must roll its term
  // forward each period instead of lapsing after the first.
  it('TIMED license expiry extends on renewal sale (does not lapse after period 1)', async () => {
    const plan = await prisma.plan.create({
      data: {
        applicationId,
        slug: 'timed',
        name: 'Timed',
        amount: 1999,
        currency: 'USD',
        kind: 'LICENSE',
        licenseKind: 'TIMED',
        licenseDurationDays: 30,
        interval: 'MONTH',
      },
    });
    void plan;
    const user = await signUpUser('pp-timed@example.com');
    const { paypalSubId } = await checkoutPaypal(user.token, 'timed');

    await postEvent('BILLING.SUBSCRIPTION.ACTIVATED', {
      id: paypalSubId,
      custom_id: `${applicationId}:${user.id}`,
    });
    const lic1 = await prisma.license.findFirstOrThrow({ where: { applicationId, endUserId: user.id } });
    expect(lic1.kind).toBe('TIMED');
    const firstExpiry = lic1.expiresAt!.getTime();

    // First sale = initial period → no extension.
    await postEvent('PAYMENT.SALE.COMPLETED', {
      id: `SALE-${randomUUID()}`,
      billing_agreement_id: paypalSubId,
      amount: { total: '19.99', currency: 'USD' },
    });
    const lic2 = await prisma.license.findUniqueOrThrow({ where: { id: lic1.id } });
    expect(lic2.expiresAt!.getTime()).toBe(firstExpiry);

    // Second sale = renewal → expiry pushed out by ~30 days.
    await postEvent('PAYMENT.SALE.COMPLETED', {
      id: `SALE-${randomUUID()}`,
      billing_agreement_id: paypalSubId,
      amount: { total: '19.99', currency: 'USD' },
    });
    const lic3 = await prisma.license.findUniqueOrThrow({ where: { id: lic1.id } });
    expect(lic3.expiresAt!.getTime()).toBeGreaterThan(firstExpiry);
    const extendedBy = lic3.expiresAt!.getTime() - firstExpiry;
    // ~30 days (allow a few seconds of clock slack in the base=max(expiry,now) calc).
    expect(extendedBy).toBeGreaterThan(29 * 86_400_000);
    expect(extendedBy).toBeLessThan(31 * 86_400_000);
    expect(lic3.status).toBe('ACTIVE');
  });
});
