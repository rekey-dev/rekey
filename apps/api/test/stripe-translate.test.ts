/**
 * Stripe module `translate` unit tests, fixture payloads in, normalized
 * DomainBillingEvents out. No DB writes: translate is pure mapping (the
 * appliers own persistence, pinned by stripe-webhook.test.ts through the
 * pipeline). These fixtures pin the mapping itself: event-type coverage,
 * the status map (incl. the EXPIRED/PENDING bucketing where `status` stays
 * authoritative), metadata scoping, and the first-period flag.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import type { TranslateCtx } from '../src/modules/billing/providers/module-types.js';

const lookup = vi.hoisted(() => ({
  keys: [] as string[],
  list: vi.fn(),
}));

vi.mock('../src/modules/billing/providers/stripe-client.js', () => ({
  createStripeClient: (apiKey: string) => {
    lookup.keys.push(apiKey);
    return { invoicePayments: { list: lookup.list } };
  },
}));

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
  it('checkout.session.completed → checkout.completed with session + provider sub id', async () => {
    const events = await translate(
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

  it('checkout.session.completed with an expanded subscription object uses its id', async () => {
    const events = await translate(
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

  it('missing applicationId metadata → no events (cannot route, never guess) + warning', async () => {
    const c = ctx();
    const events = await translate(
      { id: 'evt_3', type: 'checkout.session.completed', data: { object: { id: 'cs_3', metadata: {} } } },
      c,
    );
    expect(events).toEqual([]);
    expect(c.log.warn).toHaveBeenCalled();
  });

  it('customer.subscription.updated maps statuses; EXPIRED/PENDING keep authoritative status under a bucketed type', async () => {
    const fire = async (status: string): Promise<unknown[] | null> =>
      translate(
        {
          id: `evt_${status}`,
          type: 'customer.subscription.updated',
          data: { object: { id: 'sub_x', status, metadata: { applicationId: APP_ID } } },
        },
        ctx(),
      );
    expect((await fire('active'))?.[0]).toMatchObject({ type: 'subscription.activated', status: 'ACTIVE' });
    // `trialing` used to fold into ACTIVE, which entitled correctly and made a
    // trial indistinguishable from a paid subscription. It carries its own
    // status now; the event type stays `activated` because a trial starting IS
    // the subscriber gaining access, which is what consumers provision on.
    expect((await fire('trialing'))?.[0]).toMatchObject({
      type: 'subscription.activated',
      status: 'TRIALING',
    });
    expect((await fire('past_due'))?.[0]).toMatchObject({ type: 'subscription.past_due', status: 'PAST_DUE' });
    expect((await fire('unpaid'))?.[0]).toMatchObject({ type: 'subscription.past_due', status: 'PAST_DUE' });
    expect((await fire('canceled'))?.[0]).toMatchObject({ type: 'subscription.canceled', status: 'CANCELED' });
    // No first-class domain event exists for these local statuses, the
    // absolute status mirror must still happen, so `status` rides the
    // nearest lifecycle type and stays authoritative for the applier.
    expect((await fire('incomplete'))?.[0]).toMatchObject({ type: 'subscription.canceled', status: 'EXPIRED' });
    expect((await fire('paused'))?.[0]).toMatchObject({ type: 'subscription.past_due', status: 'PENDING' });
  });

  it('customer.subscription.updated mirrors period fields absolutely (null clears)', async () => {
    const events = await translate(
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

  it('customer.subscription.deleted → canceled, canceledAt falls back to now, period fields untouched', async () => {
    const before = Date.now();
    const events = await translate(
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

  it('invoice.paid and invoice.payment_succeeded → payment.succeeded; firstPeriod from billing_reason', async () => {
    for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
      const events = await translate(
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
    const renewal = await translate(
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

  it('invoice.payment_failed → payment.failed carrying amount_due', async () => {
    const events = await translate(
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

  it('unhandled event types → null (ack + ignore upstream)', async () => {
    expect(
      await translate(
        { id: 'evt_tax', type: 'customer.tax_id.created', data: { object: { id: 'txi_1' } } },
        ctx(),
      ),
    ).toBeNull();
  });

  // From 2025-03-31.basil the period end lives on the subscription's items.
  // An endpoint registered without a pinned version delivers in the account's
  // default, so both shapes reach this translator.
  it('customer.subscription.updated reads the period end off the first item (basil shape)', async () => {
    const events = await translate(
      {
        id: 'evt_basil',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_b',
            status: 'active',
            items: { data: [{ id: 'si_1', current_period_end: 1_795_000_000 }] },
            metadata: { applicationId: APP_ID },
          },
        },
      },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({ currentPeriodEnd: new Date(1_795_000_000 * 1000) });
  });

  // No genuine payload carries both; if one did, the item is where basil and
  // later keep the period, and the subscription-level field is the legacy one.
  it('customer.subscription.updated prefers the item period end when both exist', async () => {
    const events = await translate(
      {
        id: 'evt_both',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_both',
            status: 'active',
            current_period_end: 1_790_000_000,
            items: { data: [{ id: 'si_1', current_period_end: 1_795_000_000 }] },
            metadata: { applicationId: APP_ID },
          },
        },
      },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({ currentPeriodEnd: new Date(1_795_000_000 * 1000) });
  });

  it('invoice.paid reads the subscription id from parent.subscription_details (basil shape)', async () => {
    const events = await translate(
      {
        id: 'evt_inv_basil',
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_b',
            amount_paid: 1000,
            currency: 'usd',
            billing_reason: 'subscription_cycle',
            parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_b' } },
            metadata: { applicationId: APP_ID },
          },
        },
      },
      ctx(),
    );
    expect(events?.[0]).toMatchObject({ type: 'payment.succeeded', providerSubscriptionId: 'sub_b' });
  });

  it('checkout.session.completed with payment_status unpaid activates nothing', async () => {
    const c = ctx();
    const events = await translate(
      {
        id: 'evt_unpaid',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_unpaid',
            mode: 'payment',
            payment_status: 'unpaid',
            metadata: { applicationId: APP_ID },
          },
        },
      },
      c,
    );
    expect(events).toEqual([]);
  });

  it('checkout.session.async_payment_succeeded completes the session, with its charge', async () => {
    const events = await translate(
      {
        id: 'evt_async',
        type: 'checkout.session.async_payment_succeeded',
        data: {
          object: {
            id: 'cs_async',
            mode: 'payment',
            payment_status: 'paid',
            payment_intent: 'pi_async',
            amount_total: 4200,
            currency: 'eur',
            metadata: { applicationId: APP_ID },
          },
        },
      },
      ctx(),
    );
    expect(events).toMatchObject([
      {
        type: 'checkout.completed',
        providerEventId: 'evt_async',
        checkoutSessionId: 'cs_async',
        payment: { providerPaymentId: 'pi_async', amount: 4200, currency: 'eur' },
      },
    ]);
  });

  it('extractEventId / extractEventType read the Stripe envelope', async () => {
    const payload = { id: 'evt_env', type: 'invoice.paid' };
    expect(stripeModule.webhook.extractEventId(payload)).toBe('evt_env');
    expect(stripeModule.webhook.extractEventType(payload)).toBe('invoice.paid');
  });
});

/**
 * Endpoints registered by an older Rekey stay pinned to `2024-11-20.acacia`
 * until the operator re-registers them, and new ones deliver in
 * `STRIPE_API_VERSION`. Every field basil moved is read in both shapes.
 */
