/**
 * Two checkout sessions on ONE subscription row, both completed.
 *
 * Checkout deliberately lets a buyer who has not finished pay somewhere else:
 * two open sessions on the same plan are one row by design, both stay
 * completable at their processors, and refusing the second would block the
 * ordinary "picked PayPal, went back, chose Stripe" without closing anything.
 * The provider-binding guard in billing.service.ts says so, and points here.
 *
 * It pointed at a guard that did not exist. Driven end to end, both completions
 * landed: `applyCheckoutCompleted` has no second-completion check and
 * `transitionAllowed('ACTIVE', 'ACTIVE')` passes, so the row ended up ACTIVE
 * with one processor named in `provider` and the OTHER processor's id in
 * `providerSubId`. Two live provider-side subscriptions, one local row, and
 * cancel reaching exactly one of them while the other billed forever.
 *
 * Two things have to hold for the claim to be true, and both are asserted here:
 *
 *   - the FIRST completion decides the row, including which processor it names
 *     — the `provider` column is a guess until a completion settles it, because
 *     the second checkout overwrote it while nothing had been paid;
 *   - the SECOND completion is refused rather than silently overwriting the id,
 *     because overwriting is what strands the first subscription.
 *
 * Replays are not second completions and must still be idempotent, so the
 * discriminator is the provider subscription id, not the fact of arriving
 * twice.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxPaypal, configureSandboxStripe } from './fakes/billing-credentials.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PASSWORD = 'pw-one-two-three';
const WEBHOOK_SECRET = 'whsec_ci_only';

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

describe('a subscription row that has two completable checkout sessions', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let appSlug: string;
  let liveKey: string;
  let userAccess: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    appSlug = `dbl-${Math.random().toString(36).slice(2, 8)}`;
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'DblT', ownerEmail: `dbl-${appSlug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'DblApp', slug: appSlug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    // BOTH processors, because the failure needs two of them to be reachable.
    await configureSandboxStripe(applicationId);
    await configureSandboxPaypal(applicationId);
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'pro', name: 'Pro', amount: 2900 },
    });
    userAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${appSlug}@example.com`, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  /** Open a checkout through a named processor; returns its session id. */
  async function checkout(provider: 'stripe' | 'paypal'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: {
        planSlug: 'pro',
        provider,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    const data = res.json().data as {
      provider: string;
      subscription: { metadata: { checkoutSessionId: string } };
    };
    expect(data.provider).toBe(provider);
    return data.subscription.metadata.checkoutSessionId;
  }

  function completeStripe(sessionId: string, stripeSubId: string) {
    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          metadata: { applicationId },
          mode: 'subscription',
          subscription: stripeSubId,
        },
      },
    });
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${appSlug}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({
          payload,
          secret: WEBHOOK_SECRET,
        }),
      },
      payload,
    });
  }

  /**
   * PayPal's ACTIVATED, which its module translates to `checkout.completed`
   * with the session id AND the subscription id both being the billing
   * agreement id.
   */
  function completePaypal(paypalSubId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/paypal/${appSlug}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: `WH-${randomUUID()}`,
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: { id: paypalSubId, status: 'ACTIVE' },
      }),
    });
  }

  function theRow() {
    return prisma.subscription.findFirstOrThrow({ where: { applicationId } });
  }

  it('names the processor that actually completed, not the last one a checkout was opened at', async () => {
    // `provider` is written by checkout, before anyone has paid, so the second
    // checkout leaves it naming PayPal while the buyer goes back and pays at
    // Stripe. The row then carried `provider: paypal` and
    // `providerSubId: sub_…` — one processor named, the other's id — and
    // `cancelCurrentSubscription` reads `provider` to decide who to dial.
    const stripeSession = await checkout('stripe');
    await checkout('paypal');

    const res = await completeStripe(stripeSession, 'sub_REAL_STRIPE');
    expect(res.statusCode).toBe(200);

    const row = await theRow();
    expect(row.status).toBe('ACTIVE');
    expect(row.providerSubId).toBe('sub_REAL_STRIPE');
    expect(row.provider).toBe('stripe');
  });

  it('refuses a second completion from the other processor instead of overwriting the id', async () => {
    // Both sessions are live at their processors and the buyer pays both. The
    // second completion used to overwrite `providerSubId`, which is what
    // strands the first subscription: nothing local points at it any more, so
    // cancel never reaches it and it bills forever.
    const stripeSession = await checkout('stripe');
    const paypalSession = await checkout('paypal');

    await completeStripe(stripeSession, 'sub_REAL_STRIPE');
    const second = await completePaypal(paypalSession);
    expect(second.statusCode).toBe(200);

    const row = await theRow();
    expect(row.status).toBe('ACTIVE');
    expect(row.providerSubId).toBe('sub_REAL_STRIPE');
    expect(row.provider).toBe('stripe');
    // And exactly one row: the refusal must not create a parallel subscription
    // either.
    expect(await prisma.subscription.count({ where: { applicationId } })).toBe(1);
    // Refusing does not make the PayPal subscription stop existing — the buyer
    // was charged there and nothing local names it. An operator has to be able
    // to find it three weeks later, which a log line is not.
    const orphans = (row.metadata as { unappliedCompletions?: unknown[] }).unappliedCompletions;
    expect(orphans).toHaveLength(1);
    expect(orphans![0]).toMatchObject({
      providerSubId: paypalSession,
      provider: 'paypal',
      checkoutSessionId: paypalSession,
    });
  });

  it('two completions arriving AT ONCE still leave one winner and record the loser (#437)', async () => {
    // The sequential guard above reads the row, decides, then writes, and the
    // read is outside the transaction. Two completions that both observe a
    // PENDING row therefore both pass it and both fall through to the write —
    // last one wins, and the losing processor's subscription is live, billing,
    // and named nowhere. That is money arriving through a path that does not
    // even record it.
    //
    // The fix states the guard as a WRITE predicate, so Postgres settles it:
    // the two updates serialise on the row lock and the loser re-evaluates
    // against the winner's committed version, matching zero rows.
    const stripeSession = await checkout('stripe');
    const paypalSession = await checkout('paypal');

    await Promise.all([
      completeStripe(stripeSession, 'sub_REAL_STRIPE'),
      completePaypal(paypalSession),
    ]);

    const row = await theRow();
    // Exactly one row, and it is ACTIVE against exactly one processor.
    expect(await prisma.subscription.count({ where: { applicationId } })).toBe(1);
    expect(row.status).toBe('ACTIVE');

    // Whichever won, the OTHER one must be recorded rather than lost. Without
    // the write predicate the loser silently overwrote the winner and nothing
    // was recorded at all, so this is the assertion that fails on the old code.
    const orphans =
      ((row.metadata as { unappliedCompletions?: Array<{ providerSubId?: string }> })
        .unappliedCompletions ?? []);
    const held = row.providerSubId;
    expect(held).toBeTruthy();
    const loser = held === 'sub_REAL_STRIPE' ? paypalSession : 'sub_REAL_STRIPE';
    expect(
      orphans.map((o) => o.providerSubId),
      `row holds ${held}; the other completion must be recorded, not dropped`,
    ).toContain(loser);
  });

  it('records the orphan once however many times its completion is re-delivered', async () => {
    // Webhook re-delivery is routine, and a list that grows per delivery is a
    // leak on a JSON column every completion reads.
    const stripeSession = await checkout('stripe');
    const paypalSession = await checkout('paypal');

    await completeStripe(stripeSession, 'sub_REAL_STRIPE');
    await completePaypal(paypalSession);
    await completePaypal(paypalSession);
    await completePaypal(paypalSession);

    const row = await theRow();
    expect(
      (row.metadata as { unappliedCompletions?: unknown[] }).unappliedCompletions,
    ).toHaveLength(1);
    expect(row.providerSubId).toBe('sub_REAL_STRIPE');
  });

  it('refuses a second completion from the SAME processor too', async () => {
    // Two Stripe sessions, both paid. Same shape, same damage: two Stripe
    // subscriptions and one local row. The discriminator is the provider
    // subscription id, not the processor's name.
    const first = await checkout('stripe');
    const second = await checkout('stripe');
    expect(second).not.toBe(first);

    await completeStripe(first, 'sub_FIRST');
    const res = await completeStripe(second, 'sub_SECOND');
    expect(res.statusCode).toBe(200);

    const row = await theRow();
    expect(row.providerSubId).toBe('sub_FIRST');
  });

  it('still applies a replayed completion idempotently', async () => {
    // The guard keys on the id DIFFERING, so a re-delivery of the same event
    // is not a second completion and nothing about it changes.
    const session = await checkout('stripe');

    await completeStripe(session, 'sub_ONLY');
    const replay = await completeStripe(session, 'sub_ONLY');
    expect(replay.statusCode).toBe(200);

    const row = await theRow();
    expect(row.status).toBe('ACTIVE');
    expect(row.providerSubId).toBe('sub_ONLY');
    // The assertions above cannot tell "applied again, harmlessly" from
    // "refused by the guard" — both leave the row exactly as it was, which is
    // how a guard that swallowed every re-delivery would keep this green. The
    // refusal path is the one that writes here, so its absence is the evidence.
    expect(
      (row.metadata as { unappliedCompletions?: unknown[] }).unappliedCompletions,
    ).toBeUndefined();
  });

  it('lets a genuine resubscribe write a new provider subscription id', async () => {
    // A cancelled row is reused by the next checkout, which walks it back to
    // PENDING. That completion is not a second completion — the previous
    // relationship is over — so it must be free to write its own id.
    const first = await checkout('stripe');
    await completeStripe(first, 'sub_FIRST');
    await prisma.subscription.updateMany({
      where: { applicationId },
      data: { status: 'CANCELED', canceledAt: new Date() },
    });

    const again = await checkout('stripe');
    await completeStripe(again, 'sub_SECOND');

    const row = await theRow();
    expect(row.status).toBe('ACTIVE');
    expect(row.providerSubId).toBe('sub_SECOND');
  });
});
