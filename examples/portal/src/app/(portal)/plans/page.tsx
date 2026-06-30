/**
 * Plans — the Application's public catalogue with checkout (new subscription
 * or plan change via the existing createCheckout flow; the provider handles
 * payment, activation lands via webhook).
 */

import type { ReactNode } from 'react';
import { requireSession } from '@/lib/session';
import { relipay } from '@/lib/relipay';
import { checkoutAction } from '@/lib/actions';
import { planForSubscription, formatAmount } from '@/lib/portal';
import { Banner } from '@/components/banner';

const INTERVAL_LABEL: Record<string, string> = { MONTH: 'month', YEAR: 'year' };

const ERROR_COPY: Record<string, string> = {
  BILLING_ORGANIZATION_REQUIRED:
    'This application bills per team — manage your plan from inside the main application.',
  BILLING_PROVIDER_SWITCH_BLOCKED:
    'You already have an active subscription on this plan with a different payment provider. Cancel it first.',
  'checkout-canceled': 'Checkout was canceled — no changes were made.',
};

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; checkout?: string }>;
}): Promise<ReactNode> {
  const session = await requireSession();
  const params = await searchParams;
  const [plans, subscription] = await Promise.all([
    relipay.billing.getPlans(),
    relipay.billing.getSubscription(session.accessToken),
  ]);
  const currentPlan = planForSubscription(plans, subscription);
  // The portal sells recurring plans; one-off CREDIT/LICENSE packs still
  // show so existing apps' catalogues stay complete.
  const visible = plans.filter((p) => p.active);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Plans</h1>

      {params.checkout === 'canceled' && (
        <Banner tone="info">{ERROR_COPY['checkout-canceled']}</Banner>
      )}
      {params.error && (
        <Banner tone="error">
          {ERROR_COPY[params.error] ?? `Could not start checkout (${params.error}).`}
        </Banner>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-fg)]">No plans are available right now.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {visible.map((plan) => {
            const isCurrent =
              currentPlan?.id === plan.id &&
              (subscription?.status === 'ACTIVE' || subscription?.status === 'PAST_DUE');
            return (
              <section
                key={plan.id}
                className="flex flex-col justify-between gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
              >
                <div className="space-y-1">
                  <h2 className="text-base font-semibold">{plan.name}</h2>
                  <p className="text-sm text-[var(--color-muted-fg)]">
                    {formatAmount(plan.amount, plan.currency)}
                    {plan.kind === 'SUBSCRIPTION' &&
                      ` / ${INTERVAL_LABEL[plan.interval] ?? plan.interval.toLowerCase()}`}
                    {plan.kind === 'CREDIT' &&
                      plan.creditsAmount !== null &&
                      ` · ${plan.creditsAmount} credits`}
                    {plan.kind === 'LICENSE' && ' · license'}
                  </p>
                </div>
                {isCurrent ? (
                  <span className="inline-block rounded-md border border-[var(--color-border)] px-3 py-2 text-center text-sm font-medium text-[var(--color-muted-fg)]">
                    Current plan
                  </span>
                ) : (
                  <form action={checkoutAction}>
                    <input type="hidden" name="planSlug" value={plan.slug} />
                    <button
                      type="submit"
                      className="w-full rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
                    >
                      {plan.kind === 'SUBSCRIPTION'
                        ? subscription
                          ? 'Switch to this plan'
                          : 'Subscribe'
                        : 'Buy'}
                    </button>
                  </form>
                )}
              </section>
            );
          })}
        </div>
      )}

      <p className="text-xs text-[var(--color-faint-fg)]">
        Checkout is handled by the payment provider on a secure hosted page. Plan changes take
        effect when the provider confirms payment.
      </p>
    </div>
  );
}
