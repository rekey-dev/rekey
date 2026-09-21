/**
 * Buying the same one-off plan twice must charge twice and DELIVER twice.
 *
 * It charged twice and delivered once, permanently (#490). The ledger anchor
 * for a purchase is period-scoped:
 *
 *     const period = args.firstPeriod ? 'initial' : sub.currentPeriodEnd?.toISOString() ?? 'initial';
 *
 * A one-off plan never gets a `currentPeriodEnd`, so BOTH branches yield
 * `'initial'`, and `createCheckoutSession` upserts the same
 * `(applicationId, endUserId, planId)` row so `sub.id` does not change either.
 * The second purchase therefore computes a ledger key identical to the first,
 * `credits.service` sees the prior entry and returns `{ applied: false }`, and
 * the balance does not move, while `recordCompletionPayment` books the revenue.
 *
 * Nothing reported an anomaly: the webhook answered 200 and `provision` logged
 * "entitlements provisioned".
 *
 * The existing credit-anchor coverage in `stripe-webhook.test.ts` uses a
 * SUBSCRIPTION plan carrying a CREDIT entitlement. That plan advances its
 * period, so its anchor differs per period and this defect is invisible there.
 *
 * There is deliberately no recurring-plan test HERE. The complementary property,
 * that a recurring plan still anchors on its PERIOD and grants once, is
 * already pinned by three tests in `stripe-webhook.test.ts`, and they are
 * sensitive to it: forcing every plan down the one-off branch fails all three,
 * in both directions (a renewal that stops refilling, and a first period
 * granted twice). A version of that test written here passed with the anchor
 * mutated, so it was measuring something else and has been removed rather than
 * kept as reassurance.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

const PASSWORD = 'pw-one-two-three';
const WEBHOOK_SECRET = 'whsec_ci_only';
const PACK_AMOUNT = 4999;

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

describe('buying the same one-off plan twice', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let appSlug: string;
  let liveKey: string;
  let userAccess: string;
  let endUserId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    appSlug = `repeat-${Math.random().toString(36).slice(2, 8)}`;
    const operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${appSlug}@example.com`, password: PASSWORD, workspaceName: `WS ${appSlug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: `App ${appSlug}`, slug: appSlug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await configureSandboxStripe(applicationId);

    for (const plan of [
      { slug: 'pack', name: 'Pack', amount: PACK_AMOUNT, kind: 'CREDIT', creditsAmount: 100 },
      { slug: 'perp', name: 'Perpetual', amount: PACK_AMOUNT, kind: 'LICENSE', licenseKind: 'PERPETUAL' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: plan,
      });
      expect(res.statusCode).toBe(201);
    }

    const signUp = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${appSlug}@example.com`, password: PASSWORD },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    userAccess = signUp.accessToken;
    endUserId = signUp.endUser.id;
  });

  async function openCheckout(planSlug: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: {
        planSlug,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        provider: 'stripe',
      },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data as { subscription: { metadata: { checkoutSessionId: string } } })
      .subscription.metadata.checkoutSessionId;
  }

  async function complete(sessionId: string, intent: string): Promise<void> {
    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { applicationId },
          id: sessionId,
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: intent,
          amount_total: PACK_AMOUNT,
          currency: 'usd',
        },
      },
    });
    const hook = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${appSlug}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      },
      payload,
    });
    expect(hook.statusCode).toBe(200);
  }

  async function buy(planSlug: string, intent: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: {
        planSlug,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        provider: 'stripe',
      },
    });
    expect(res.statusCode).toBe(200);
    const sessionId = (res.json().data as { subscription: { metadata: { checkoutSessionId: string } } })
      .subscription.metadata.checkoutSessionId;

    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { applicationId },
          id: sessionId,
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: intent,
          amount_total: PACK_AMOUNT,
          currency: 'usd',
        },
      },
    });
    const hook = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${appSlug}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      },
      payload,
    });
    expect(hook.statusCode).toBe(200);
  }

  it('a second credit pack grants a second pack', async () => {
    await buy('pack', 'pi_first');
    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);

    await buy('pack', 'pi_second');

    // THE assertion. This was 100: charged twice, credited once.
    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(200);

    // And the money side really did move twice, which is what makes the
    // under-delivery a loss to the buyer rather than a double-grant bug.
    const payments = await prisma.payment.findMany({
      where: { applicationId, status: 'SUCCEEDED' },
    });
    expect(payments).toHaveLength(2);
    expect(payments.reduce((n, p) => n + p.amount, 0)).toBe(PACK_AMOUNT * 2);

    // Two ledger credits, not one entry reused.
    const credits = await prisma.creditLedger.findMany({
      where: { applicationId, endUserId, delta: { gt: 0 } },
    });
    expect(credits).toHaveLength(2);
  });

  it('a repeat purchase of a PERPETUAL licence is not silently swallowed', async () => {
    await buy('perp', 'pi_perp_1');
    const first = await prisma.license.findMany({ where: { applicationId, endUserId } });
    expect(first).toHaveLength(1);

    await buy('perp', 'pi_perp_2');

    // A perpetual licence has nothing to extend, so the honest outcome is that
    // the buyer was charged for something they already own. What must NOT
    // happen is the payment being taken with no record tying it to anything:
    // both charges are recorded, so an operator can see the duplicate and
    // refund it.
    const payments = await prisma.payment.findMany({
      where: { applicationId, status: 'SUCCEEDED' },
    });
    expect(payments).toHaveLength(2);
  });
  it('two events for the SAME purchase still grant only once', async () => {
    // The property the old anchor was quietly providing as a side effect of
    // being constant, and which #490's fix must not delete: a one-off plan now
    // anchors on the purchase, so two deliveries naming one session collide.
    // Distinct event ids, so the webhook-event dedupe upstream is not what is
    // being measured here.
    const sessionId = await openCheckout('pack');
    await complete(sessionId, 'pi_same_1');
    await complete(sessionId, 'pi_same_2');

    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
    const credits = await prisma.creditLedger.findMany({
      where: { applicationId, endUserId, delta: { gt: 0 } },
    });
    expect(credits).toHaveLength(1);
  });
});
