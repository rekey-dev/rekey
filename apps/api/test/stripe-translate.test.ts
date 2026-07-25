/**
 * Stripe module `translate` unit tests — fixture payloads in, normalized
 * DomainBillingEvents out. No DB writes: translate is pure mapping (the
 * appliers own persistence, pinned by stripe-webhook.test.ts through the
 * pipeline). These fixtures pin the mapping itself: event-type coverage,
 * the status map (incl. the EXPIRED/PENDING bucketing where `status` stays
 * authoritative), metadata scoping, and the first-period flag.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import type { TranslateCtx } from '../src/modules/billing/providers/module-types.js';

const APP_ID = 'app_1';

function ctx(): TranslateCtx & { log: { warn: ReturnType<typeof vi.fn> } } {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger & {
      warn: ReturnType<typeof vi.fn>;
    },
    applicationId: APP_ID,
  } as never;
}

const translate = stripeModule.webhook.translate.bind(stripeModule.webhook);

describe('stripe module translate', () => {
  it('checkout.session.completed → checkout.completed with session + provider sub id', () => {
    const events = translate(
      {
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_1', subscription: 'sub_1', metadata: { applicationId: APP_ID } } },
      },
      ctx(),
    );
    expect(events).toMatchObject([
      {
        type: 'checkout.completed',
        providerEventId: 'evt_1',
        applicationId: APP_ID,
        checkoutSessionId: 'cs_1',
        providerSubscriptionId: 'sub_1',
      },
    ]);
  });

  it('checkout.session.completed with an expanded subscription object uses its id', () => {
    const events = translate(
      {
        id: 'evt_2',
        type: 'checkout.session.completed',
        data: {
          object: { id: 'cs_2', subscription: { id: 'sub_2' }, metadata: { applicationId: APP_ID } },
        },
      },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({ providerSubscriptionId: 'sub_2' });
  });

  it('missing applicationId metadata → no events (cannot route, never guess) + warning', () => {
    const c = ctx();
    const events = translate(
      { id: 'evt_3', type: 'checkout.session.completed', data: { object: { id: 'cs_3', metadata: {} } } },
      c,
    );
    expect(events).toEqual([]);
    expect(c.log.warn).toHaveBeenCalled();
  });

  it('customer.subscription.updated maps statuses; EXPIRED/PENDING keep authoritative status under a bucketed type', () => {
    const fire = (status: string): unknown[] | null =>
      translate(
        {
          id: `evt_${status}`,
          type: 'customer.subscription.updated',
          data: { object: { id: 'sub_x', status, metadata: { applicationId: APP_ID } } },
        },
        ctx(),
      );
    expect(fire('active')?.[0]).toMatchObject({ type: 'subscription.activated', status: 'ACTIVE' });
    expect(fire('trialing')?.[0]).toMatchObject({ type: 'subscription.activated', status: 'ACTIVE' });
    expect(fire('past_due')?.[0]).toMatchObject({ type: 'subscription.past_due', status: 'PAST_DUE' });
    expect(fire('unpaid')?.[0]).toMatchObject({ type: 'subscription.past_due', status: 'PAST_DUE' });
    expect(fire('canceled')?.[0]).toMatchObject({ type: 'subscription.canceled', status: 'CANCELED' });
    // No first-class domain event exists for these local statuses — the
    // absolute status mirror must still happen, so `status` rides the
    // nearest lifecycle type and stays authoritative for the applier.
    expect(fire('incomplete')?.[0]).toMatchObject({ type: 'subscription.canceled', status: 'EXPIRED' });
    expect(fire('paused')?.[0]).toMatchObject({ type: 'subscription.past_due', status: 'PENDING' });
  });

  it('customer.subscription.updated mirrors period fields absolutely (null clears)', () => {
    const events = translate(
      {
        id: 'evt_periods',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_p',
            status: 'active',
            current_period_end: 1_790_000_000,
            metadata: { applicationId: APP_ID },
          },
        },
      },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({
      currentPeriodEnd: new Date(1_790_000_000 * 1000),
      cancelAt: null,
      canceledAt: null,
    });
  });

  it('customer.subscription.deleted → canceled, canceledAt falls back to now, period fields untouched', () => {
    const before = Date.now();
    const events = translate(
      {
        id: 'evt_del',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_d', status: 'canceled', metadata: { applicationId: APP_ID } } },
      },
      ctx(),
    );
    const ev = events?.[0] as { canceledAt?: Date; currentPeriodEnd?: unknown; cancelAt?: unknown };
    expect(ev).toMatchObject({ type: 'subscription.canceled', status: 'CANCELED' });
    expect(ev.canceledAt!.getTime()).toBeGreaterThanOrEqual(before);
    // undefined = the applier leaves these columns alone on delete.
    expect('currentPeriodEnd' in ev!).toBe(false);
    expect('cancelAt' in ev!).toBe(false);
  });

  it('invoice.paid and invoice.payment_succeeded → payment.succeeded; firstPeriod from billing_reason', () => {
    for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
      const events = translate(
        {
          id: 'evt_inv',
          type,
          data: {
            object: {
              id: 'in_1',
              subscription: 'sub_1',
              amount_paid: 999,
              currency: 'usd',
              billing_reason: 'subscription_create',
              metadata: { applicationId: APP_ID },
            },
          },
        },
        ctx(),
      );
      expect(events?.[0]).toMatchObject({
        type: 'payment.succeeded',
        providerPaymentId: 'in_1',
        providerSubscriptionId: 'sub_1',
        amount: 999,
        currency: 'usd',
        firstPeriod: true,
      });
    }
    const renewal = translate(
      {
        id: 'evt_inv2',
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_2',
            subscription: 'sub_1',
            amount_paid: 999,
            currency: 'usd',
            billing_reason: 'subscription_cycle',
            metadata: { applicationId: APP_ID },
          },
        },
      },
      ctx(),
    );
    expect(renewal?.[0]).toMatchObject({ firstPeriod: false });
  });

  it('invoice.payment_failed → payment.failed carrying amount_due', () => {
    const events = translate(
      {
        id: 'evt_fail',
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_f',
            subscription: 'sub_1',
            amount_due: 500,
            currency: 'eur',
            metadata: { applicationId: APP_ID },
          },
        },
      },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({
      type: 'payment.failed',
      providerPaymentId: 'in_f',
      amount: 500,
      currency: 'eur',
    });
  });

  it('unhandled event types → null (ack + ignore upstream)', () => {
    expect(
      translate(
        { id: 'evt_tax', type: 'customer.tax_id.created', data: { object: { id: 'txi_1' } } },
        ctx(),
      ),
    ).toBeNull();
  });

  it('extractEventId / extractEventType read the Stripe envelope', () => {
    const payload = { id: 'evt_env', type: 'invoice.paid' };
    expect(stripeModule.webhook.extractEventId(payload)).toBe('evt_env');
    expect(stripeModule.webhook.extractEventType(payload)).toBe('invoice.paid');
  });
});
