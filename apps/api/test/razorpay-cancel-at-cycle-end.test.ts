/**
 * Razorpay's `cancel_at_cycle_end` was inverted.
 *
 * `RealRazorpayProvider.cancelSubscription` passed `!input.atPeriodEnd` as
 * razorpay-node's second argument, which is `cancelAtCycleEnd` and becomes
 * `cancel_at_cycle_end: 1` when truthy
 * (razorpay@2.9.6 `dist/resources/subscriptions.js`). The two negations read
 * plausibly next to each other and meant the exact opposite of the request:
 *
 *   atPeriodEnd: true   → cancel_at_cycle_end absent → Razorpay cancels NOW
 *   atPeriodEnd: false  → cancel_at_cycle_end: 1     → Razorpay cancels LATER
 *
 * The first is PR #336's defect at a different provider, and worse in one
 * respect: `cancelCurrentSubscription` takes the period-end branch, so the
 * local row stays ACTIVE with a future `cancelAt` while Razorpay has already
 * terminated the subscription. The portal shows the buyer time they no longer
 * have, and no charge will ever arrive to correct it.
 *
 * Nothing could catch it. The provider fake in `test/fakes/billing-providers.ts`
 * records that `cancelSubscription` was called and has no opinion about what
 * the argument means to Razorpay, and the sandbox harness that WOULD catch it
 * (`test-providers/razorpay-sandbox.test.ts`) only runs with credentials. This
 * test asserts the wire argument directly so the inversion cannot come back on
 * a machine with no keys.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Subscription } from '@prisma/client';
import { RealRazorpayProvider } from '../src/modules/billing/providers/razorpay.js';

/** Reach the SDK client the provider built, to see what it was handed. */
function spyOnCancel(provider: RealRazorpayProvider): ReturnType<typeof vi.fn> {
  const cancel = vi.fn(async () => ({ id: 'sub_x', status: 'cancelled' }));
  const internals = provider as unknown as {
    client: { subscriptions: { cancel: unknown } };
  };
  internals.client.subscriptions.cancel = cancel;
  return cancel;
}

function subscriptionRow(providerSubId: string | null): Subscription {
  return { id: 'local-1', providerSubId } as Subscription;
}

describe('Razorpay cancellation maps atPeriodEnd onto cancel_at_cycle_end', () => {
  // Fake, and never dialled: every call the provider would make is replaced by
  // the spy below before `cancelSubscription` runs.
  const creds = {
    keyId: 'rzp_test_ci_only',
    keySecret: 'secret_ci_only',
    webhookSecret: 'whsec_ci_only',
  };

  it('at period end asks Razorpay to cancel at the CYCLE end', async () => {
    const provider = new RealRazorpayProvider(creds);
    const cancel = spyOnCancel(provider);

    await provider.cancelSubscription({
      subscription: subscriptionRow('sub_abc'),
      atPeriodEnd: true,
    });

    expect(cancel).toHaveBeenCalledWith('sub_abc', true);
  });

  it('immediate cancellation does NOT set cancel_at_cycle_end', async () => {
    const provider = new RealRazorpayProvider(creds);
    const cancel = spyOnCancel(provider);

    await provider.cancelSubscription({
      subscription: subscriptionRow('sub_abc'),
      atPeriodEnd: false,
    });

    expect(cancel).toHaveBeenCalledWith('sub_abc', false);
  });

  it('defaults to period end when the caller says nothing', async () => {
    // `CancelSubscriptionInput.atPeriodEnd` is optional and documented as
    // "default = at period end". Every other provider honours that; this one
    // has to as well.
    const provider = new RealRazorpayProvider(creds);
    const cancel = spyOnCancel(provider);

    await provider.cancelSubscription({ subscription: subscriptionRow('sub_abc') });

    expect(cancel).toHaveBeenCalledWith('sub_abc', true);
  });

  it('does nothing for a local row that never reached Razorpay', async () => {
    const provider = new RealRazorpayProvider(creds);
    const cancel = spyOnCancel(provider);

    await provider.cancelSubscription({ subscription: subscriptionRow(null), atPeriodEnd: true });

    expect(cancel).not.toHaveBeenCalled();
  });
});
