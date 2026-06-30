import * as React from 'react';
import Link from 'next/link';
import { getWorkspaceContext } from '@/lib/session';
import { relipay } from '@/lib/relipay';
import { AppShell } from '@/components/app-shell';
import { METER_QR_SCANS } from '@/lib/constants';

/** Start of the current calendar month (UTC) — matches ReliPay's quota window. */
function monthStartUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const ctx = await getWorkspaceContext();
  const { session, entitlements, activeOrgId, orgGateBlocking } = ctx;

  // Usage this month for the resolved subject (org pool or personal).
  let scansThisMonth: number | null = null;
  if (!orgGateBlocking) {
    try {
      const agg = await relipay.usage.aggregate({
        meterSlug: METER_QR_SCANS,
        from: monthStartUtc(),
        ...(activeOrgId ? { organizationId: activeOrgId } : { endUserId: session.user.id }),
      });
      scansThisMonth = agg.total;
    } catch {
      scansThisMonth = null;
    }
  }

  return (
    <AppShell
      active="dashboard"
      email={session.user.email}
      workspaceLabel={ctx.workspaceLabel}
      planLabel={ctx.planLabel}
      isPro={entitlements.isPro}
    >
      {orgGateBlocking && (
        <div className="card border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40">
          <h3 className="font-semibold">Create a team to get started</h3>
          <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
            This application bills per team — features and billing belong to a team, not an
            individual. Create or switch to a team to unlock the dashboard.
          </p>
          <Link href="/team" className="btn mt-3">Go to Team</Link>
        </div>
      )}

      <section>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-neutral-500">
          Everything here is gated on entitlements resolved server-side from ReliPay.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <div className="text-xs text-neutral-500">Plan tier</div>
          <div className="mt-1 text-2xl font-bold">{entitlements.isPro ? 'Pro' : 'Free'}</div>
        </div>
        <div className="card">
          <div className="text-xs text-neutral-500">Max QR codes</div>
          <div className="mt-1 text-2xl font-bold">{orgGateBlocking ? '—' : entitlements.maxQrs}</div>
        </div>
        <div className="card">
          <div className="text-xs text-neutral-500">Scans this month</div>
          <div className="mt-1 text-2xl font-bold">
            {orgGateBlocking ? '—' : scansThisMonth ?? '0'}
          </div>
        </div>
      </div>

      {/* Entitlement-gated feature: analytics is Pro-only. */}
      <section className="card">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Scan analytics</h3>
          <span className={`pill ${entitlements.analytics ? 'pill-pro' : ''}`}>
            {entitlements.analytics ? 'unlocked' : 'Pro feature'}
          </span>
        </div>
        {entitlements.analytics ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Analytics is unlocked on your plan. Scan totals for this workspace:{' '}
            <strong>{scansThisMonth ?? 0}</strong> this month.
          </p>
        ) : (
          <div className="mt-2">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Upgrade to Pro to unlock per-QR scan analytics.
            </p>
            <Link href="/billing" className="btn mt-3">See plans</Link>
          </div>
        )}
      </section>

      <section className="card">
        <h3 className="font-semibold">Resolved entitlements (raw)</h3>
        <p className="text-xs text-neutral-500">
          Straight from <code>relipay.billing.getEntitlements()</code> for the active subject.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-neutral-100 dark:bg-neutral-950 p-3 text-xs">
          {JSON.stringify(entitlements.features, null, 2)}
        </pre>
      </section>
    </AppShell>
  );
}
