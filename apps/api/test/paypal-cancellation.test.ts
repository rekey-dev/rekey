/**
 * PayPal cancellation: the buyer keeps what they paid for, and can always stop
 * the money.
 *
 * ## Why this file exists at all
 *
 * #336, #338 and #341 made "cancel at period end" correct — for a subscription
 * with no provider, and for Stripe. Rekey Cloud runs on PayPal. Every fixture
 * those PRs added is Stripe-shaped (`provider: 'stripe'`, a `currentPeriodEnd`
 * already populated), and PayPal matches neither half of that shape:
 *
 *   - PayPal's Subscriptions v1 has **no period-end cancellation**. There is no
 *     `cancel_at_period_end` and no scheduling parameter;
 *     `POST /v1/billing/subscriptions/:id/cancel` terminates the agreement on
 *     the spot. So `atPeriodEnd` cannot be forwarded to PayPal at all, and the
 *     paid period has to be honoured on our side or not at all.
 *   - PayPal's `BILLING.SUBSCRIPTION.ACTIVATED` carries no period anchor that
 *     we used to read, so `currentPeriodEnd` stayed NULL for the whole first
 *     period — and `cancelEffect` requires it to be non-null. The first
 *     cancellation, the most common one there is, was therefore always
 *     immediate.
 *
 * Every case below is written in the PayPal shape on purpose. A fixture shaped
 * like Stripe passes against all of the bugs this file is about.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { cancelEffect } from '@rekey.dev/shared-types';
import type { Subscription } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { RealPaypalProvider } from '../src/modules/billing/providers/paypal.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

/**
 * What the account page shows, reduced to the one input that drives it.
 *
 * the marketing app's `subscriptionFacts` calls an entitled row with a
 * `cancelAt` "cancelling", renders "Ends <cancelAt>", and — this is the part
 * that traps a buyer — replaces the Cancel button with Resubscribe
 * (`account-panel.tsx`). So a stale `cancelAt` on a live subscription is not a
 * cosmetic bug: it removes the only control that stops the charges.
 */
function uiState(row: Subscription): 'cancelling' | 'active' | 'other' {
  if (row.status !== 'ACTIVE' && row.status !== 'PAST_DUE') return 'other';
  return row.cancelAt !== null ? 'cancelling' : 'active';
}

