/**
 * "Is this plan actually buyable?"
 *
 * The state under test is the one nothing else on the plan reveals: a plan
 * created BEFORE its Application had provider credentials was never registered,
 * has no price behind it, and stays that way, because connecting a provider
 * afterwards does not reach back and repair plans that already exist. It lists,
 * it is `active`, `registrationStatus` reads NOT_REQUIRED, and the first thing
 * that disagrees is a buyer clicking Buy and getting a 409.
 *
 * The two directions cost different things, and these tests pin both:
 *   - Missing the warning costs a checkout that would have been refused anyway.
 *   - A false warning sends an operator chasing a plan that was always fine,
 *     which is what would happen if PayPal and Razorpay plans were flagged for
 *     having no Stripe price. They register lazily at first checkout.
 */
import { describe, expect, it } from 'vitest';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import { paypalModule } from '../src/modules/billing/providers/modules/paypal/index.js';
import { razorpayModule } from '../src/modules/billing/providers/modules/razorpay/index.js';
import type { Plan } from '@prisma/client';

const plan = (over: Partial<Plan> = {}): Plan =>
  ({
    id: 'p1',
    applicationId: 'app1',
    slug: 'pro',
    kind: 'SUBSCRIPTION',
    amount: 2900,
    active: true,
    registrationStatus: 'REGISTERED',
    registrationError: null,
    metadata: { stripe: { priceId: 'price_123' } },
    ...over,
  }) as Plan;

describe('stripe reports a plan it cannot sell', () => {
  it('a registered plan has no blocker', () => {
    expect(stripeModule.planCheckoutBlocker?.(plan())).toBeNull();
  });

  it('a plan created before the credentials existed is named, with the repair', () => {
    // The exact shape of the row this whole feature exists for: creation looked
    // like it succeeded, so nothing is marked FAILED and nothing is PENDING.
    const blocker = stripeModule.planCheckoutBlocker?.(
      plan({ registrationStatus: 'NOT_REQUIRED', metadata: {} }),
    );
    expect(blocker?.code).toBe('PLAN_NOT_REGISTERED');
    expect(blocker?.fix).toContain('/plans/pro/register');
  });

  it("a refused plan carries the provider's own reason rather than a generic one", () => {
    const blocker = stripeModule.planCheckoutBlocker?.(
      plan({
        registrationStatus: 'FAILED',
        registrationError: 'Invalid API Key provided: sk_test_***',
        metadata: {},
      }),
    );
    expect(blocker?.code).toBe('PLAN_REGISTRATION_FAILED');
    expect(blocker?.message).toBe('Invalid API Key provided: sk_test_***');
  });

  it('FAILED wins over a stale stored price, because the row is the newer fact', () => {
    // A plan that registered once and was later refused still carries the old
    // priceId. Reading the price first would report it as healthy.
    const blocker = stripeModule.planCheckoutBlocker?.(
      plan({ registrationStatus: 'FAILED', registrationError: 'Price archived' }),
    );
    expect(blocker?.code).toBe('PLAN_REGISTRATION_FAILED');
  });
});

describe('a provider that registers lazily stays silent', () => {
  // Not an oversight, and the reason it must stay this way: PayPal and Razorpay
  // mint their plan on first checkout, so a plan with no stored id is perfectly
  // buyable through them. Declaring a blocker here would flag every plan on
  // every PayPal-only Application.
  it('paypal declares no blocker at all', () => {
    expect(paypalModule.planCheckoutBlocker).toBeUndefined();
  });

  it('razorpay declares no blocker at all', () => {
    expect(razorpayModule.planCheckoutBlocker).toBeUndefined();
  });
});
