import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { getAccessToken, relipay } from '@/lib/relipay';

async function signOutEverywhere(): Promise<void> {
  'use server';
  const access = await getAccessToken();
  if (access) {
    await relipay.auth.signOutEverywhere(access).catch(() => undefined);
  }
  redirect('/sign-out?reason=signed-out-everywhere');
}

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default async function Dashboard(): Promise<React.JSX.Element> {
  const me = await requireUser();
  const access = (await getAccessToken())!;
  const [plans, subscription] = await Promise.all([
    relipay.billing.getPlans().catch(() => []),
    relipay.billing.getSubscription(access).catch(() => null),
  ]);
  const currentPlan = subscription
    ? plans.find((p) => p.id === subscription.planId) ?? null
    : null;

  return (
    <main className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950">
        <div className="mx-auto max-w-4xl px-6 py-3 flex items-center justify-between">
          <Link href="/" className="font-semibold">
            ReliPay Demo
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/dashboard" className="font-medium">Dashboard</Link>
            <Link href="/billing" className="text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100">Billing</Link>
            <Link href="/change-password" className="text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100">Security</Link>
            <Link href="/sign-out" className="text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100">
              Sign out
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-10 space-y-8">
        {/* Identity card */}
        <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6">
          <div className="flex items-start gap-4">
            <div className="grid place-items-center h-14 w-14 rounded-full bg-gradient-to-br from-indigo-500 to-pink-500 text-white font-semibold text-lg">
              {initials(me.email)}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-semibold truncate">{me.email}</h1>
              <div className="mt-1 flex items-center gap-3 text-xs">
                {me.emailVerified ? (
                  <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    verified
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    pending verification
                  </span>
                )}
                <span className="text-neutral-500">
                  member for {relativeTime(me.createdAt)}
                </span>
              </div>
              <p className="mt-3 text-xs font-mono text-neutral-500 break-all">{me.id}</p>
            </div>
          </div>
        </section>

        {/* Stat grid */}
        <section className="grid sm:grid-cols-3 gap-4">
          <StatCard
            label="Plan"
            value={currentPlan?.name ?? (subscription ? subscription.planId : 'Free')}
            hint={
              subscription
                ? `${subscription.status.toLowerCase()}${subscription.currentPeriodEnd ? ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : ''}`
                : 'No subscription yet'
            }
          />
          <StatCard
            label="Plans available"
            value={String(plans.length)}
            hint={plans.length === 0 ? 'Configure plans in panel' : 'Browse on the Billing tab'}
          />
          <StatCard
            label="Account"
            value={me.emailVerified ? 'Active' : 'Pending'}
            hint={me.emailVerified ? 'Email verified' : 'Check your inbox'}
          />
        </section>

        {/* Subscription block */}
        <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium">Subscription</h2>
            <Link
              href="/billing"
              className="text-xs text-neutral-600 dark:text-neutral-400 hover:underline"
            >
              Manage →
            </Link>
          </div>
          {subscription ? (
            <div className="grid sm:grid-cols-3 gap-4 text-sm">
              <Field label="Plan" value={currentPlan?.name ?? subscription.planId} />
              <Field label="Status" value={subscription.status} />
              <Field
                label={subscription.cancelAt ? 'Cancels' : 'Renews'}
                value={
                  subscription.cancelAt
                    ? new Date(subscription.cancelAt).toLocaleDateString()
                    : subscription.currentPeriodEnd
                    ? new Date(subscription.currentPeriodEnd).toLocaleDateString()
                    : '—'
                }
              />
            </div>
          ) : (
            <div className="rounded-lg border-2 border-dashed border-neutral-300 dark:border-neutral-700 p-6 text-center space-y-2">
              <p className="text-sm">You're on the Free tier.</p>
              {plans.length > 0 && (
                <Link
                  href="/billing"
                  className="inline-block rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  Upgrade to a paid plan
                </Link>
              )}
            </div>
          )}
        </section>

        {/* Account actions */}
        <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 space-y-3">
          <h2 className="text-base font-medium">Account</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <ActionLink
              href="/change-password"
              title="Change password"
              hint="Rotate your password — old sessions stay valid until they expire."
            />
            <ActionLink
              href="/billing"
              title="Billing & invoices"
              hint="View plans, redeem coupons, manage subscription."
            />
          </div>
          <form action={signOutEverywhere}>
            <button
              type="submit"
              className="text-xs text-red-600 dark:text-red-400 hover:underline"
            >
              Sign out of all devices
            </button>
          </form>
        </section>

        <p className="text-xs text-neutral-500">
          Server-rendered. The user is resolved via{' '}
          <code>relipay.auth.getCurrentUser(accessToken)</code> with auto-refresh
          delegated to <code>/refresh-session</code> (a Route Handler).
        </p>
      </div>
    </main>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-semibold truncate">{value}</p>
      <p className="text-xs text-neutral-500 mt-1 truncate">{hint}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
    </div>
  );
}

function ActionLink({ href, title, hint }: { href: string; title: string; hint: string }): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group block rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors"
    >
      <p className="text-sm font-medium group-hover:underline">{title}</p>
      <p className="text-xs text-neutral-500 mt-0.5">{hint}</p>
    </Link>
  );
}