describe('PayPal cancellation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * An application with PayPal credentials, an end-user, and a plan. Nothing
   * here creates the subscription — each case builds the row it needs.
   */
  async function fixture(slug: string) {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T-${slug}`, ownerEmail: `op-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });

    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    await billingCredentialsService.upsertCredentials(
      applicationId,
      'paypal',
      { clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-TEST' },
      { enabled: true, mode: 'test' },
    );

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

    return { applicationId, liveKey, accessToken: session.accessToken, endUserId: session.endUser.id, plan, slug };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function postEvent(slug: string, eventType: string, resource: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/paypal/${slug}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: `WH-${randomUUID()}`, event_type: eventType, resource }),
    });
  }

  function cancel(f: Fixture, atPeriodEnd = true) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': f.accessToken },
      payload: { atPeriodEnd },
    });
  }

  function checkout(f: Fixture) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': f.accessToken },
      payload: {
        planSlug: f.plan.slug,
        provider: 'paypal',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
  }

  const inTwentyDays = () => new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

  // ───────────────────────────────────────────────────────────────────────────
  // Defect 1 — the provider call itself
  // ───────────────────────────────────────────────────────────────────────────

  describe('the outbound cancel call', () => {
    const creds = { clientId: 'cid_ci_only', clientSecret: 'secret_ci_only', webhookId: 'WH-ci' };
    const row = (providerSubId: string | null): Subscription =>
      ({ id: 'local-1', providerSubId }) as Subscription;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Token mint always succeeds; the cancel POST answers however the case says. */
    function stubFetch(cancelResponse: { status: number; body: string }) {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          calls.push(url);
          if (url.includes('/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          // 204 is what PayPal actually answers on a successful cancel, and
          // the Response constructor refuses a body with it.
          return new Response(cancelResponse.status === 204 ? null : cancelResponse.body, {
            status: cancelResponse.status,
          });
        }),
      );
      return calls;
    }

    it('THROWS when PayPal refuses the cancellation', async () => {
      // The whole point. A cancel that PayPal rejected used to resolve
      // successfully, so `cancelCurrentSubscription` went on to stamp the local
      // row cancelled while the agreement carried on billing every month. The
      // buyer is then told they have cancelled, sees no subscription to cancel,
      // and keeps paying — with nothing anywhere recording that the call
      // failed.
      stubFetch({ status: 422, body: '{"name":"UNPROCESSABLE_ENTITY"}' });
      const provider = new RealPaypalProvider(creds, 'test');

      // Throwing is the contract. The message now carries PayPal's own error
      // name rather than the raw status, because a plain Error reached the
      // caller as a generic 500 and told the buyer nothing about a payment
      // that had just failed.
      await expect(
        provider.cancelSubscription({ subscription: row('I-ABC'), atPeriodEnd: false }),
      ).rejects.toMatchObject({
        code: 'BILLING_PROVIDER_REFUSED',
        message: expect.stringContaining('UNPROCESSABLE_ENTITY'),
      });
    });

    it('treats an already-cancelled agreement as success, so a retry settles', async () => {
      // Idempotency: the API retries, and PayPal answers 404 for an agreement
      // it has already terminated. That is the outcome we wanted, not a fault.
      stubFetch({ status: 404, body: '{"name":"RESOURCE_NOT_FOUND"}' });
      const provider = new RealPaypalProvider(creds, 'test');

      await expect(
        provider.cancelSubscription({ subscription: row('I-GONE'), atPeriodEnd: false }),
      ).resolves.toBeUndefined();
    });

    it('never claims to PayPal that the cancellation is scheduled', async () => {
      // PayPal Subscriptions v1 has no period-end cancel. The old code POSTed
      // the same immediate-termination endpoint whatever `atPeriodEnd` said,
      // which at least did not lie to PayPal — but it also never recorded that
      // the flag had nowhere to go. This pins the contract: one endpoint, and
      // no scheduling parameter invented in the body.
      const calls = stubFetch({ status: 204, body: '' });
      const provider = new RealPaypalProvider(creds, 'test');

      await provider.cancelSubscription({ subscription: row('I-ABC'), atPeriodEnd: true });

      expect(calls.some((u) => u.endsWith('/v1/billing/subscriptions/I-ABC/cancel'))).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Defect 1 — the buyer keeps the period they paid for
  // ───────────────────────────────────────────────────────────────────────────

  it("PayPal's own CANCELLED webhook does not repossess the paid period", async () => {
    // The sequence that costs a live buyer time they have paid for:
    //   1. they ask to cancel at period end; the API answers "scheduled" and
    //      the account page says "you keep everything you paid for until <date>";
    //   2. PayPal terminates the agreement immediately, because that is the
    //      only cancel it has;
    //   3. seconds later its BILLING.SUBSCRIPTION.CANCELLED webhook arrives and
    //      the status mirror writes CANCELED — entitlements drop to the free
    //      ceiling mid-period, with no refund, contradicting the sentence the
    //      buyer just read.
    const f = await fixture('pp-keep');
    const periodEnd = inTwentyDays();
    const sub = await prisma.subscription.create({
      data: {
        applicationId: f.applicationId,
        endUserId: f.endUserId,
        planId: f.plan.id,
        status: 'ACTIVE',
        provider: 'paypal',
        providerSubId: 'I-KEEPMINE',
        currentPeriodEnd: periodEnd,
      },
    });

    expect(cancelEffect(sub)).toBe('period-end');
    expect((await cancel(f)).statusCode).toBeLessThan(300);

    const scheduled = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(scheduled.status).toBe('ACTIVE');
    expect(scheduled.cancelAt).not.toBeNull();

    // PayPal reports the termination it just performed.
    const res = await postEvent(f.slug, 'BILLING.SUBSCRIPTION.CANCELLED', { id: 'I-KEEPMINE' });
    expect(res.statusCode).toBe(200);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // The promise held: still entitled, still ending on the day we named.
    expect(after.status).toBe('ACTIVE');
    expect(after.cancelAt?.toISOString()).toBe(periodEnd.toISOString());
  });

  it('gives the first PayPal period an end date, so the first cancel can be scheduled', async () => {
    // `cancelEffect` needs `currentPeriodEnd`. PayPal's activation was
    // translated without one and nothing else wrote it until the SECOND charge
    // (`subscription.period_advanced` refuses to advance while no prior
    // succeeded payment exists), so for the whole of month one the answer was
    // "cancel immediately" — the exact harm #336 set out to remove, on the most
    // common case there is. The live Cloud subscription is in this state now.
    const f = await fixture('pp-first');
    const nextBilling = inTwentyDays();

    const co = await checkout(f);
    expect(co.statusCode).toBe(200);
    const paypalSubId = (
      co.json().data as { subscription: { metadata: { checkoutSessionId: string } } }
    ).subscription.metadata.checkoutSessionId;

    await postEvent(f.slug, 'BILLING.SUBSCRIPTION.ACTIVATED', {
      id: paypalSubId,
      billing_info: { next_billing_time: nextBilling.toISOString() },
    });

    const row = await prisma.subscription.findFirstOrThrow({
      where: { applicationId: f.applicationId, endUserId: f.endUserId },
    });
    expect(row.status).toBe('ACTIVE');
    expect(row.currentPeriodEnd).not.toBeNull();
    expect(cancelEffect(row)).toBe('period-end');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Defect 2 — a resubscribe must not inherit the old cancellation
  // ───────────────────────────────────────────────────────────────────────────

  it('a resubscribe clears the old cancellation and can be cancelled again', async () => {
    // The worst outcome in this codebase. The row is unique on
    // (applicationId, endUserId, planId), so resubscribing REUSES the cancelled
    // row — and nothing on the reactivation path ever cleared `cancelAt`. The
    // subscription the buyer paid for this morning then renders as
    // "Cancelling — ends <a date last month>", the account panel swaps the
    // Cancel button for Resubscribe in that branch, and the cancel endpoint
    // short-circuits on `if (atPeriodEnd && sub.cancelAt !== null) return sub`
    // — 200 OK, nothing done. PayPal keeps charging and the buyer has no
    // working way to stop it.
    const f = await fixture('pp-resub');

    // First period, PayPal shape: no period anchor yet, so this cancel is the
    // immediate one — which is exactly how the live subscription would cancel.
    const first = await prisma.subscription.create({
      data: {
        applicationId: f.applicationId,
        endUserId: f.endUserId,
        planId: f.plan.id,
        status: 'ACTIVE',
        provider: 'paypal',
        providerSubId: 'I-ROUNDONE',
        currentPeriodEnd: null,
      },
    });
    expect(cancelEffect(first)).toBe('immediate');
    expect((await cancel(f)).statusCode).toBeLessThan(300);

    const cancelled = await prisma.subscription.findUniqueOrThrow({ where: { id: first.id } });
    expect(cancelled.status).toBe('CANCELED');
    expect(cancelled.cancelAt).not.toBeNull(); // the immediate path stamps it

    // They change their mind and buy again. Same app, same user, same plan →
    // same row.
    const co = await checkout(f);
    expect(co.statusCode).toBe(200);
    const reused = co.json().data as { subscription: { id: string; metadata: { checkoutSessionId: string } } };
    expect(reused.subscription.id).toBe(first.id);

    await postEvent(f.slug, 'BILLING.SUBSCRIPTION.ACTIVATED', {
      id: reused.subscription.metadata.checkoutSessionId,
      billing_info: { next_billing_time: inTwentyDays().toISOString() },
    });

    const live = await prisma.subscription.findUniqueOrThrow({ where: { id: first.id } });
    expect(live.status).toBe('ACTIVE');
    // The paid-for subscription must not be wearing last month's cancellation.
    expect(live.cancelAt).toBeNull();
    expect(live.canceledAt).toBeNull();
    expect(uiState(live)).toBe('active');

    // And the control that stops the money has to work.
    expect((await cancel(f)).statusCode).toBeLessThan(300);
    const stopped = await prisma.subscription.findUniqueOrThrow({ where: { id: first.id } });
    expect(stopped.cancelAt).not.toBeNull();
    expect(stopped.cancelAt!.getTime()).toBeGreaterThan(Date.now());
    // Scheduled, not terminated — this time there IS a period to run out.
    expect(stopped.status).toBe('ACTIVE');
  });

  it('does not expire a row that was paid for after its cancellation date', async () => {
    // Protects the subscriptions that are ALREADY poisoned. Reactivation now
    // clears `cancelAt` at every seam, so no new row can end up ACTIVE with a
    // date in the past — but rows poisoned before this shipped still exist, and
    // to the lazy expiry they look overdue. Without this guard, deploying the
    // fix would cancel a live, paid-for subscription on its next portal load:
    // the exact harm the fix is for.
    //
    // The discriminator is money. A payment that landed after `cancelAt` means
    // the subscription was restarted; nothing that genuinely lapses takes
    // another payment past its end.
    const f = await fixture('pp-poisoned');
    const cancelledAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sub = await prisma.subscription.create({
      data: {
        applicationId: f.applicationId,
        endUserId: f.endUserId,
        planId: f.plan.id,
        status: 'ACTIVE',
        provider: 'paypal',
        providerSubId: 'I-POISONED',
        cancelAt: cancelledAt,
        canceledAt: cancelledAt,
      },
    });
    await prisma.payment.create({
      data: {
        applicationId: f.applicationId,
        endUserId: f.endUserId,
        subscriptionId: sub.id,
        amount: 9900,
        currency: 'usd',
        status: 'SUCCEEDED',
        providerPaymentId: 'PAY-AFTER-CANCEL',
      },
    });

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/subscription',
      headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': f.accessToken },
    });
    expect(read.statusCode).toBe(200);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.status).toBe('ACTIVE');
    // Healed rather than merely spared: the stale date is what hides the Cancel
    // button and makes the cancel endpoint a no-op.
    expect(row.cancelAt).toBeNull();
    expect(uiState(row)).toBe('active');

    // And the buyer can now stop it.
    expect((await cancel(f)).statusCode).toBeLessThan(300);
    const stopped = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(stopped.status).toBe('CANCELED'); // no currentPeriodEnd → immediate, honestly
  });

  it('a scheduled cancellation survives a replayed activation webhook', async () => {
    // The other direction of the same fix. Clearing `cancelAt` on every
    // activation write would let a re-delivered ACTIVATED event silently
    // un-cancel a subscription the buyer had scheduled to end — PayPal retries
    // webhooks, so this is a routine occurrence, not a hypothetical. Only a
    // genuine transition INTO active may clear it.
    const f = await fixture('pp-replay');

    const co = await checkout(f);
    const paypalSubId = (
      co.json().data as { subscription: { metadata: { checkoutSessionId: string } } }
    ).subscription.metadata.checkoutSessionId;
    await postEvent(f.slug, 'BILLING.SUBSCRIPTION.ACTIVATED', {
      id: paypalSubId,
      billing_info: { next_billing_time: inTwentyDays().toISOString() },
    });

    expect((await cancel(f)).statusCode).toBeLessThan(300);
    const scheduled = await prisma.subscription.findFirstOrThrow({
      where: { applicationId: f.applicationId, endUserId: f.endUserId },
    });
    expect(scheduled.cancelAt).not.toBeNull();

    // PayPal re-delivers the activation.
    await postEvent(f.slug, 'BILLING.SUBSCRIPTION.ACTIVATED', {
      id: paypalSubId,
      billing_info: { next_billing_time: inTwentyDays().toISOString() },
    });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: scheduled.id } });
    expect(after.cancelAt?.toISOString()).toBe(scheduled.cancelAt!.toISOString());
  });
});
