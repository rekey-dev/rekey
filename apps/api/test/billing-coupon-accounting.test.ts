/**
 * A coupon must cost the operator exactly one redemption per discount, and a
 * sale must always leave a `Payment` row behind.
 *
 * Both halves were broken in opposite directions, and neither is visible from
 * the checkout response — the DTO reported the right discount throughout. Only
 * the rows written after the provider's webhook tell the truth, so that is
 * what these assert.
 *
 *   - **One-time purchases redeemed NOTHING.** Redemption lived solely in
 *     `applyPaymentSucceeded`, and neither Stripe (`mode: 'payment'` emits no
 *     invoice) nor PayPal (`PAYMENT.CAPTURE.COMPLETED` was registered but had
 *     no case) produces a payment event for a one-off. So a `maxRedemptions: 1`
 *     coupon discounted the first checkout, granted the credits, recorded no
 *     redemption — and then discounted the next one, and the next, forever. The
 *     same gap meant one-time revenue had no `Payment` row at all.
 *   - **Recurring purchases redeemed EVERY period.** The provider coupon is
 *     `duration: 'once'` and only ever cuts invoice #1, but every renewal
 *     invoice recorded another redemption. Worse, once a limit was reached the
 *     redemption threw from inside the payment transaction and rolled the
 *     renewal back: the provider had the money and Rekey had nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxPaypal, configureSandboxStripe } from './fakes/billing-credentials.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PASSWORD = 'pw-one-two-three';
/** Matches what `configureSandboxStripe` stores. */
const WEBHOOK_SECRET = 'whsec_ci_only';

/** Recurring plan price, in cents. */
const SUB_AMOUNT = 1000;
/** One-off credit pack price, in cents. */
const PACK_AMOUNT = 5000;

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

