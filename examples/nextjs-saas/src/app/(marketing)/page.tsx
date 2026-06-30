import * as React from 'react';
import Link from 'next/link';
import { getSession, getAppConfig } from '@/lib/session';
import { relipay } from '@/lib/relipay';
import type { PlanDto } from '@relipay/node';

/** Format a plan's price for the pricing grid. */
function priceLabel(p: PlanDto): string {
  if (p.amount === 0) return 'Free';
  const amt = `$${p.amount / 100}`;
  if (p.kind === 'SUBSCRIPTION') return `${amt}/${String(p.interval).toLowerCase()}`;
  if (p.kind === 'CREDIT' && p.creditsAmount) return `${amt} · ${p.creditsAmount} credits`;
  return amt;
}

export default async function LandingPage(): Promise<React.JSX.Element> {
  // Pricing is public — render straight from billing.getPlans(). App config
  // tells visitors whether billing is team-scoped.
  const [session, plans, config] = await Promise.all([
    getSession(),
    relipay.billing.getPlans().catch(() => [] as PlanDto[]),
    getAppConfig().catch(() => null),
  ]);
  const signedIn = session !== null;

  const features = [
    ['Auth, batteries included', 'Email/password, magic links, password reset, multi-session management — all from @relipay/nextjs + @relipay/react.'],
    ['Org-scoped billing', 'Subscriptions, plan catalog, hosted checkout and upgrade flows that belong to a team, not just one user.'],
    ['Entitlements & usage', 'Gate features server-side on resolved entitlements; meter usage and enforce hard caps.'],
    ['Prepaid credits', 'Sell credit packs and draw them down per unit, with a shared org pool.'],
  ];

  return (
    <div className="min-h-screen">
      <header className="mx-auto max-w-5xl px-6 py-5 flex items-center">
        <span className="font-bold text-relipay-700 dark:text-relipay-500">ReliPay SaaS</span>
        <nav className="ml-auto flex items-center gap-3">
          {signedIn ? (
            <Link href="/dashboard" className="btn">Open dashboard</Link>
          ) : (
            <>
              <Link href="/login" className="btn-ghost">Sign in</Link>
              <Link href="/signup" className="btn">Get started</Link>
            </>
          )}
        </nav>
      </header>

      <section className="mx-auto max-w-5xl px-6 pt-12 pb-16 text-center">
        <span className="pill">Next.js 15 · App Router · built on ReliPay</span>
        <h1 className="mt-5 text-4xl sm:text-5xl font-bold tracking-tight">
          The SaaS starter with auth &amp; billing already wired
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-neutral-600 dark:text-neutral-400">
          A complete, idiomatic Next.js example demonstrating the ReliPay SDK end to end —
          authentication, {config?.billingSubject === 'org' ? 'team-scoped ' : ''}billing,
          entitlement gating, usage metering, prepaid credits and organizations.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          {signedIn ? (
            <Link href="/dashboard" className="btn">Go to your dashboard</Link>
          ) : (
            <>
              <Link href="/signup" className="btn">Create your account</Link>
              <Link href="/login" className="btn-ghost">Sign in</Link>
            </>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="grid gap-4 sm:grid-cols-2">
          {features.map(([title, body]) => (
            <div key={title} className="card">
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {plans.length > 0 && (
        <section className="mx-auto max-w-5xl px-6 pb-20">
          <h2 className="text-2xl font-semibold text-center">Pricing</h2>
          {config?.billingSubject === 'org' && (
            <p className="mt-2 text-center text-sm text-neutral-500">
              This application bills per team — you&apos;ll create or join a team during checkout.
            </p>
          )}
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {plans.map((p) => (
              <div key={p.id} className="card text-center">
                <h3 className="font-semibold">{p.name}</h3>
                <div className="mt-1 text-2xl font-bold">{priceLabel(p)}</div>
                <div className="mt-1 text-xs uppercase tracking-wide text-neutral-400">{p.kind}</div>
                <Link href={signedIn ? '/billing' : '/signup'} className="btn mt-4 w-full">
                  {p.amount === 0 ? 'Start free' : 'Choose'}
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="border-t border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-neutral-500">
          Reference app · auth + billing + usage powered by ReliPay
          {config ? ` · application "${config.appName}"` : ''}.
        </div>
      </footer>
    </div>
  );
}
