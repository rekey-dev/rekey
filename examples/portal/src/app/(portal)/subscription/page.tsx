/**
 * Subscription overview — current plan, status, period end, included
 * entitlements (billing.getEntitlements), and the cancel control.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { relipay } from '@/lib/relipay';
import { cancelSubscriptionAction } from '@/lib/actions';
import { planForSubscription, formatAmount, formatDate } from '@/lib/portal';
import { StatusBadge } from '@/components/status-badge';
import { Banner } from '@/components/banner';

const INTERVAL_LABEL: Record<string, string> = { MONTH: 'month', YEAR: 'year' };

export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; canceled?: string; error?: string }>;
}): Promise<ReactNode> {
  const session = await requireSession();
  const params = await searchParams;
  const [subscription, plans, entitlements] = await Promise.all([
    relipay.billing.getSubscription(session.accessToken),
    relipay.billing.getPlans(),
    relipay.billing.getEntitlements(session.accessToken),
  ]);
  const plan = planForSubscription(plans, subscription);
  const cancelScheduled = Boolean(
    subscription && subscription.status === 'ACTIVE' && subscription.cancelAt,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Subscription</h1>

      {params.checkout === 'success' && (
        <Banner tone="success">
          Payment received — your subscription activates as soon as the provider confirms it
          (usually within a minute).
        </Banner>
      )}
      {params.canceled && <Banner tone="success">Your subscription has been canceled.</Banner>}
      {params.error && <Banner tone="error">Something went wrong ({params.error}).</Banner>}

      {!subscription ? (
        <section className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <p className="text-sm text-[var(--color-muted-fg)]">You have no active subscription.</p>
          <Link
            href="/plans"
            className="inline-block rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
          >
            Browse plans
          </Link>
        </section>
      ) : (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] p-5">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold">{plan?.name ?? 'Current plan'}</h2>
                <StatusBadge status={subscription.status} />
              </div>
              {plan && (
                <p className="text-sm text-[var(--color-muted-fg)]">
                  {formatAmount(plan.amount, plan.currency)}
                  {plan.kind === 'SUBSCRIPTION' && ` / ${INTERVAL_LABEL[plan.interval] ?? plan.interval.toLowerCase()}`}
                </p>
              )}
            </div>
            <Link href="/plans" className="text-sm font-medium underline underline-offset-2">
              Change plan
            </Link>
          </div>
          <dl className="grid grid-cols-1 gap-4 p-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[var(--color-muted-fg)]">Current period ends</dt>
              <dd className="font-medium">{formatDate(subscription.currentPeriodEnd)}</dd>
            </div>
            {cancelScheduled && (
              <div>
                <dt className="text-[var(--color-muted-fg)]">Cancels on</dt>
                <dd className="font-medium text-red-700">{formatDate(subscription.cancelAt)}</dd>
              </div>
            )}
            {subscription.canceledAt && (
              <div>
                <dt className="text-[var(--color-muted-fg)]">Canceled on</dt>
                <dd className="font-medium">{formatDate(subscription.canceledAt)}</dd>
              </div>
            )}
          </dl>
          {!cancelScheduled && subscription.status !== 'CANCELED' && (
            <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border)] p-5">
              <p className="text-sm text-[var(--color-muted-fg)]">
                Canceling keeps your plan until the end of the paid period.
              </p>
              <form action={cancelSubscriptionAction}>
                <button
                  type="submit"
                  className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                >
                  Cancel subscription
                </button>
              </form>
            </div>
          )}
        </section>
      )}

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <h2 className="border-b border-[var(--color-border)] p-5 text-base font-semibold">
          What&apos;s included
        </h2>
        {entitlements.entitlements.length === 0 && entitlements.creditBalance === 0 ? (
          <p className="p-5 text-sm text-[var(--color-muted-fg)]">
            No entitlements yet — they appear when a subscription is active.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] text-sm">
            {entitlements.creditBalance > 0 && (
              <li className="flex items-center justify-between p-4">
                <span>Credit balance</span>
                <span className="font-medium">{entitlements.creditBalance}</span>
              </li>
            )}
            {entitlements.entitlements.map((e, i) => (
              <li key={`${e.kind}:${e.key}:${i}`} className="flex items-center justify-between p-4">
                <span>
                  {e.key || e.kind.toLowerCase()}
                  <span className="ml-2 text-xs uppercase text-[var(--color-faint-fg)]">{e.kind}</span>
                </span>
                <span className="font-medium">
                  {e.quantity !== null ? e.quantity : e.value ?? 'included'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