describe('coupon redemption is recorded once per purchase', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let appSlug: string;
  let liveKey: string;
  let operatorAccess: string;
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
    appSlug = `cacct-${Math.random().toString(36).slice(2, 8)}`;
    operatorAccess = await app
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
    await configureSandboxPaypal(applicationId);

    for (const plan of [
      { slug: 'pro', name: 'Pro', amount: SUB_AMOUNT },
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

  function checkout(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: {
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        ...payload,
      },
    });
  }

  /** The provider session id the checkout response reports. */
  async function checkoutSessionId(payload: Record<string, unknown>): Promise<string> {
    const res = await checkout(payload);
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

  function firePaypal(eventType: string, resource: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/paypal/${appSlug}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: `WH-${randomUUID()}`, event_type: eventType, resource }),
    });
  }

  const redemptions = () => prisma.couponRedemption.count({ where: { applicationId } });

  describe('one-time purchases (no invoice is ever emitted for them)', () => {
    it('consumes the single redemption a maxRedemptions:1 coupon has, and refuses the next buyer', async () => {
      await createCoupon({ code: 'onceonly', discountType: 'AMOUNT', amountOff: 1000, maxRedemptions: 1 });

      const sessionId = await checkoutSessionId({
        planSlug: 'pack',
        couponCode: 'onceonly',
        provider: 'stripe',
      });

      // Stripe's ONLY event for a `mode: 'payment'` session.
      const res = await fireStripe('checkout.session.completed', {
        id: sessionId,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_pack_1',
        amount_total: PACK_AMOUNT - 1000,
        currency: 'usd',
      });
      expect(res.statusCode).toBe(200);

      // Fulfilment happened...
      expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
      // ...so the coupon has been spent. This was 0.
      expect(await redemptions()).toBe(1);

      // ...and the same code cannot discount a second purchase.
      const second = await checkout({ planSlug: 'pack', couponCode: 'onceonly', provider: 'stripe' });
      expect(second.statusCode).toBe(400);
      expect(second.json().error.code).toBe('COUPON_REDEMPTION_LIMIT_REACHED');
    });

    it('records the charge as a SUCCEEDED Payment linked to the buyer', async () => {
      // One-time revenue previously appeared in no `Payment` row anywhere:
      // Stripe emits no invoice for `mode: 'payment'`, and the deployment's
      // webhook registration only ever subscribed invoice events.
      const sessionId = await checkoutSessionId({ planSlug: 'pack', provider: 'stripe' });

      await fireStripe('checkout.session.completed', {
        id: sessionId,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_pack_2',
        amount_total: PACK_AMOUNT,
        currency: 'usd',
      });

      const payment = await prisma.payment.findFirstOrThrow({
        where: { providerPaymentId: 'pi_pack_2' },
      });
      expect(payment).toMatchObject({
        status: 'SUCCEEDED',
        amount: PACK_AMOUNT,
        currency: 'USD',
        endUserId,
      });
      expect(payment.subscriptionId).not.toBeNull();
    });

    it('records what the buyer actually paid, not the list price', async () => {
      await createCoupon({ code: 'fifteen', discountType: 'AMOUNT', amountOff: 1500 });
      const sessionId = await checkoutSessionId({
        planSlug: 'pack',
        couponCode: 'fifteen',
        provider: 'stripe',
      });

      await fireStripe('checkout.session.completed', {
        id: sessionId,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_pack_3',
        amount_total: PACK_AMOUNT - 1500,
        currency: 'usd',
      });

      const payment = await prisma.payment.findFirstOrThrow({
        where: { providerPaymentId: 'pi_pack_3' },
      });
      expect(payment.amount).toBe(PACK_AMOUNT - 1500);
    });

    it('writes nothing for an unpaid session', async () => {
      // A delayed-notification method completes the session before the money
      // arrives. `checkout.session.async_payment_succeeded` is what says it
      // did, and we do not consume it — so record nothing rather than a
      // payment that may never settle.
      const sessionId = await checkoutSessionId({ planSlug: 'pack', provider: 'stripe' });

      await fireStripe('checkout.session.completed', {
        id: sessionId,
        mode: 'payment',
        payment_status: 'unpaid',
        payment_intent: 'pi_pack_unpaid',
        amount_total: PACK_AMOUNT,
        currency: 'usd',
      });

      expect(await prisma.payment.count({ where: { applicationId } })).toBe(0);
    });

    it('replaying the completion does not double the payment or the redemption', async () => {
      await createCoupon({ code: 'replayme', discountType: 'AMOUNT', amountOff: 500 });
      const sessionId = await checkoutSessionId({
        planSlug: 'pack',
        couponCode: 'replayme',
        provider: 'stripe',
      });
      const object = {
        id: sessionId,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_pack_replay',
        amount_total: PACK_AMOUNT - 500,
        currency: 'usd',
      };

      // A distinct provider event id each time, so the pipeline's durable
      // idempotency does not mask the appliers' own.
      await fireStripe('checkout.session.completed', object);
      await fireStripe('checkout.session.completed', object);

      expect(await prisma.payment.count({ where: { applicationId } })).toBe(1);
      expect(await redemptions()).toBe(1);
      expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
    });

    it('PayPal: the approval redeems and the capture records the payment — one redemption total', async () => {
      await createCoupon({ code: 'ppcoupon', discountType: 'AMOUNT', amountOff: 1000, maxRedemptions: 1 });
      const orderId = await checkoutSessionId({
        planSlug: 'pack',
        couponCode: 'ppcoupon',
        provider: 'paypal',
      });

      // Orders v2 does not auto-capture: the approval is what fulfils.
      expect((await firePaypal('CHECKOUT.ORDER.APPROVED', { id: orderId })).statusCode).toBe(200);
      expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
      expect(await redemptions()).toBe(1);

      // The money leg arrives separately, and used to fall through to
      // `default: return null` — registered with PayPal, handled nowhere.
      const capture = await firePaypal('PAYMENT.CAPTURE.COMPLETED', {
        id: 'CAP-pack-1',
        custom_id: `${applicationId}:${endUserId}`,
        amount: { value: '40.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { order_id: orderId } },
      });
      expect(capture.statusCode).toBe(200);

      const payment = await prisma.payment.findFirstOrThrow({
        where: { providerPaymentId: 'CAP-pack-1' },
      });
      expect(payment).toMatchObject({ status: 'SUCCEEDED', amount: 4000, endUserId });
      // The capture must not redeem a SECOND time — same purchase.
      expect(await redemptions()).toBe(1);
      // ...and must not grant a second pack of credits either.
      expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
    });
  });

  describe('recurring purchases', () => {
    /** Drive a coupon'd Stripe subscription to ACTIVE. Returns its provider sub id. */
    async function activateWithCoupon(code: string): Promise<string> {
      const sessionId = await checkoutSessionId({ planSlug: 'pro', couponCode: code, provider: 'stripe' });
      const providerSubId = `sub_${randomUUID().slice(0, 8)}`;
      await fireStripe('checkout.session.completed', {
        id: sessionId,
        mode: 'subscription',
        subscription: providerSubId,
      });
      return providerSubId;
    }

    function fireInvoice(providerSubId: string, invoiceId: string, billingReason: string) {
      return fireStripe('invoice.paid', {
        id: invoiceId,
        subscription: providerSubId,
        amount_paid: SUB_AMOUNT,
        currency: 'usd',
        billing_reason: billingReason,
      });
    }

    it('redeems once for the discounted invoice, and not again on renewal', async () => {
      await createCoupon({ code: 'firstmonth', discountType: 'PERCENT', amountOff: 5000 });
      const providerSubId = await activateWithCoupon('firstmonth');

      await fireInvoice(providerSubId, 'in_first', 'subscription_create');
      expect(await redemptions()).toBe(1);

      // The provider coupon was `duration: 'once'` — this invoice was charged
      // at full price, so it buys no redemption. It used to record one anyway,
      // and the operator's coupon stats multiplied one discount by the number
      // of periods the customer stayed.
      await fireInvoice(providerSubId, 'in_renewal_1', 'subscription_cycle');
      await fireInvoice(providerSubId, 'in_renewal_2', 'subscription_cycle');
      expect(await redemptions()).toBe(1);
      expect(await prisma.payment.count({ where: { applicationId, status: 'SUCCEEDED' } })).toBe(3);
    });

    it('renews cleanly under maxRedemptionsPerUser:1 — the configuration that used to 500', async () => {
      // The reproduced failure: `maxRedemptionsPerUser: 1` is a completely
      // normal configuration, the renewal redeemed a SECOND time, the limit
      // check threw from inside the payment transaction, and the whole renewal
      // rolled back — 500 to Stripe, money collected, no Payment row, no
      // status or period mirror, no entitlement re-provision, no dunning
      // recovery, and a poison event retried until the provider gave up.
      await createCoupon({
        code: 'peruser',
        discountType: 'PERCENT',
        amountOff: 2000,
        maxRedemptionsPerUser: 1,
      });
      const providerSubId = await activateWithCoupon('peruser');
      await fireInvoice(providerSubId, 'in_pu_first', 'subscription_create');

      const renewal = await fireInvoice(providerSubId, 'in_pu_renewal', 'subscription_cycle');

      expect(renewal.statusCode).toBe(200);
      expect(renewal.json()).toMatchObject({ processed: true });
      const payment = await prisma.payment.findFirstOrThrow({
        where: { providerPaymentId: 'in_pu_renewal' },
      });
      expect(payment.status).toBe('SUCCEEDED');
      expect(await prisma.subscription.findFirstOrThrow({ where: { providerSubId } })).toMatchObject({
        status: 'ACTIVE',
      });
      expect(await redemptions()).toBe(1);
      // The delivery was not merely swallowed — nothing failed at all.
      const events = await prisma.webhookEvent.findMany({ where: { applicationId } });
      expect(events.every((e) => e.processingError === null)).toBe(true);
    });

    it('a redemption that genuinely cannot be recorded never rolls back the money', async () => {
      // Same class of failure reached from the other side: the webhook that
      // would record the redemption finds the coupon exhausted. The purchase
      // still has to be recorded in full — an operator's coupon books being one
      // row short is not a reason to discard a charge the provider has already
      // taken.
      //
      // Reaching it takes a bit of setup now, and that is the point: a checkout
      // RESERVES its slot, so the ordinary "somebody else consumed the last
      // redemption while this buyer was paying" cannot happen any more. What is
      // still reachable is a sale with no reservation to confirm — one whose
      // reservation aged out, or a provider flow that never came through our
      // checkout — so the reservation is dropped here to model exactly that.
      await createCoupon({
        code: 'racey',
        discountType: 'PERCENT',
        amountOff: 2500,
        maxRedemptions: 1,
      });
      const sessionId = await checkoutSessionId({ planSlug: 'pro', couponCode: 'racey', provider: 'stripe' });
      const coupon = await prisma.coupon.findFirstOrThrow({ where: { applicationId, code: 'racey' } });
      await prisma.couponRedemption.deleteMany({ where: { couponId: coupon.id, status: 'RESERVED' } });
      // ...and somebody else's purchase took the only redemption there was.
      await prisma.couponRedemption.create({
        data: {
          couponId: coupon.id,
          applicationId,
          endUserId,
          checkoutSessionId: 'cs_someone_else',
          status: 'CONFIRMED',
        },
      });

      const activation = await fireStripe('checkout.session.completed', {
        id: sessionId,
        mode: 'subscription',
        subscription: 'sub_racey',
      });
      const invoice = await fireInvoice('sub_racey', 'in_racey', 'subscription_create');

      expect(activation.statusCode).toBe(200);
      expect(invoice.statusCode).toBe(200);
      expect(await prisma.subscription.findFirstOrThrow({ where: { providerSubId: 'sub_racey' } })).toMatchObject({
        status: 'ACTIVE',
      });
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { providerPaymentId: 'in_racey' } })).status,
      ).toBe('SUCCEEDED');
      // Still exactly the one that was there before — refused, not doubled.
      expect(await redemptions()).toBe(1);
    });

    it('records no payment for the subscription session itself (the invoice owns that)', async () => {
      // `mode: 'subscription'` money is `invoice.paid`'s to record. Reading it
      // off the session too would double-count it under a second provider id.
      const sessionId = await checkoutSessionId({ planSlug: 'pro', provider: 'stripe' });
      await fireStripe('checkout.session.completed', {
        id: sessionId,
        mode: 'subscription',
        subscription: 'sub_no_double',
        amount_total: SUB_AMOUNT,
        currency: 'usd',
        payment_status: 'paid',
        payment_intent: 'pi_should_be_ignored',
      });

      expect(await prisma.payment.count({ where: { applicationId } })).toBe(0);
    });
  });

  it('stamps the discount on the redemption so operator totals cannot be restated later', async () => {
    // The total used to be read back off `Subscription.metadata.discountAmount`
    // at display time — a value the buyer's NEXT checkout on the same plan
    // overwrites, so history changed under the operator.
    await createCoupon({ code: 'stamped', discountType: 'PERCENT', amountOff: 4000 });
    const sessionId = await checkoutSessionId({ planSlug: 'pack', couponCode: 'stamped', provider: 'stripe' });
    await fireStripe('checkout.session.completed', {
      id: sessionId,
      mode: 'payment',
      payment_status: 'paid',
      payment_intent: 'pi_stamped',
      amount_total: PACK_AMOUNT - 2000,
      currency: 'usd',
    });

    // A later, coupon-less checkout rewrites the subscription's metadata.
    await checkout({ planSlug: 'pack', provider: 'stripe' });

    const stats = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/coupons`,
      headers: { authorization: `Bearer ${operatorAccess}` },
    });
    const row = (
      stats.json().data as {
        items: Array<{
          code: string;
          totalDiscountIssued: number;
          redemptionCount: number;
        }>;
      }
    ).items.find((c) => c.code === 'stamped');
    expect(row).toMatchObject({ redemptionCount: 1, totalDiscountIssued: 2000 });
  });
});