describe('stripe translate across the acacia to basil-or-later transition', () => {
  beforeEach(() => {
    lookup.keys.length = 0;
    lookup.list.mockReset();
  });

  const withCreds = (): TranslateCtx => ({ ...ctx(), credentials: { apiKey: 'sk_test_mode_key' } });

  function invoiceEvent(object: Record<string, unknown>, type = 'invoice.paid'): unknown {
    return {
      id: `evt_${type}_${String(object.id)}`,
      type,
      data: {
        object: {
          amount_paid: 1200,
          amount_due: 1200,
          currency: 'usd',
          billing_reason: 'subscription_cycle',
          ...object,
        },
      },
    };
  }

  function chargeRefunded(object: Record<string, unknown>): unknown {
    return {
      id: `evt_ch_${String(object.id)}`,
      type: 'charge.refunded',
      data: { object: { amount: 1200, amount_refunded: 400, currency: 'usd', metadata: {}, ...object } },
    };
  }

  describe('invoice routing when the invoice has no applicationId of its own', () => {
    it('basil: reads it from parent.subscription_details.metadata', async () => {
      const events = await translate(
        invoiceEvent({
          id: 'in_basil_route',
          metadata: {},
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_r', metadata: { applicationId: APP_ID } },
          },
        }),
        ctx(),
      );
      expect(events).toMatchObject([
        { type: 'payment.succeeded', applicationId: APP_ID, providerSubscriptionId: 'sub_r' },
      ]);
    });

    it('acacia: reads it from subscription_details.metadata', async () => {
      const events = await translate(
        invoiceEvent({
          id: 'in_acacia_route',
          subscription: 'sub_r',
          metadata: {},
          subscription_details: { metadata: { applicationId: APP_ID } },
        }),
        ctx(),
      );
      expect(events).toMatchObject([
        { type: 'payment.succeeded', applicationId: APP_ID, providerSubscriptionId: 'sub_r' },
      ]);
    });

    it("the invoice's own applicationId wins over a conflicting snapshot", async () => {
      const events = await translate(
        invoiceEvent({
          id: 'in_own_wins',
          metadata: { applicationId: APP_ID },
          parent: { subscription_details: { subscription: 'sub_r', metadata: { applicationId: 'app_other' } } },
          subscription_details: { metadata: { applicationId: 'app_other_acacia' } },
        }),
        ctx(),
      );
      expect(events).toMatchObject([{ applicationId: APP_ID }]);
    });

    it('a non-string applicationId in the snapshot is no id at all', async () => {
      const c = ctx();
      const events = await translate(
        invoiceEvent({
          id: 'in_bad_route',
          metadata: {},
          parent: { subscription_details: { subscription: 'sub_r', metadata: { applicationId: ['x'] } } },
        }),
        c,
      );
      expect(events).toEqual([]);
      expect(c.log.warn).toHaveBeenCalled();
    });

    it('invoice.payment_failed routes and links the subscription in the basil shape', async () => {
      const events = await translate(
        invoiceEvent(
          {
            id: 'in_basil_fail',
            parent: {
              type: 'subscription_details',
              subscription_details: { subscription: { id: 'sub_expanded' }, metadata: { applicationId: APP_ID } },
            },
          },
          'invoice.payment_failed',
        ),
        ctx(),
      );
      expect(events).toMatchObject([
        { type: 'payment.failed', applicationId: APP_ID, providerSubscriptionId: 'sub_expanded', amount: 1200 },
      ]);
    });
  });

  describe('charge.refunded: which payment the refund belongs to', () => {
    it('acacia renewal: the charge names its invoice, no Stripe call', async () => {
      const events = await translate(
        chargeRefunded({ id: 'ch_a1', invoice: 'in_a1', payment_intent: 'pi_a1' }),
        withCreds(),
      );
      expect(events?.[0]).toMatchObject({ type: 'payment.refunded', providerPaymentId: 'in_a1', refundedTotal: 400 });
      expect(lookup.list).not.toHaveBeenCalled();
    });

    it('acacia renewal with an expanded invoice uses its id', async () => {
      const events = await translate(
        chargeRefunded({ id: 'ch_a2', invoice: { id: 'in_a2' }, payment_intent: 'pi_a2' }),
        withCreds(),
      );
      expect(events?.[0]).toMatchObject({ providerPaymentId: 'in_a2' });
    });

    it('acacia one-time: a null invoice means the payment intent, no Stripe call', async () => {
      const events = await translate(
        chargeRefunded({ id: 'ch_a3', invoice: null, payment_intent: 'pi_a3' }),
        withCreds(),
      );
      expect(events?.[0]).toMatchObject({ providerPaymentId: 'pi_a3' });
      expect(lookup.list).not.toHaveBeenCalled();
    });

    it('basil renewal: asks Invoice Payments with the verifying credential and records against the invoice', async () => {
      lookup.list.mockResolvedValue({ data: [{ invoice: 'in_b1', status: 'paid' }] });
      const events = await translate(chargeRefunded({ id: 'ch_b1', payment_intent: 'pi_b1' }), withCreds());
      expect(events?.[0]).toMatchObject({ type: 'payment.refunded', providerPaymentId: 'in_b1', refundedTotal: 400 });
      expect(lookup.keys).toEqual(['sk_test_mode_key']);
      expect(lookup.list).toHaveBeenCalledWith({
        payment: { type: 'payment_intent', payment_intent: 'pi_b1' },
        limit: 10,
      });
    });

    it('basil one-time: no invoice behind the intent means the intent', async () => {
      lookup.list.mockResolvedValue({ data: [] });
      const events = await translate(chargeRefunded({ id: 'ch_b2', payment_intent: 'pi_b2' }), withCreds());
      expect(events?.[0]).toMatchObject({ providerPaymentId: 'pi_b2' });
    });

    it('basil: an intent that paid two invoices names neither', async () => {
      lookup.list.mockResolvedValue({ data: [{ invoice: 'in_x' }, { invoice: { id: 'in_y' } }] });
      const events = await translate(chargeRefunded({ id: 'ch_b3', payment_intent: 'pi_b3' }), withCreds());
      expect(events?.[0]).toMatchObject({ providerPaymentId: 'pi_b3' });
    });

    it('basil: a failed lookup throws so the pipeline answers 500 and Stripe retries', async () => {
      lookup.list.mockRejectedValue(new Error('Stripe is down'));
      await expect(
        translate(chargeRefunded({ id: 'ch_b4', payment_intent: 'pi_b4' }), withCreds()),
      ).rejects.toThrow('Stripe is down');
    });

    it('basil without credentials refuses to guess rather than record against the intent', async () => {
      await expect(translate(chargeRefunded({ id: 'ch_b5', payment_intent: 'pi_b5' }), ctx())).rejects.toThrow(
        /secret key/,
      );
      expect(lookup.list).not.toHaveBeenCalled();
    });

    it('basil one-time charge carrying our metadata uses its intent with no Stripe call, even without a key', async () => {
      const charge = { id: 'ch_b7', payment_intent: 'pi_b7', metadata: { applicationId: APP_ID } };
      for (const c of [withCreds(), ctx()]) {
        const events = await translate(chargeRefunded(charge), c);
        expect(events?.[0]).toMatchObject({ applicationId: APP_ID, providerPaymentId: 'pi_b7' });
      }
      expect(lookup.list).not.toHaveBeenCalled();
      expect(lookup.keys).toEqual([]);
    });

    it('basil charge with no payment intent is recorded under the charge', async () => {
      const events = await translate(chargeRefunded({ id: 'ch_b6', payment_intent: null }), withCreds());
      expect(events?.[0]).toMatchObject({ providerPaymentId: 'ch_b6' });
      expect(lookup.list).not.toHaveBeenCalled();
    });
  });
});
