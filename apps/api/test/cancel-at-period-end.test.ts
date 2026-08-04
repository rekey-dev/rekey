/**
 * "Cancel at period end" used to mean "cancel now" for any subscription
 * without a payment provider.
 *
 * `cancelCurrentSubscription` required `provider && providerSubId` before it
 * would schedule a cancellation. Everything else — including an ACTIVE
 * subscription with a perfectly good `currentPeriodEnd` that simply had no
 * provider record — fell through to the immediate branch:
 *
 *     data: { status: 'CANCELED', canceledAt: now, cancelAt: now }
 *
 * which emits `subscription.canceled`, which writes the free ceiling on the
 * spot. The buyer paid for the period and lost it mid-way, with no refund,
 * having explicitly asked for the opposite.
 *
 * This is not a hypothetical shape. Rekey Cloud sells with
 * `COMMERCE_CHECKOUT_ENABLED` off, so every subscription it has is
 * provisioned by hand and carries no provider record — the defect fires on
 * every cancellation it processes.
 *
 * The fix has two halves and both are tested here, because either alone is a
 * bug in the opposite direction:
 *
 *   1. Scheduling no longer requires a provider — the row stays ACTIVE with
 *      `cancelAt` set, and entitlements survive to the date paid for.
 *   2. Something has to actually end it, or (1) leaves the buyer entitled
 *      forever. `expireIfDue` ends any ACTIVE row whose `cancelAt` has passed,
 *      lazily, on read.
 *
 * (2) was originally scoped to rows with NO provider, on the reasoning that a
 * provider-backed one is ended by its own webhook and the local expiry must not
 * race it. That held only for providers that can schedule a cancellation.
 * PayPal cannot — see the second provider-backed case below.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('cancel at period end without a payment provider', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * An Application with billing on, one end-user, and a hand-provisioned
   * ACTIVE subscription with NO provider record — the exact shape Rekey Cloud
   * sells today.
   */
  async function fixture(slug: string, periodEnd: Date) {
    const tenantToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: {
          name: 'k',
          mode: 'live',
          scopes: ['auth:write', 'billing:read', 'billing:write'],
        },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { endUser: { id: string }; accessToken: string });

    const plan = await prisma.plan.create({
      data: {
        applicationId,
        slug: `plan-${slug}`,
        name: 'Paid',
        amount: 9900,
        currency: 'usd',
        interval: 'MONTH',
        active: true,
      },
    });

    const subscription = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: session.endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        currentPeriodEnd: periodEnd,
        // No `provider`, no `providerSubId` — provisioned by hand.
      },
    });

    return { liveKey, session: { ...session, tenantToken }, applicationId, subscription };
  }

  const cancel = (app_: FastifyInstance, liveKey: string, accessToken: string) =>
    app_.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': accessToken },
      payload: { atPeriodEnd: true },
    });

  it('schedules rather than terminating, and the buyer keeps what they paid for', async () => {
    const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000); // 20 days out
    const { liveKey, session, subscription } = await fixture('cape-sched', periodEnd);

    const res = await cancel(app, liveKey, session.accessToken);
    expect(res.statusCode).toBeLessThan(300);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    // The whole point: still ACTIVE, with an end date in the future.
    expect(row.status).toBe('ACTIVE');
    expect(row.cancelAt?.toISOString()).toBe(periodEnd.toISOString());
    expect(row.canceledAt).toBeNull();

    // And the buyer still holds the subscription they paid for.
    const current = await app
      .inject({
        method: 'GET',
        url: '/api/v1/billing/subscription',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': session.accessToken },
      })
      .then((r) => r.json().data as { status: string } | null);
    expect(current?.status).toBe('ACTIVE');
  });

  it('terminates once the date has passed, so it does not stay entitled forever', async () => {
    // The other half. A provider-backed row is ended by the provider's
    // webhook; this one has no webhook coming, so reading it after the date
    // has to be what ends it.
    const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const { liveKey, session, subscription } = await fixture('cape-exp', periodEnd);

    await cancel(app, liveKey, session.accessToken);

    // Move the scheduled date into the past, as the clock would.
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAt: new Date(Date.now() - 60_000) },
    });

    const current = await app
      .inject({
        method: 'GET',
        url: '/api/v1/billing/subscription',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': session.accessToken },
      })
      .then((r) => r.json());

    // Read-through expiry: the row is CANCELED now, and the response says so
    // rather than reporting an ACTIVE subscription that has actually lapsed.
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.status).toBe('CANCELED');
    expect(row.canceledAt).not.toBeNull();
    expect(current.data === null || current.data.status === 'CANCELED').toBe(true);
  });

  it('announces the termination exactly once, even when read concurrently', async () => {
    // Two readers arriving together must not both flip the row and emit two
    // `subscription.canceled` events to the operator's webhook endpoint.
    const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const { liveKey, session, subscription, applicationId } = await fixture('cape-race', periodEnd);

    // A registered endpoint, so the announcement actually produces a delivery
    // row to count. Without one there is nothing to observe and the assertion
    // would pass vacuously.
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/webhooks`,
      headers: { authorization: `Bearer ${session.tenantToken}` },
      payload: { url: 'https://example.com/hook', events: ['subscription.canceled'] },
    });

    await cancel(app, liveKey, session.accessToken);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAt: new Date(Date.now() - 60_000) },
    });

    const read = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/billing/subscription',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': session.accessToken },
      });
    await Promise.all([read(), read(), read()]);

    // Exactly one announcement. Two would mean both readers won the
    // conditional update, which is the race `updateMany`'s count guards.
    const deliveries = await prisma.webhookDelivery.count({
      where: { applicationId, eventType: 'subscription.canceled' },
    });
    expect(deliveries).toBe(1);
  });

  it('does not pre-empt a provider-backed subscription before its date', async () => {
    // The guard that still holds: a scheduled cancellation whose date has NOT
    // arrived is nobody's business to act on yet, provider or not.
    const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const { liveKey, session, subscription } = await fixture('cape-prov-future', periodEnd);

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { provider: 'stripe', providerSubId: 'sub_external_123', cancelAt: periodEnd },
    });

    await app.inject({
      method: 'GET',
      url: '/api/v1/billing/subscription',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': session.accessToken },
    });

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.cancelAt?.toISOString()).toBe(periodEnd.toISOString());
  });

  it('expires a provider-backed subscription once its date HAS passed', async () => {
    // This used to be the opposite assertion — provider-backed rows were
    // skipped outright, on the reasoning that the provider's webhook is the
    // source of truth and the lazy expiry must not race it.
    //
    // That reasoning assumed every provider can schedule a cancellation.
    // PayPal cannot: its only cancel is immediate, so a period-end request
    // terminates the agreement now and the paid period is held open on our
    // side instead (see `applySubscriptionStatusMirror`, which declines to let
    // PayPal's own CANCELLED event shorten it). Under the old guard nothing
    // would ever have ended those rows — PayPal has already said everything it
    // is going to say about that subscription — so they would have stayed
    // ACTIVE and entitled forever, which is bug (2) in this file's header
    // wearing a provider id.
    //
    // Racing is safe in the direction that matters: both sides write the same
    // terminal state, the conditional update means only one wins and only one
    // `subscription.canceled` is announced (asserted above), and `cancelAt` is
    // only ever written after the provider CONFIRMED the cancellation — the
    // cancel call throws on failure and leaves the row alone — so a date in the
    // past means the billing has already stopped.
    const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const { liveKey, session, subscription } = await fixture('cape-prov', periodEnd);

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        provider: 'paypal',
        providerSubId: 'I-EXTERNAL123',
        cancelAt: new Date(Date.now() - 60_000),
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/v1/billing/subscription',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': session.accessToken },
    });

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.status).toBe('CANCELED');
    expect(row.canceledAt).not.toBeNull();
  });
});
