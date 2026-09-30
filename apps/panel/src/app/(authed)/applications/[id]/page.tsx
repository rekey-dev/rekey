import * as React from 'react';
import Link from '@/components/Link';
import {
  api,
  type ApiKeyRow,
  type ApplicationStatsRow,
  type BillingCredentialRow,
  type PlanRow,
  getApplication,
  unlessBusy,
} from '@/lib/api';
import { type Page } from '@/lib/paginate';
import { hasScope, type Scope } from '@/lib/operator-scopes';
import { SavedBanner } from '@/components/SavedBanner';
import { keyPrefixFor } from '@/components/EnvironmentBadge';
import { StatTile } from '@/components/StatTile';
import { Sparkline } from '@/components/charts/Sparkline';
import { Card, SectionHeader } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';

const NOT_VISIBLE = 'not visible to your role';

type Transport = 'byo_resend' | 'byo_smtp' | 'default_resend' | 'none';

const TRANSPORT_LABEL: Record<Transport, string> = {
  byo_resend: 'your Resend account',
  byo_smtp: 'your SMTP server',
  default_resend: 'shared default sender',
  none: 'no transport',
};

/**
 * Application overview: is this application healthy, and where do I go next.
 * Four health tiles, then the configuration checklist. Every row and tile is
 * gated on the caller's scopes, so a member sees "not visible to your role"
 * instead of a zero that claims something about the account.
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

  const app = await getApplication(id);
  const scopes = app.access?.scopes ?? null;
  const can = (scope: Scope): boolean => hasScope(scopes, scope);
  const billingOn = app.billingConfig.enabled;

  const read = <T,>(path: string, allowed: boolean): Promise<T | null> =>
    allowed
      ? api<T>({ method: 'GET', path: `${basePath}${path}`, interruptOnAccessError: false }).catch(
          unlessBusy(() => null),
        )
      : Promise.resolve(null);

  const [stats, keys, webhooks, email, providers, planPage] = await Promise.all([
    read<ApplicationStatsRow>('/stats', can('overview:read')),
    read<ApiKeyRow[]>('/api-keys', can('developer:read')),
    read<Page<{ id: string; enabled: boolean }>>('/webhooks', can('developer:read')),
    read<{ transport: Transport }>('/email-config', can('developer:read')),
    read<BillingCredentialRow[]>('/billing-credentials', billingOn && can('billing:read')),
    read<Page<PlanRow>>('/plans', billingOn && can('billing:read')),
  ]);

  const tab = (seg: string, scope: Scope): string | null =>
    can(scope) ? `/applications/${id}${seg ? `/${seg}` : ''}` : null;

  const activeKeys = keys?.filter((k) => !k.revokedAt).length ?? null;
  const quickStartDone = activeKeys !== null && activeKeys > 0 && (stats?.users.total ?? 0) > 0;
  const showQuickStart = can('developer:read') && !quickStartDone;
  const accountsCreated = stats?.users.signupTrend.reduce((sum, d) => sum + d.count, 0) ?? 0;

  return (
    <div className="space-y-6">
      {created && <SavedBanner message="Application created." />}
      <SectionHeader
        title="Overview"
        description={
          <>
            How <strong className="font-medium text-[var(--color-fg)]">{app.name}</strong> is doing, and what is
            set up. Each row opens the tab where you change it.
          </>
        }
      />

      {stats ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            title="End-users"
            value={stats.users.total.toLocaleString()}
            href={tab('end-users', 'end-users:read')}
            footer={`${stats.users.newLast7d.toLocaleString()} new this week · ${stats.users.verified.toLocaleString()} verified`}
            chart={<Sparkline data={stats.users.signupTrend.map((d) => d.count)} />}
          />
          <StatTile
            title="Active users (30d)"
            value={stats.activeUsers ? stats.activeUsers.d30.toLocaleString() : '—'}
            href={tab('end-users?sort=lastSignedInAt&order=desc', 'end-users:read')}
            footer={
              stats.activeUsers
                ? `${stats.activeUsers.d1.toLocaleString()} today · ${stats.activeUsers.d7.toLocaleString()} this week`
                : 'needs a newer API'
            }
            chart={stats.activitySeries ? <Sparkline data={stats.activitySeries.map((d) => d.count)} /> : undefined}
            muted={!stats.activeUsers}
          />
          <StatTile
            title="Active subscriptions"
            value={stats.billing.enabled ? stats.billing.activeSubscriptions.toLocaleString() : '—'}
            href={stats.billing.enabled ? tab('revenue', 'billing:read') : tab('billing', 'billing:read')}
            footer={
              stats.billing.enabled
                ? `${stats.billing.plansActive} active plan${stats.billing.plansActive === 1 ? '' : 's'}`
                : 'billing is off'
            }
            muted={!stats.billing.enabled}
          />
          <StatTile
            title="Credits outstanding"
            value={stats.billing.enabled ? stats.usage.creditsOutstanding.toLocaleString() : '—'}
            href={stats.billing.enabled ? tab('usage', 'billing:read') : tab('billing', 'billing:read')}
            footer={
              stats.billing.enabled
                ? `${stats.usage.usageLast30d.toLocaleString()} usage units in 30 days`
                : 'billing is off'
            }
            muted={!stats.billing.enabled}
          />
        </div>
      ) : (
        <EmptyState
          variant="inline"
          title={can('overview:read') ? 'Numbers could not be read' : 'Numbers are not visible to your role'}
          description={
            can('overview:read')
              ? 'The stats request failed. Reload the page to try again.'
              : 'Your access to this application does not include the Overview scope. The configuration below is still yours to read.'
          }
        />
      )}

      {stats && (
        <Card as="section">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-[var(--color-fg)]">Accounts created</h3>
            <span className="text-xs text-[var(--color-muted-fg)]">
              last 30 days · {accountsCreated.toLocaleString()} total
            </span>
          </div>
          <AreaChart data={stats.users.signupTrend} />
          <p className="mt-2 text-xs text-[var(--color-muted-fg)]">
            Every new account, including ones you created, imported or that a billing event created.
          </p>
        </Card>
      )}

      <div className={`grid gap-4 ${showQuickStart ? 'lg:grid-cols-2' : ''}`}>
        <Card as="section">
          <h3 className="mb-3 text-sm font-medium text-[var(--color-fg)]">Configuration</h3>
          <div
            className={`grid gap-x-8 [&>*+*]:border-t [&>*]:border-[var(--color-border)] ${
              showQuickStart ? '' : 'md:grid-cols-2 md:[&>*:nth-child(2)]:border-t-0'
            }`}
          >
            <ConfigRow
              label="Auth methods"
              href={tab('auth', 'auth-config:read')}
              {...(can('auth-config:read')
                ? { value: (app.authConfig.methods ?? ['password']).join(', '), status: 'ok' as const }
                : hidden())}
            />
            <ConfigRow
              label="Sign-in providers"
              href={tab('oauth', 'auth-config:read')}
              {...(can('auth-config:read') ? oauthRow(Object.keys(app.oauthConfig ?? {})) : hidden())}
            />
            <ConfigRow
              label="Organizations"
              href={tab('organizations', 'organizations:read')}
              {...(can('organizations:read')
                ? {
                    value: app.authConfig.organizationsEnabled ? 'on' : 'off',
                    status: app.authConfig.organizationsEnabled ? ('ok' as const) : ('idle' as const),
                  }
                : hidden())}
            />
            <ConfigRow
              label="API keys"
              href={tab('api-keys', 'developer:read')}
              {...(!can('developer:read')
                ? hidden()
                : activeKeys === null
                  ? unreadable()
                  : { value: `${activeKeys} active`, status: activeKeys > 0 ? ('ok' as const) : ('warn' as const) })}
            />
            <ConfigRow
              label="Webhooks"
              href={tab('webhooks', 'developer:read')}
              {...(!can('developer:read') ? hidden() : webhooks === null ? unreadable() : webhookRow(webhooks.items))}
            />
            <ConfigRow
              label="Email"
              href={tab('email', 'developer:read')}
              {...(!can('developer:read')
                ? hidden()
                : email === null
                  ? unreadable()
                  : {
                      value: TRANSPORT_LABEL[email.transport] ?? email.transport,
                      status:
                        email.transport === 'none'
                          ? ('warn' as const)
                          : email.transport === 'default_resend'
                            ? ('idle' as const)
                            : ('ok' as const),
                    })}
            />
            <ConfigRow
              label="Billing"
              href={tab('billing', 'billing:read')}
              {...(!can('billing:read')
                ? hidden()
                : !billingOn
                  ? { value: 'off', status: 'idle' as const }
                  : providers === null
                    ? unreadable()
                    : providerRow(providers))}
            />
            <ConfigRow
              label="Plans"
              href={tab('plans', 'billing:read')}
              {...(!can('billing:read')
                ? hidden()
                : !billingOn
                  ? { value: 'billing is off', status: 'idle' as const }
                  : planPage === null
                    ? unreadable()
                    : planRow(planPage.items))}
            />
          </div>
        </Card>

        {showQuickStart && (
          <Card as="section" className="space-y-3">
            <h3 className="text-sm font-medium text-[var(--color-fg)]">Quick start</h3>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-[var(--color-muted-fg)]">
              <li>
                <Link href={`/applications/${id}/api-keys`} className="text-[var(--color-fg)] hover:underline">
                  Mint an API key
                </Link>{' '}
                and put it in your server&apos;s environment:{' '}
                <code className="font-mono text-xs">REKEY_SECRET={keyPrefixFor(app.environment)}…</code>
              </li>
              <li>
                Add <code className="font-mono text-xs">@rekey.dev/node</code> to your backend, or one of the React
                and Next.js SDKs to your frontend.
              </li>
              <li>
                Optional:{' '}
                <TabLink href={tab('oauth', 'auth-config:read')}>add sign-in providers</TabLink>{' '}
                so people can sign in with Google, Microsoft and others.
              </li>
              <li>
                Optional:{' '}
                <TabLink href={tab('billing', 'billing:read')}>turn on billing</TabLink>{' '}
                (Stripe, PayPal or Razorpay) when you are ready to charge.
              </li>
            </ol>
            <p className="text-xs text-[var(--color-faint-fg)]">
              This card goes away once the application has an active key and its first user.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

function TabLink({ href, children }: { href: string | null; children: React.ReactNode }): React.JSX.Element {
  return href ? (
    <Link href={href} className="text-[var(--color-fg)] hover:underline">
      {children}
    </Link>
  ) : (
    <span className="text-[var(--color-fg)]">{children}</span>
  );
}

type RowState = { value: string; status: 'ok' | 'warn' | 'idle' | 'hidden' };

function hidden(): RowState {
  return { value: NOT_VISIBLE, status: 'hidden' };
}

function unreadable(): RowState {
  return { value: 'could not be read', status: 'idle' };
}

function oauthRow(configured: string[]): RowState {
  return configured.length === 0
    ? { value: 'none', status: 'idle' }
    : { value: configured.join(', '), status: 'ok' };
}

function webhookRow(endpoints: Array<{ enabled: boolean }>): RowState {
  const on = endpoints.filter((e) => e.enabled).length;
  if (endpoints.length === 0) return { value: 'none', status: 'idle' };
  return { value: `${on} of ${endpoints.length} enabled`, status: on > 0 ? 'ok' : 'warn' };
}

function providerRow(providers: BillingCredentialRow[]): RowState {
  const enabled = providers.filter((p) => p.enabled);
  return enabled.length === 0
    ? { value: 'no provider', status: 'warn' }
    : { value: enabled.map((p) => p.provider).join(' + '), status: 'ok' };
}

function planRow(plans: PlanRow[]): RowState {
  const active = plans.filter((p) => p.active).length;
  return { value: `${active} active`, status: active > 0 ? 'ok' : 'warn' };
}

/**
 * Inline SVG area chart for the 30-day account series. No chart library: one
 * filled path and a line, scaled to the series max.
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
        className="h-28 w-full"
        role="img"
        aria-label={`Accounts created per day over the last ${n} days, ${total} in total, peak ${max} in a day`}
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
      <div className="mt-1 flex justify-between text-[10px] text-[var(--color-muted-fg)]">
        <span>{data[0]?.date ?? ''}</span>
        <span>{total === 0 ? 'No new accounts yet' : `peak ${max} a day`}</span>
        <span>{data[n - 1]?.date ?? 'today'} (UTC)</span>
      </div>
    </div>
  );
}

/** One status row in the Configuration card. A row the caller cannot open is plain text. */
function ConfigRow({
  label,
  value,
  status,
  href,
}: {
  label: string;
  value: string;
  status: RowState['status'];
  href: string | null;
}): React.JSX.Element {
  const dot =
    status === 'ok'
      ? 'bg-emerald-500'
      : status === 'warn'
        ? 'bg-amber-500'
        : status === 'hidden'
          ? 'border border-[var(--color-faint-fg)]'
          : 'bg-[var(--color-faint-fg)]';
  const srStatus =
    status === 'ok' ? 'OK' : status === 'warn' ? 'Needs attention' : status === 'hidden' ? 'Hidden' : 'Off';
  const inner = (
    <>
      <span className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="sr-only">{srStatus}:</span>
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={`truncate text-xs ${
            status === 'hidden' ? 'italic text-[var(--color-faint-fg)]' : 'text-[var(--color-muted-fg)] group-hover:text-[var(--color-fg)]'
          }`}
        >
          {value}
        </span>
        {href && (
          <span aria-hidden="true" className="text-xs text-[var(--color-faint-fg)] group-hover:text-[var(--color-fg)]">
            →
          </span>
        )}
      </span>
    </>
  );
  const cls = 'group flex items-center justify-between gap-3 py-2.5';
  return href ? (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
