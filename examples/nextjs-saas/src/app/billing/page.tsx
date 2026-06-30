import * as React from 'react';
import Link from 'next/link';
import { getWorkspaceContext } from '@/lib/session';
import { relipay } from '@/lib/relipay';
import { AppShell } from '@/components/app-shell';
import { Banner } from '@/components/banner';
import { checkoutAction, buyCreditsAction } from '@/lib/actions';
import { PLAN_PRO } from '@/lib/constants';
import type { PlanDto, SubscriptionDto, CreditLedgerEntryDto } from '@relipay/node';

function priceLabel(p: PlanDto): string {
  if (p.amount === 0) return 'Free';
  const amt = `$${p.amount / 100}`;
  if (p.kind === 'SUBSCRIPTION') return `${amt}/${String(p.interval).toLowerCase()}`;
  if (p.kind === 'CREDIT' && p.creditsAmount) return amt;
  return amt;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const status =
    params.upgraded === '1'
      ? 'Payment approved — your plan is being provisioned via webhook. Refresh in a moment.'
      : params.bought === 'credits'
        ? 'Payment approved — credits are being added via webhook. Refresh in a moment.'
        : params['upgrade'] === 'cancel' || params['buy'] === 'cancel'
          ? 'Checkout cancelled.'
          : undefined;

  const ctx = await getWorkspaceContext();
  const { session, entitlements, activeOrgId, orgGateBlocking } = ctx;

  // Plans are public. Subscription + credit ledger are per-subject.
  const [plans, subscription, ledger] = await Promise.all([
    relipay.billing.getPlans().catch(() => [] as PlanDto[]),
    orgGateBlocking
      ? Promise.resolve(null)
      : relipay.billing.getSubscription(session.accessToken).catch(() => null as SubscriptionDto | null),
    orgGateBlocking
      ? Promise.resolve([] as CreditLedgerEntryDto[])
      : relipay.credits
          .listLedger(activeOrgId ? { organizationId: activeOrgId } : { endUserId: session.user.id }, 8)
          .catch(() => [] as CreditLedgerEntryDto[]),
  ]);

  return (
    <AppShell
      active="billing"
      email={session.user.email}
      workspaceLabel={ctx.workspaceLabel}
      planLabel={ctx.planLabel}
      isPro={entitlements.isPro}
    >
      <Banner error={error} status={status} />

      <section>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-sm text-neutral-500">
          {ctx.config.billingSubject === 'org'
            ? 'This application bills per team — checkout requires an active team.'
            : 'Manage your subscription and credits.'}
        </p>
      </section>

      {orgGateBlocking ? (
        <div className="card border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40">
          <h3 className="font-semibold">A team is required to manage billing</h3>
          <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
            Subscriptions and credits belong to a team on this application. Create or switch to a
            team, then come back to choose a plan.
          </p>
          <Link href="/team" className="btn mt-3">Go to Team</Link>
        </div>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-3">
            <div className="card">
              <div className="text-xs text-neutral-500">Current tier</div>
              <div className="mt-1 text-2xl font-bold">{entitlements.isPro ? 'Pro' : 'Free'}</div>
              {subscription && (
                <div className="mt-1 text-xs text-neutral-500">
                  subscription {subscription.status.toLowerCase()}
                </div>
              )}
            </div>
            <div className="card">
              <div className="text-xs text-neutral-500">Max QR codes</div>
              <div className="mt-1 text-2xl font-bold">{entitlements.maxQrs}</div>
            </div>
            <div className="card">
              <div className="text-xs text-neutral-500">Credit balance</div>
              <div className="mt-1 text-2xl font-bold">{entitlements.creditBalance}</div>
            </div>
          </section>

          <section className="card">
            <h3 className="font-semibold">Plans</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {plans.map((p) => {
                const isCurrentPro = p.slug === PLAN_PRO && entitlements.isPro;
                const isCurrentFree = p.slug === 'free' && !entitlements.isPro;
                const isCurrent = isCurrentPro || isCurrentFree;
                return (
                  <div key={p.id} className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
                    <div className="font-semibold">{p.name}</div>
                    <div className="mt-1 text-xl font-bold">{priceLabel(p)}</div>
                    <div className="mt-1 text-xs text-neutral-400">
                      {p.kind === 'CREDIT' && p.creditsAmount ? `${p.creditsAmount} credits` : p.kind}
                    </div>
                    <div className="mt-3">
                      {isCurrent ? (
                        <span className="pill pill-pro">Current</span>
                      ) : p.kind === 'CREDIT' ? (
                        <form action={buyCreditsAction}>
                          <button type="submit" className="btn w-full">Buy</button>
                        </form>
                      ) : p.amount === 0 ? (
                        <span className="pill">—</span>
                      ) : (
                        <form action={checkoutAction}>
                          <input type="hidden" name="planSlug" value={p.slug} />
                          <button type="submit" className="btn w-full">Choose</button>
                        </form>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Prepaid credits</h3>
              <span className="text-sm text-neutral-500">
                Balance: <strong>{entitlements.creditBalance}</strong>
              </span>
            </div>
            <form action={buyCreditsAction} className="mt-3">
              <button type="submit" className="btn">Buy 500 credits</button>
            </form>
            <div className="mt-4">
              {ledger.length === 0 ? (
                <p className="text-sm text-neutral-500">No credit activity yet.</p>
              ) : (
                <ul className="divide-y divide-neutral-200 dark:divide-neutral-800 text-sm">
                  {ledger.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 py-2">
                      <span className="font-mono">{e.delta > 0 ? '+' : ''}{e.delta}</span>
                      <span className="pill">{e.reason}</span>
                      <span className="ml-auto text-neutral-500">bal {e.balanceAfter}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}
    </AppShell>
  );
}
