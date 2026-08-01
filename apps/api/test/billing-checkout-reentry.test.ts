/**
 * What happens when the same buyer opens checkout for the same plan twice.
 *
 * The local `Subscription` is upserted by (application, end-user, plan), so the
 * second checkout lands on the row the first one wrote. Two things went wrong
 * there, and both cost the customer something real:
 *
 *   - **The first session stopped being findable.** `metadata.checkoutSessionId`
 *     was overwritten, but a Stripe Checkout Session stays completable for
 *     about 24 hours and so does the ad-hoc coupon minted with it. A buyer who
 *     opened a second tab and then went back and paid on the first one matched
 *     no local row: the webhook answered 200, the subscription stayed PENDING,
 *     no `Payment` was written and no coupon was redeemed. They had paid.
 *   - **An ACTIVE subscriber was downgraded to PENDING** just for looking. The
 *     upsert set `status: 'PENDING'` unconditionally, and PENDING is not an
 *     entitling status — so pressing Upgrade, or typing a coupon into the form
 *     the account page shows existing subscribers, revoked entitlement on the
 *     spot without a single provider event having happened.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PASSWORD = 'pw-one-two-three';
const WEBHOOK_SECRET = 'whsec_ci_only';
const PACK_AMOUNT = 5000;

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

describe('re-opening checkout for a plan the buyer already has open', () => {
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
    appSlug = `reentry-${Math.random().toString(36).slice(2, 8)}`;
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
      { slug: 'pro', name: 'Pro', amount: 1000 },
      { slug: 'pack', name: 'Credit pack', amount: PACK_AMOUNT, kind: 'CREDIT', creditsAmount: 100 },
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

  async function createCoupon(payload: Record<string, unknown>): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
  }

  async function checkout(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: {
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        provider: 'stripe',
        ...payload,
      },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data as { subscription: { metadata: { checkoutSessionId: string } } })
      .subscription.metadata.checkoutSessionId;
  }

  function fireStripe(type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type,
      data: { object: { metadata: { applicationId }, ...object } },
    });
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${appSlug}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      },
      payload,
    });
  }

  describe('an older session is still completable', () => {
    it('activates, pays and provisions when the FIRST of two sessions completes', async () => {
      const first = await checkout({ planSlug: 'pack' });
      const second = await checkout({ planSlug: 'pack' });
      expect(second).not.toBe(first);

      const res = await fireStripe('checkout.session.completed', {
        id: first,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_old_session',
        amount_total: PACK_AMOUNT,
        currency: 'usd',
      });

      expect(res.statusCode).toBe(200);
      const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId } });
      expect(sub.status).toBe('ACTIVE');
      expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: 'pi_old_session' } })).amount,
      ).toBe(PACK_AMOUNT);
    });

    it("redeems the coupon that OLD session carried, not the newest one's", async () => {
      // Each session is minted with its own provider coupon, so completing an
      // old session spends the code that session was priced with. Reading the
      // row-level `couponId` would have redeemed whichever code was typed
      // most recently — or, worse, a code the completed checkout never used.
      await createCoupon({ code: 'oldcode', discountType: 'AMOUNT', amountOff: 1000 });
      await createCoupon({ code: 'newcode', discountType: 'AMOUNT', amountOff: 2000 });
      const oldCoupon = await prisma.coupon.findFirstOrThrow({ where: { applicationId, code: 'oldcode' } });

      const first = await checkout({ planSlug: 'pack', couponCode: 'oldcode' });
      await checkout({ planSlug: 'pack', couponCode: 'newcode' });

      await fireStripe('checkout.session.completed', {
        id: first,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_old_coupon',
        amount_total: PACK_AMOUNT - 1000,
        currency: 'usd',
      });

      const rows = await prisma.couponRedemption.findMany({ where: { applicationId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        couponId: oldCoupon.id,
        checkoutSessionId: first,
        discountAmount: 1000,
      });
    });

    it('drops a coupon from the row when the next checkout carries none', async () => {
      // The row-level mirror used to be sticky: a coupon-less second checkout
      // left the previous code's id on the subscription, so completing it
      // redeemed a code that purchase never used.
      await createCoupon({ code: 'sticky', discountType: 'AMOUNT', amountOff: 1000 });
      await checkout({ planSlug: 'pack', couponCode: 'sticky' });
      const plain = await checkout({ planSlug: 'pack' });

      await fireStripe('checkout.session.completed', {
        id: plain,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_plain',
        amount_total: PACK_AMOUNT,
        currency: 'usd',
      });

      expect(await prisma.couponRedemption.count({ where: { applicationId } })).toBe(0);
    });

    it('completing both sessions grants once and pays twice — one purchase per charge', async () => {
      // Not a hypothetical: the buyer can genuinely pay on both tabs. Each
      // charge is its own `Payment`; the credits are anchored per period so
      // the second completion re-provisions idempotently rather than doubling.
      const first = await checkout({ planSlug: 'pack' });
      const second = await checkout({ planSlug: 'pack' });

      for (const [session, intent] of [
        [first, 'pi_both_1'],
        [second, 'pi_both_2'],
      ] as const) {
        await fireStripe('checkout.session.completed', {
          id: session,
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: intent,
          amount_total: PACK_AMOUNT,
          currency: 'usd',
        });
      }

      expect(await prisma.payment.count({ where: { applicationId } })).toBe(2);
      expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
    });
  });

  describe('an already-paying subscription is not disturbed', () => {
    async function activate(): Promise<string> {
      const session = await checkout({ planSlug: 'pro' });
      await fireStripe('checkout.session.completed', {
        id: session,
        mode: 'subscription',
        subscription: 'sub_active_1',
      });
      const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId } });
      expect(sub.status).toBe('ACTIVE');
      return sub.id;
    }

    it('stays ACTIVE when the subscriber merely re-opens checkout', async () => {
      const subId = await activate();

      await checkout({ planSlug: 'pro' });

      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
      expect(after.status).toBe('ACTIVE');
      // The provider link is untouched too — this row is still the live
      // subscription, not a fresh checkout record.
      expect(after.providerSubId).toBe('sub_active_1');
    });

    it('stays ACTIVE when they try a coupon from the account page', async () => {
      // The exact flow the marketing account panel added: an Apply/Subscribe
      // form rendered in front of an EXISTING subscriber.
      await createCoupon({ code: 'tryme', discountType: 'PERCENT', amountOff: 1000 });
      const subId = await activate();

      await checkout({ planSlug: 'pro', couponCode: 'tryme' });

      expect(
        (await prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).status,
      ).toBe('ACTIVE');
    });

    it('keeps the subscription visible to the portal after re-opening checkout', async () => {
      // PENDING is not an entitling status, so the downgrade did not merely
      // look wrong — every entitlement gate started refusing.
      await activate();
      await checkout({ planSlug: 'pro' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/subscription',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().data as { status: string }).status).toBe('ACTIVE');
    });

    it('a PAST_DUE subscriber is not downgraded either — dunning still runs', async () => {
      const subId = await activate();
      await prisma.subscription.update({ where: { id: subId }, data: { status: 'PAST_DUE' } });

      await checkout({ planSlug: 'pro' });

      expect(
        (await prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).status,
      ).toBe('PAST_DUE');
    });

    it('a lapsed subscriber DOES go back to PENDING — that is a real new checkout', async () => {
      // The fix must not over-apply: a CANCELED row starting a fresh checkout
      // is exactly the case PENDING exists for.
      const subId = await activate();
      await prisma.subscription.update({ where: { id: subId }, data: { status: 'CANCELED' } });

      await checkout({ planSlug: 'pro' });

      expect(
        (await prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).status,
      ).toBe('PENDING');
    });
  });
});
