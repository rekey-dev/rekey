/**
 * Trials.
 *
 * The failure this guards against is not a rendering bug: the pricing page
 * says "14 days free", the buyer clicks, and the provider charges them today.
 * That is a chargeback and a support ticket, and the buyer is right. So the
 * rule is the same fail-closed one coupons already use — a provider that has
 * not declared it can express a trial never receives one.
 */
import { describe, expect, it } from 'vitest';
import { resolveCheckoutTrial } from '../src/modules/billing/checkout-trial.js';
import { mapStripeSubStatus } from '../src/modules/billing/providers/modules/stripe/index.js';
import { RekeyError } from '../src/lib/error.js';
import type { Plan } from '@prisma/client';

const plan = (over: Partial<Plan> = {}): Plan =>
  ({
    id: 'p1',
    slug: 'pro',
    kind: 'SUBSCRIPTION',
    amount: 9900,
    trialDays: 14,
    ...over,
  }) as Plan;

describe('a provider must declare it can run a trial', () => {
  it('stripe can, and the days reach the checkout', () => {
    expect(resolveCheckoutTrial({ plan: plan(), provider: 'stripe', isOneTime: false })).toEqual({
      days: 14,
    });
  });

  it.each(['paypal', 'razorpay'])('%s cannot, so the checkout is refused, not charged', (p) => {
    // Neither declares `capabilities.trials`. Absent means cannot: silently
    // dropping the trial would charge the buyer today for something advertised
    // as free.
    expect(() => resolveCheckoutTrial({ plan: plan(), provider: p, isOneTime: false })).toThrow(
      RekeyError,
    );
  });

  it('an unknown provider is refused too — absent means cannot', () => {
    expect(() =>
      resolveCheckoutTrial({ plan: plan(), provider: 'some-third-party', isOneTime: false }),
    ).toThrow(/cannot start a subscription in a free trial/);
  });

  it('a plan with no trial is unaffected on every provider', () => {
    for (const p of ['stripe', 'paypal', 'razorpay']) {
      expect(resolveCheckoutTrial({ plan: plan({ trialDays: null }), provider: p, isOneTime: false })).toBeNull();
      expect(resolveCheckoutTrial({ plan: plan({ trialDays: 0 }), provider: p, isOneTime: false })).toBeNull();
    }
  });

  it('a one-off purchase with a trial is refused — there is nothing to convert into', () => {
    expect(() => resolveCheckoutTrial({ plan: plan(), provider: 'stripe', isOneTime: true })).toThrow(
      /nothing for a trial to convert into/,
    );
  });
});

describe('a trial is distinguishable from a paid subscription', () => {
  it('stripe `trialing` maps to TRIALING, not ACTIVE', () => {
    // It used to fold into ACTIVE, which entitled correctly and made "trial
    // ends in 4 days" and conversion reporting impossible to express.
    expect(mapStripeSubStatus('trialing')).toBe('TRIALING');
    expect(mapStripeSubStatus('active')).toBe('ACTIVE');
  });
});
