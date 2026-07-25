import * as React from 'react';
import Link from 'next/link';
import {
  api,
  type ApplicationRow,
  type ApiKeyRow,
  type ApplicationStatsRow,
  type BillingCredentialRow,
  type PlanRow,
} from '@/lib/api';
import { SavedBanner } from '@/components/SavedBanner';

/**
 * Application overview — the landing page when an operator picks an
 * application. Self-explanatory by design: each card explains what it is,
 * shows current state, and links to the deeper tab to act on it.
 */
export default async function ApplicationOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const created = sp.saved === 'created';
  const basePath = `/api/v1/tenant/applications/${encodeURIComponent(id)}`;

  // Fetch in parallel; empty arrays / nulls on failure so the page stays
  // useful even when one provider's call fails.
  const [app, keys, providers, plans, stats] = await Promise.all([
    api<ApplicationRow>({ method: 'GET', path: basePath }),
    api<ApiKeyRow[]>({ method: 'GET', path: `${basePath}/api-keys` }).catch(() => []),
    api<BillingCredentialRow[]>({ method: 'GET', path: `${basePath}/billing-credentials` }).catch(() => []),
    api<PlanRow[]>({ method: 'GET', path: `${basePath}/plans` }).catch(() => []),
    api<ApplicationStatsRow>({ method: 'GET', path: `${basePath}/stats` }).catch(() => null),
  ]);

  const oauthConfigured = Object.keys(app.oauthConfig ?? {});
  const authMethods = app.authConfig.methods ?? ['password'];
  const enabledBilling = providers.filter((p) => p.enabled);
  const activeKeys = keys.filter((k) => !k.revokedAt).length;
  const activePlans = plans.filter((p) => p.active).length;

  return (
    <div className="space-y-6">
      {created && <SavedBanner message="Application created." />}
      <header>
        <h2 className="text-base font-medium">Overview</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-500 mt-1">
          A quick look at <strong>{app.name}</strong>. Each section links to where you can act on it.
        </p>
      </header>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatTile
            title="End-users"
            value={stats.users.total.toLocaleString()}
            href={`/applications/${id}/end-users`}
            footer={`${stats.users.newLast7d} new this week · ${stats.users.verified.toLocaleString()} verified`}
            chart={<Sparkline data={stats.users.signupTrend.map((d) => d.count)} />}
          />
          <StatTile
            title="Sign-ins (30d)"
            value={stats.security.signInsLast30d.toLocaleString()}
            href={`/applications/${id}/activity`}
            footer={`${stats.security.signUpsLast30d} sign-ups · ${stats.security.eventsLast30d} events`}
          />
          <StatTile
            title="Subscriptions"
            value={stats.billing.enabled ? stats.billing.activeSubscriptions.toLocaleString() : '—'}
            href={`/applications/${id}/billing`}
            footer={
              stats.billing.enabled
                ? `${stats.billing.plansActive} active plan${stats.billing.plansActive === 1 ? '' : 's'}`
                : 'Billing disabled'
            }
            muted={!stats.billing.enabled}
          />
          <StatTile
            title="Credits outstanding"
            value={stats.billing.enabled ? stats.usage.creditsOutstanding.toLocaleString() : '—'}
            href={`/applications/${id}/usage`}
            footer={
              stats.billing.enabled
                ? `${stats.usage.usageLast30d.toLocaleString()} usage units (30d)`
                : 'Billing disabled'
            }
            muted={!stats.billing.enabled}
          />
        </div>
      )}

      {/* Sign-ups over time — the headline graph. */}
      {stats && (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Sign-ups</h3>
            <span className="text-xs text-[var(--color-muted-fg)]">
              last 30 days · {stats.users.signupTrend.reduce((s, d) => s + d.count, 0).toLocaleString()} total
            </span>
          </div>
          <AreaChart data={stats.users.signupTrend} />
        </section>
      )}

      {/* Configuration status + quick start — two compact columns replacing the
          old wall of action tiles (the two-level nav already covers navigation). */}
      <div className="grid lg:grid-cols-2 gap-4">
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h3 className="text-sm font-medium mb-3">Configuration</h3>
          <div className="divide-y divide-[var(--color-border)]">
            <ConfigRow
              label="Auth methods"
              value={authMethods.join(', ')}
              status="ok"
              href={`/applications/${id}/auth`}
            />
            <ConfigRow
              label="OAuth providers"
              value={oauthConfigured.length === 0 ? 'none' : oauthConfigured.join(', ')}
              status={oauthConfigured.length > 0 ? 'ok' : 'idle'}
              href={`/applications/${id}/oauth`}
            />
            <ConfigRow
              label="API keys"
              value={`${activeKeys} active`}
              status={activeKeys > 0 ? 'ok' : 'warn'}
              href={`/applications/${id}/api-keys`}
            />
            <ConfigRow
              label="Billing"
              value={
                !app.billingConfig.enabled
                  ? 'disabled'
                  : enabledBilling.length === 0
                    ? 'no provider'
                    : enabledBilling.map((p) => p.provider).join(' + ')
              }
              status={!app.billingConfig.enabled ? 'idle' : enabledBilling.length > 0 ? 'ok' : 'warn'}
              href={`/applications/${id}/billing`}
            />
            <ConfigRow
              label="Plans"
              value={app.billingConfig.enabled ? `${activePlans} active` : '—'}
              status={!app.billingConfig.enabled ? 'idle' : activePlans > 0 ? 'ok' : 'warn'}
              href={`/applications/${id}/plans`}
            />
          </div>
        </section>

        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
          <h3 className="text-sm font-medium">Quick start</h3>
          <ol className="list-decimal pl-5 space-y-1.5 text-sm text-[var(--color-muted-fg)]">
            <li>
              <Link href={`/applications/${id}/api-keys`} className="text-[var(--color-fg)] hover:underline">
                Mint an API key
              </Link>{' '}
              and drop it into your server: <code className="font-mono text-xs">RELIPAY_SECRET=rp_live_…</code>
            </li>
            <li>
              Wire <code className="font-mono text-xs">@relipay/node</code> on your backend (or one of the React/Next SDKs on the frontend).
            </li>
            <li>
              Optional —{' '}
              <Link href={`/applications/${id}/oauth`} className="text-[var(--color-fg)] hover:underline">
                add OAuth providers
              </Link>
              {' '}so users can sign in with Google, Microsoft, etc.
            </li>
            <li>
              Optional —{' '}
              <Link href={`/applications/${id}/billing`} className="text-[var(--color-fg)] hover:underline">
                enable billing
              </Link>
              {' '}(Stripe / PayPal / Razorpay) when you're ready to charge.
            </li>
          </ol>
        </section>
      </div>
    </div>
  );
}

