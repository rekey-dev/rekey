/**
 * PayPal module `translate` unit tests — fixture payloads in, normalized
 * DomainBillingEvents out. No DB writes: translate is pure mapping (the
 * appliers own persistence, pinned by paypal-webhook.test.ts + dunning +
 * outbound-events through the pipeline). These fixtures pin the mapping
 * itself: the 7-event coverage, the custom_id cross-check, the Orders v2
 * capture path (checkout.approved), the major→minor amount conversion, and
 * the payment-derived period rotation ordered before the payment event.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { paypalModule } from '../src/modules/billing/providers/modules/paypal/index.js';
import type { TranslateCtx } from '../src/modules/billing/providers/module-types.js';

const APP_ID = 'app_pp';

function ctx(): TranslateCtx & { log: { warn: ReturnType<typeof vi.fn> } } {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger & {
      warn: ReturnType<typeof vi.fn>;
    },
    applicationId: APP_ID,
  } as never;
}

const translate = paypalModule.webhook.translate.bind(paypalModule.webhook);

describe('paypal module translate', () => {
  it('BILLING.SUBSCRIPTION.ACTIVATED → checkout.completed, un-pinned firstPeriod', () => {
    const events = translate(
      {
        id: 'WH-1',
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: { id: 'I-SUB', custom_id: `${APP_ID}:eu_1`, status: 'ACTIVE' },
      },
      ctx(),
    );
    expect(events).toMatchObject([
      {
        type: 'checkout.completed',
        providerEventId: 'WH-1',
        applicationId: APP_ID,
        checkoutSessionId: 'I-SUB',
        providerSubscriptionId: 'I-SUB',
        // Bespoke provision anchored currentPeriodEnd ?? 'initial', not the
        // pinned 'initial' — false preserves that on reactivations.
        firstPeriod: false,
      },
    ]);
  });

  it('ACTIVATED without custom_id trusts the URL scope', () => {
    const events = translate(
      { id: 'WH-2', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-SUB2' } },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({ type: 'checkout.completed', checkoutSessionId: 'I-SUB2' });
  });

  it('ACTIVATED with a mismatched custom_id app → no events (cross-check) + warning', () => {
    const c = ctx();
    const events = translate(
      {
        id: 'WH-3',
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: { id: 'I-SUB3', custom_id: 'someone_else:eu_9' },
      },
      c,
    );
    expect(events).toEqual([]);
    expect(c.log.warn).toHaveBeenCalled();
  });

  it('CANCELLED and EXPIRED → canceled with canceledAt = now', () => {
    const before = Date.now();
    for (const type of ['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED']) {
      const events = translate({ id: 'WH-4', event_type: type, resource: { id: 'I-END' } }, ctx());
      const ev = events?.[0] as { canceledAt?: Date };
      expect(ev).toMatchObject({
        type: 'subscription.canceled',
        status: 'CANCELED',
        providerSubscriptionId: 'I-END',
      });
      expect(ev.canceledAt!.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it('SUSPENDED → past_due (dunning state, not a hard cancel)', () => {
    const events = translate(
      { id: 'WH-5', event_type: 'BILLING.SUBSCRIPTION.SUSPENDED', resource: { id: 'I-SUS' } },
      ctx(),
    );
    expect(events).toMatchObject([
      { type: 'subscription.past_due', status: 'PAST_DUE', providerSubscriptionId: 'I-SUS' },
    ]);
  });

  it('CHECKOUT.ORDER.APPROVED → checkout.approved naming the module for capture', () => {
    const events = translate(
      { id: 'WH-6', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER-1' } },
      ctx(),
    );
    expect(events).toMatchObject([
      { type: 'checkout.approved', checkoutSessionId: 'ORDER-1', provider: 'paypal' },
    ]);
  });

  it('PAYMENT.SALE.COMPLETED → period_advanced (gated on the sale id) BEFORE payment.succeeded', () => {
    const events = translate(
      {
        id: 'WH-7',
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: { id: 'SALE-1', billing_agreement_id: 'I-AGR', amount: { total: '9.99', currency: 'USD' } },
      },
      ctx(),
    );
    expect(events).toMatchObject([
      {
        type: 'subscription.period_advanced',
        providerSubscriptionId: 'I-AGR',
        providerPaymentId: 'SALE-1',
      },
      {
        type: 'payment.succeeded',
        providerPaymentId: 'SALE-1',
        providerSubscriptionId: 'I-AGR',
        amount: 999, // 9.99 → minor units
        currency: 'USD',
        firstPeriod: false,
      },
    ]);
  });

  it('SALE.COMPLETED without billing_agreement_id records the payment only (no rotation)', () => {
    const events = translate(
      {
        id: 'WH-8',
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: { id: 'SALE-2', amount: { value: '15.00', currency_code: 'EUR' } },
      },
      ctx(),
    );
    expect(events).toMatchObject([
      { type: 'payment.succeeded', providerPaymentId: 'SALE-2', providerSubscriptionId: null, amount: 1500, currency: 'EUR' },
    ]);
  });

  it('SALE.COMPLETED with an unusable amount → no events (nothing recorded) + warning', () => {
    const c = ctx();
    expect(
      translate(
        {
          id: 'WH-9',
          event_type: 'PAYMENT.SALE.COMPLETED',
          resource: { id: 'SALE-3', billing_agreement_id: 'I-AGR', amount: { total: 'not-a-number' } },
        },
        c,
      ),
    ).toEqual([]);
    expect(c.log.warn).toHaveBeenCalled();
    // Missing amount entirely is equally unusable.
    expect(
      translate(
        { id: 'WH-10', event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE-4' } },
        ctx(),
      ),
    ).toEqual([]);
  });

  it('SALE.DENIED / SALE.REVERSED → payment.failed, amount falling back to 0', () => {
    for (const type of ['PAYMENT.SALE.DENIED', 'PAYMENT.SALE.REVERSED']) {
      const events = translate(
        {
          id: 'WH-11',
          event_type: type,
          resource: { id: 'SALE-D', billing_agreement_id: 'I-AGR', amount: { total: '9.99', currency: 'USD' } },
        },
        ctx(),
      );
      expect(events).toMatchObject([
        { type: 'payment.failed', providerPaymentId: 'SALE-D', providerSubscriptionId: 'I-AGR', amount: 999 },
      ]);
    }
    const noAmount = translate(
      { id: 'WH-12', event_type: 'PAYMENT.SALE.DENIED', resource: { id: 'SALE-E' } },
      ctx(),
    );
    expect(noAmount?.[0]).toMatchObject({ amount: 0, currency: 'USD' });
  });

  it('unhandled event types → null (ack + ignore upstream)', () => {
    expect(
      translate({ id: 'WH-13', event_type: 'BILLING.SUBSCRIPTION.RE-ACTIVATED', resource: { id: 'I-X' } }, ctx()),
    ).toBeNull();
  });

  describe('PAYMENT.CAPTURE.COMPLETED — the money leg of a one-time order', () => {
    // Registered with PayPal from the start and never handled, so it fell to
    // `default: null` and a captured one-off purchase produced no Payment row.
    it('records the capture against the ORDER, not the capture id', () => {
      const events = translate(
        {
          id: 'WH-CAP',
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: {
            id: 'CAP-1',
            custom_id: `${APP_ID}:eu_1`,
            amount: { value: '49.99', currency_code: 'EUR' },
            supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
          },
        },
        ctx(),
      );
      expect(events).toMatchObject([
        {
          type: 'payment.succeeded',
          providerPaymentId: 'CAP-1',
          // The local row is keyed by the order id, which is what checkout
          // stored; the capture id has never been seen before.
          checkoutSessionId: 'ORDER-1',
          // A capture is never a recurring charge — that is PAYMENT.SALE.*.
          providerSubscriptionId: null,
          amount: 4999,
          currency: 'EUR',
          firstPeriod: true,
        },
      ]);
    });

    it('drops a capture whose custom_id names another application', () => {
      expect(
        translate(
          {
            id: 'WH-CAP-X',
            event_type: 'PAYMENT.CAPTURE.COMPLETED',
            resource: { id: 'CAP-2', custom_id: 'app_other:eu_1', amount: { value: '1.00' } },
          },
          ctx(),
        ),
      ).toEqual([]);
    });

    it('drops a capture with no usable amount rather than writing a zero payment', () => {
      expect(
        translate(
          { id: 'WH-CAP-Y', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-3' } },
          ctx(),
        ),
      ).toEqual([]);
    });
  });

  it('extractEventId / extractEventType read the PayPal envelope', () => {
    const payload = { id: 'WH-ENV', event_type: 'PAYMENT.SALE.COMPLETED' };
    expect(paypalModule.webhook.extractEventId(payload)).toBe('WH-ENV');
    expect(paypalModule.webhook.extractEventType(payload)).toBe('PAYMENT.SALE.COMPLETED');
  });
});
