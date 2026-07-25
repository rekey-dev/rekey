/**
 * Razorpay module `translate` unit tests — fixture payloads in, normalized
 * DomainBillingEvents out. No DB writes: translate is pure mapping (the
 * appliers own persistence, pinned by razorpay-webhook.test.ts through the
 * pipeline). These fixtures pin the mapping itself: the 7-event coverage
 * (incl. the payment_link.paid one-time path), the checkoutSessionId
 * OR-matcher + requireLocalSubscription posture, the paid_count-driven
 * firstPeriod flag, the current_end period mirror, and the header-borne
 * event id.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { razorpayModule } from '../src/modules/billing/providers/modules/razorpay/index.js';
import type { RawWebhookReq, TranslateCtx } from '../src/modules/billing/providers/module-types.js';

const APP_ID = 'app_rzp';
const EVENT_ID = 'evt_rzp_hdr_1';

function ctx(): TranslateCtx & { log: { warn: ReturnType<typeof vi.fn> } } {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger & {
      warn: ReturnType<typeof vi.fn>;
    },
    applicationId: APP_ID,
    providerEventId: EVENT_ID,
  } as never;
}

const translate = razorpayModule.webhook.translate.bind(razorpayModule.webhook);

describe('razorpay module translate', () => {
  it('subscription.activated → checkout.completed carrying providerSubId + current_end', () => {
    const events = translate(
      {
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: 'sub_1', status: 'active', current_end: 1_893_456_000 } } },
      },
      ctx(),
    );
    expect(events).toMatchObject([
      {
        type: 'checkout.completed',
        providerEventId: EVENT_ID,
        applicationId: APP_ID,
        checkoutSessionId: 'sub_1',
        providerSubscriptionId: 'sub_1',
        currentPeriodEnd: new Date(1_893_456_000 * 1000),
      },
    ]);
  });

  it('subscription.authenticated maps like activated; no current_end leaves the period untouched', () => {
    const events = translate(
      { event: 'subscription.authenticated', payload: { subscription: { entity: { id: 'sub_2' } } } },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({ type: 'checkout.completed', checkoutSessionId: 'sub_2' });
    // undefined = the applier leaves currentPeriodEnd alone.
    expect('currentPeriodEnd' in (events![0] as object)).toBe(false);
  });

  it('subscription.charged → payment.succeeded with the OR-matcher + firstPeriod from paid_count', () => {
    const fire = (paidCount: number): unknown[] | null =>
      translate(
        {
          event: 'subscription.charged',
          payload: {
            subscription: { entity: { id: 'sub_c', paid_count: paidCount, current_end: 1_788_000_000 } },
            payment: { entity: { id: `pay_${paidCount}`, amount: 49900, currency: 'INR' } },
          },
        },
        ctx(),
      );
    expect(fire(1)?.[0]).toMatchObject({
      type: 'payment.succeeded',
      providerPaymentId: 'pay_1',
      providerSubscriptionId: 'sub_c',
      checkoutSessionId: 'sub_c',
      requireLocalSubscription: true,
      amount: 49900,
      currency: 'INR',
      firstPeriod: true,
      currentPeriodEnd: new Date(1_788_000_000 * 1000),
    });
    // 2nd+ charge is a renewal — provisions against the mirrored new period.
    expect(fire(2)?.[0]).toMatchObject({ firstPeriod: false });
  });

  it('subscription.charged defaults the currency to INR', () => {
    const events = translate(
      {
        event: 'subscription.charged',
        payload: {
          subscription: { entity: { id: 'sub_c2' } },
          payment: { entity: { id: 'pay_nc', amount: 100 } },
        },
      },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({ currency: 'INR', firstPeriod: true });
  });

  it('subscription.cancelled → canceled with canceledAt from created_at', () => {
    const events = translate(
      {
        event: 'subscription.cancelled',
        created_at: 1_893_456_000,
        payload: { subscription: { entity: { id: 'sub_x' } } },
      },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({
      type: 'subscription.canceled',
      status: 'CANCELED',
      providerSubscriptionId: 'sub_x',
      checkoutSessionId: 'sub_x',
      canceledAt: new Date(1_893_456_000 * 1000),
    });
  });

  it('subscription.completed → EXPIRED under the canceled lifecycle type (status stays authoritative)', () => {
    const events = translate(
      { event: 'subscription.completed', payload: { subscription: { entity: { id: 'sub_done' } } } },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({ type: 'subscription.canceled', status: 'EXPIRED' });
    // A natural end writes no cancellation timestamp.
    expect('canceledAt' in (events![0] as object)).toBe(false);
  });

  it('subscription.halted with a payment entity → payment.failed + a past_due status echo', () => {
    const events = translate(
      {
        event: 'subscription.halted',
        payload: {
          subscription: { entity: { id: 'sub_h' } },
          payment: { entity: { id: 'pay_h', amount: 49900, currency: 'INR' } },
        },
      },
      ctx(),
    );
    expect(events).toMatchObject([
      {
        type: 'payment.failed',
        providerPaymentId: 'pay_h',
        providerSubscriptionId: 'sub_h',
        checkoutSessionId: 'sub_h',
        requireLocalSubscription: true,
        amount: 49900,
      },
      { type: 'subscription.past_due', status: 'PAST_DUE', providerSubscriptionId: 'sub_h' },
    ]);
  });

  it('subscription.pending without a payment entity → status mirror only', () => {
    const events = translate(
      { event: 'subscription.pending', payload: { subscription: { entity: { id: 'sub_p' } } } },
      ctx(),
    );
    expect(events).toMatchObject([{ type: 'subscription.past_due', status: 'PAST_DUE' }]);
  });

  it('payment_link.paid → payment.succeeded matched by the link id, no provider subscription', () => {
    const events = translate(
      {
        event: 'payment_link.paid',
        payload: {
          payment_link: { entity: { id: 'plink_1' } },
          payment: { entity: { id: 'pay_link_1', amount: 19900, currency: 'INR' } },
        },
      },
      ctx(),
    );
    expect(events).toMatchObject([
      {
        type: 'payment.succeeded',
        providerPaymentId: 'pay_link_1',
        providerSubscriptionId: null,
        checkoutSessionId: 'plink_1',
        requireLocalSubscription: true,
        amount: 19900,
        firstPeriod: true,
      },
    ]);
  });

  it('missing entities → no events (cannot apply, never guess) + warning', () => {
    const c = ctx();
    expect(translate({ event: 'subscription.charged', payload: {} }, c)).toEqual([]);
    expect(c.log.warn).toHaveBeenCalled();
  });

  it('unhandled event types → null (ack + ignore upstream)', () => {
    expect(
      translate({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x' } } } }, ctx()),
    ).toBeNull();
  });

  it('extractEventId prefers the x-razorpay-event-id header, falls back deterministically', () => {
    const payload = { event: 'subscription.charged', created_at: 123 };
    const req = (headers: Record<string, string>): RawWebhookReq => ({
      rawBody: JSON.stringify(payload),
      headers,
      params: { provider: 'razorpay', slug: 'app' },
      payload,
    });
    expect(razorpayModule.webhook.extractEventId(payload, req({ 'x-razorpay-event-id': 'evt_h' }))).toBe(
      'evt_h',
    );
    const fallback = razorpayModule.webhook.extractEventId(payload, req({}));
    expect(fallback).toMatch(/^rzp_subscription\.charged_123_[0-9a-f]{24}$/);
    // Deterministic — the same body yields the same idempotency key.
    expect(razorpayModule.webhook.extractEventId(payload, req({}))).toBe(fallback);
  });

  it('extractEventType reads the Razorpay envelope', () => {
    expect(razorpayModule.webhook.extractEventType({ event: 'subscription.charged' })).toBe(
      'subscription.charged',
    );
    expect(razorpayModule.webhook.extractEventType({})).toBe('unknown');
  });
});