/** Compact metric tile for the Overview stats row. Links to the deeper tab. */
function StatTile({
  title,
  value,
  footer,
  href,
  chart,
  muted = false,
}: {
  title: string;
  value: string;
  footer: string;
  href: string;
  chart?: React.ReactNode;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-1 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors"
    >
      <span className="text-xs text-neutral-600 dark:text-neutral-500">{title}</span>
      <div className="flex items-end justify-between gap-2">
        <span className={`text-2xl font-semibold tabular-nums ${muted ? 'text-[var(--color-muted-fg)]' : ''}`}>
          {value}
        </span>
        {chart && <div className="pb-1">{chart}</div>}
      </div>
      <span className="text-xs text-[var(--color-muted-fg)] leading-snug">{footer}</span>
    </Link>
  );
}

/** Minimal inline bar sparkline — no chart lib. Scales to the series max. */
function Sparkline({ data }: { data: number[] }): React.JSX.Element {
  const max = Math.max(1, ...data);
  return (
    <div className="flex items-end gap-0.5 h-8" aria-hidden>
      {data.map((v, i) => (
        <div
          key={i}
          className="w-1 rounded-sm bg-[color-mix(in_srgb,var(--color-primary)_60%,transparent)] group-hover:bg-[var(--color-primary)] transition-colors"
          style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Inline SVG area chart for the 30-day sign-up series. No chart library — a
 * single filled path + baseline, scaled to the series max. Renders an empty
 * baseline when there's no activity yet.
 */
function AreaChart({ data }: { data: Array<{ date: string; count: number }> }): React.JSX.Element {
  const W = 720;
  const H = 120;
  const pad = 4;
  const max = Math.max(1, ...data.map((d) => d.count));
  const n = data.length;
  const x = (i: number): number => (n <= 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (v: number): number => H - pad - (v / max) * (H - 2 * pad);
  const line = data.map((d, i) => `${x(i).toFixed(1)},${y(d.count).toFixed(1)}`).join(' ');
  const area = `${pad},${H - pad} ${line} ${(W - pad).toFixed(1)},${H - pad}`;
  const total = data.reduce((s, d) => s + d.count, 0);

  return (
    <div className="mt-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-28"
        role="img"
        aria-label={`Sign-ups over the last ${n} days`}
      >
        <polygon points={area} className="fill-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]" />
        <polyline
          points={line}
          fill="none"
          className="stroke-[var(--color-primary)]"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-[var(--color-muted-fg)] mt-1">
        <span>{data[0]?.date ?? ''}</span>
        <span>{total === 0 ? 'No sign-ups yet' : `peak ${max}/day`}</span>
        <span>{data[n - 1]?.date ?? 'today'}</span>
      </div>
    </div>
  );
}

/** One labelled status row in the Configuration card. Links to its tab. */
function ConfigRow({
  label,
  value,
  status,
  href,
}: {
  label: string;
  value: string;
  status: 'ok' | 'warn' | 'idle';
  href: string;
}): React.JSX.Element {
  const dot =
    status === 'ok' ? 'bg-green-500' : status === 'warn' ? 'bg-amber-500' : 'bg-neutral-400';
  const srStatus = status === 'ok' ? 'OK' : status === 'warn' ? 'Needs attention' : 'Off';
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
    >
      <span className="flex items-center gap-2 text-sm">
        <span className={`w-1.5 h-1.5 rounded-full ${dot} shrink-0`} aria-hidden />
        <span className="sr-only">{srStatus}:</span>
        {label}
      </span>
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="truncate text-xs text-[var(--color-muted-fg)] group-hover:text-[var(--color-fg)]">
          {value}
        </span>
        <span className="text-xs text-neutral-400 group-hover:text-[var(--color-fg)]">→</span>
      </span>
    </Link>
  );
}
