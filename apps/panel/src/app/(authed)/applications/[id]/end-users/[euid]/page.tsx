/**
 * End-user detail page.
 *
 * Shows: profile (email / role / verified / lockout state), registered
 * passkeys (read-only), recent impersonation audit rows, and an
 * Impersonate button that mints a 5-minute access token for the operator
 * to use against the customer's app.
 *
 * The impersonation token is sensitive — same security treatment as the
 * MFA setup secret (Audit-3 BLOCKER #3). We stash it in a short-lived
 * HttpOnly cookie scoped to this page and surface it server-rendered;
 * we DON'T put it in the URL.
 */

import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { api, PanelApiError, type SecurityEventRow } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { humanizeEventType } from '@/lib/security-events';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { formatDate, formatDateTime } from '@/lib/date';
import { CopyButton } from '@/components/CopyButton';
import { CopyLinkButton } from '@/components/CopyLinkButton';
import { SubmitButton } from '@/components/SubmitButton';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { StatusPill } from '@/components/StatusPill';
import { formatMoney } from '@/lib/format';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';
import { cookieSecure } from '@/lib/cookie-secure';

interface EndUserDetailDto {
  endUser: {
    id: string;
    email: string;
    emailVerified: boolean;
    role: string;
    metadata: unknown;
    /**
     * Both from the API's Redis brute-force limiter, not a column on the row.
     * They were declared here long before the endpoint actually returned them,
     * which is why the lockout badge below used to read "none" for every
     * account — including ones the API was refusing with 429.
     *
     * `failedSignInAttempts` is the live counter while under the threshold, and
     * the threshold itself once locked (the counter is consumed setting the
     * lock, so no exact count survives).
     */
    failedSignInAttempts: number;
    /** Lock expiry, or null when not locked. */
    lockedUntil: string | null;
    /** GDPR tombstone — set once the user has been erased. */
    erasedAt: string | null;
    erasedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  passkeys: Array<{
    id: string;
    credentialId: string;
    deviceName: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  }>;
  recentImpersonations: Array<{
    id: string;
    operatorUserId: string;
    reason: string | null;
    startedAt: string;
    endedAt: string | null;
    ip: string | null;
  }>;
}

interface CreditLedgerRow {
  id: string;
  delta: number;
  reason: 'PURCHASE' | 'GRANT' | 'CONSUME' | 'REFUND' | 'ADJUST';
  balanceAfter: number;
  description: string | null;
  createdAt: string;
}
interface CreditsDto {
  balance: number;
  ledger: CreditLedgerRow[];
}

interface BillingDto {
  subscriptions: Array<{
    id: string;
    status: string;
    provider: string | null;
    providerSubId: string | null;
    currentPeriodEnd: string | null;
    cancelAt: string | null;
    canceledAt: string | null;
    beneficiaryOrgId: string | null;
    createdAt: string;
    plan: { slug: string; name: string; kind: string; amount: number; currency: string; interval: string };
  }>;
  payments: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    description: string | null;
    providerPaymentId: string | null;
    subscriptionId: string | null;
    createdAt: string;
  }>;
  licenses: Array<{
    id: string;
    kind: string;
    status: string;
    keyPrefix: string;
    seatsAllowed: number | null;
    organizationId: string | null;
    expiresAt: string | null;
    createdAt: string;
    plan: { slug: string; name: string } | null;
  }>;
}

/**
 * Brute-force policy the API applies to end-user password sign-in
 * (`LOGIN_POLICY` in `apps/api/src/lib/brute-force.ts`): 10 failures in a
 * 15-minute window → a 15-minute lock. Mirrored here purely so the counter on
 * this page has a denominator — "Failed sign-in attempts: 7" is unanswerable
 * without knowing what trips the lock.
 */
const LOGIN_LOCK_THRESHOLD = 10;
const LOGIN_LOCK_MINUTES = 15;

/**
 * Recent auth events for ONE end-user.
 *
 * `GET /tenant/security-events` has no `actorId` filter, so the panel pulls the
 * application's most recent `AUTH_EVENT_SCAN` end-user events (200 is the API's
 * `limit` ceiling) and narrows in memory. On a busy application that window may
 * not reach far back for a quiet user — the panel says so rather than implying
 * the list is exhaustive.
 */
const AUTH_EVENT_SCAN = 200;
const AUTH_EVENTS_SHOWN = 20;

/**
 * Readable one-liner from an event's `metadata`. The shape varies by type
 * (`{via}` on sign-in, `{reason}` where the API records one, credential info on
 * passkey events), so pick the keys worth surfacing and fall back to a compact
 * render of whatever is there.
 */
function eventDetail(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parts: string[] = [];
  for (const key of ['via', 'reason', 'deviceName', 'count', 'provider'] as const) {
    const v = metadata[key];
    if (typeof v === 'string' && v !== '') parts.push(`${key}: ${v.replace(/_/g, ' ')}`);
    else if (typeof v === 'number') parts.push(`${key}: ${v}`);
  }
  if (parts.length > 0) return parts.join(' · ');
  const keys = Object.keys(metadata);
  return keys.length === 0 ? null : keys.slice(0, 3).join(', ');
}


const IMPERSONATE_COOKIE = 'rekey_impersonate_reveal';
const IMPERSONATE_COOKIE_MAX_AGE = 60 * 6; // 6 min — slightly outlives the 5-min token so the page can re-render.

async function impersonate(
  applicationId: string,
  euid: string,
  formData: FormData,
): Promise<void> {
  'use server';
  const reason = String(formData.get('reason') ?? '').trim();
  try {
    const result = await api<{
      accessToken: string;
      accessTokenExpiresAt: string;
      impersonatedUser: { id: string; email: string };
    }>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}/impersonate`,
      body: { reason: reason || undefined },
    });
    const jar = await cookies();
    jar.set(
      IMPERSONATE_COOKIE,
      JSON.stringify(result),
      {
        httpOnly: true,
        sameSite: 'strict',
        secure: await cookieSecure(),
        path: `/applications/${applicationId}/end-users/${euid}`,
        maxAge: IMPERSONATE_COOKIE_MAX_AGE,
      },
    );
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(
        `/applications/${applicationId}/end-users/${euid}?impError=${encodeURIComponent(err.code)}`,
      );
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/end-users/${euid}?impersonated=1`);
}

async function grantCredits(
  applicationId: string,
  euid: string,
  formData: FormData,
): Promise<void> {
  'use server';
  const amount = Number(formData.get('amount') ?? 0);
  const reason = String(formData.get('reason') ?? 'GRANT');
  const description = String(formData.get('description') ?? '').trim();
  const base = `/applications/${applicationId}/end-users/${euid}`;
  if (!Number.isInteger(amount) || amount === 0) {
    redirect(`${base}?creditError=AMOUNT`);
  }
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}/credits/grant`,
      body: { amount, reason, description: description || undefined },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?creditError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`${base}?credited=1`);
}

async function eraseUser(applicationId: string, euid: string): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/end-users/${euid}`;
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}?erasure=true`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?eraseError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`${base}?erased=1`);
}

const ERASE_ERR: Record<string, string> = {
  END_USER_NOT_FOUND: 'That end-user no longer exists in this Application.',
  TENANT_ROLE_INSUFFICIENT: 'Only workspace owners and admins can erase an end-user.',
};

const IMPERSONATE_ERR: Record<string, string> = {
  END_USER_NOT_FOUND: 'That end-user no longer exists in this Application.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can impersonate end-users.',
};

const CREDIT_ERR: Record<string, string> = {
  AMOUNT: 'Enter a non-zero whole number of credits.',
  CREDITS_INSUFFICIENT: 'That removal would overdraw the balance.',
  CREDITS_AMOUNT_INVALID: 'Enter a non-zero whole number of credits.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can adjust credits.',
};

const CREDIT_REASON_TONE: Record<CreditLedgerRow['reason'], BadgeTone> = {
  PURCHASE: 'success',
  GRANT: 'success',
  REFUND: 'info',
  CONSUME: 'neutral',
  ADJUST: 'warning',
};

export default async function EndUserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  const impError = typeof sp.impError === 'string' ? sp.impError : undefined;
  const impersonated = sp.impersonated === '1';
  const creditError = typeof sp.creditError === 'string' ? sp.creditError : undefined;
  const credited = sp.credited === '1';
  const eraseError = typeof sp.eraseError === 'string' ? sp.eraseError : undefined;
  const erased = sp.erased === '1';

  const [detail, credits, billing, authEvents] = await Promise.all([
    api<EndUserDetailDto>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users/${encodeURIComponent(euid)}`,
    }),
    api<CreditsDto>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users/${encodeURIComponent(euid)}/credits`,
    }).catch(() => ({ balance: 0, ledger: [] }) as CreditsDto),
    api<BillingDto>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users/${encodeURIComponent(euid)}/billing`,
    }).catch(() => ({ subscriptions: [], payments: [], licenses: [] }) as BillingDto),
    // "Why can't this user sign in?" — see the AUTH_EVENT_SCAN note.
    api<Page<SecurityEventRow>>({
      method: 'GET',
      path: `/api/v1/tenant/security-events?applicationId=${encodeURIComponent(id)}&actorType=end_user&limit=${AUTH_EVENT_SCAN}`,
    })
      .then((r) => r.items.filter((e) => e.actorId === euid).slice(0, AUTH_EVENTS_SHOWN))
      // OWNER/ADMIN-only endpoint: a MEMBER gets 403 here. Degrade to no panel
      // rather than 403-ing the whole end-user page.
      .catch(() => null),
  ]);

  type Reveal = { accessToken: string; accessTokenExpiresAt: string };
  const jar = await cookies();
  const revealCookie = jar.get(IMPERSONATE_COOKIE)?.value;
  let reveal: Reveal | null = null;
  if (revealCookie && impersonated) {
    try {
      reveal = JSON.parse(revealCookie) as Reveal;
    } catch {
      /* stale */
    }
  }

  const lockedUntil = detail.endUser.lockedUntil
    ? new Date(detail.endUser.lockedUntil)
    : null;
  const lockedNow = lockedUntil !== null && lockedUntil > new Date();
  const isErased = detail.endUser.erasedAt !== null;

  return (
    <div className="space-y-5">
      <PageHeader
        level={2}
        eyebrow={
          <Link
            href={`/applications/${id}/end-users`}
            className="inline-flex items-center gap-1 rounded text-xs text-[var(--color-muted-fg)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
          >
            ← End-users
          </Link>
        }
        title={
          <span className="inline-flex items-center gap-2 text-lg">
            {detail.endUser.email}
            {isErased && <Badge tone="danger" dot>erased</Badge>}
          </span>
        }
        description={<span className="font-mono text-xs">{detail.endUser.id}</span>}
        action={<CopyLinkButton />}
      />

      {erased && (
        <Banner tone="error">
          End-user erased. PII and credentials were deleted; financial records are retained anonymized.
        </Banner>
      )}
      {eraseError && (
        <Banner tone="error">
          {ERASE_ERR[eraseError] ?? eraseError}
        </Banner>
      )}
      {isErased && (
        <Banner tone="warning">
          This end-user has been erased (GDPR). Their PII and credentials are gone and they can no
          longer sign in. Financial records below are retained but anonymized.
        </Banner>
      )}

      {impersonated && reveal && (
        <div
          aria-live="polite"
          className="space-y-2 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-3"
        >
          <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Impersonation token minted — shown once
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Expires {formatDateTime(reveal.accessTokenExpiresAt)}. Use as{' '}
            <code className="font-mono">X-Rekey-User-Token</code> against your customer app's
            Rekey-backed endpoints. Rekey records this in <code className="font-mono">
              impersonation_audits
            </code> with your operator id.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded border border-amber-200 dark:border-amber-800 bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-fg)]">
              {reveal.accessToken}
            </code>
            <CopyButton value={reveal.accessToken} label="Copy" />
          </div>
        </div>
      )}
      {impError && (
        <Banner tone="error">
          {IMPERSONATE_ERR[impError] ?? impError}
        </Banner>
      )}

      <Card className="space-y-3">
        <SectionHeader
          title="Profile"
          action={
            <span className="text-xs text-[var(--color-muted-fg)]">
              Joined {formatDate(detail.endUser.createdAt)}
            </span>
          }
        />
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Email</dt>
            <dd className="flex items-center gap-2 text-[var(--color-fg)]">
              {detail.endUser.email}
              {detail.endUser.emailVerified ? (
                <Badge tone="success" dot>verified</Badge>
              ) : (
                <Badge tone="warning">unverified</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Role</dt>
            <dd>
              <Badge tone="neutral" mono>{detail.endUser.role}</Badge>
            </dd>
          </div>
          <div>
            <dt
              className="text-xs text-[var(--color-muted-fg)]"
              title={
                lockedNow
                  ? 'At least this many failures tripped the lockout. The counter is consumed when the lock is set, so this is the threshold, not a live count.'
                  : 'Failures in the current 15-minute window. Resets on a successful sign-in.'
              }
            >
              Failed sign-in attempts
            </dt>
            {/* A bare "7" told the operator nothing: 7 of what? The threshold
                is the whole point of the number, so show the denominator. */}
            <dd className="text-[var(--color-fg)]">
              {lockedNow ? '≥ ' : ''}
              {detail.endUser.failedSignInAttempts}
              <span className="text-[var(--color-muted-fg)]"> of {LOGIN_LOCK_THRESHOLD}</span>
              {!lockedNow && detail.endUser.failedSignInAttempts > 0 && (
                <span className="block text-xs text-[var(--color-muted-fg)]">
                  {LOGIN_LOCK_THRESHOLD - detail.endUser.failedSignInAttempts} more locks the
                  account for {LOGIN_LOCK_MINUTES} minutes
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Lockout</dt>
            <dd>
              {lockedNow ? (
                <Badge tone="danger" dot>locked until {formatDateTime(lockedUntil!)}</Badge>
              ) : (
                <span className="text-[var(--color-muted-fg)]">none</span>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      {/* ─── Recent auth events ───────────────────────────────
          The answer to "why can't this user sign in?" was previously
          unreachable: the counter above had no context, and this person's
          events appeared nowhere — Activity is application-wide and had no
          way to narrow to one user. */}
      {authEvents !== null && (
        <section className="space-y-4">
          <SectionHeader
            title="Recent auth events"
            description={`Last ${AUTH_EVENTS_SHOWN} recorded events for this end-user, newest first.`}
            count={`(${authEvents.length})`}
          />

          <Banner tone="info">
            Successful sign-ins and credential changes only. <strong>Failed</strong> sign-ins and
            lockouts are counted in Redis and never written as events, so they cannot appear here —
            the counter above is the only signal, and it resets on a successful sign-in.
          </Banner>

          {authEvents.length === 0 ? (
            <EmptyState
              variant="inline"
              title="No recorded auth events"
              description={`Nothing for this user in the application's most recent ${AUTH_EVENT_SCAN} end-user events. On a busy application that window may not reach back far.`}
            />
          ) : (
            <Table minWidth="min-w-[40rem]">
              <THead>
                <TR>
                  <TH>Event</TH>
                  <TH>Detail</TH>
                  <TH>IP</TH>
                  <TH>When</TH>
                </TR>
              </THead>
              <TBody>
                {authEvents.map((e) => (
                  <TR key={e.id} hover>
                    <TD>
                      <div className="font-medium text-[var(--color-fg)]">
                        {humanizeEventType(e.type)}
                      </div>
                      <div className="font-mono text-xs text-[var(--color-muted-fg)]">{e.type}</div>
                    </TD>
                    <TD className="text-xs text-[var(--color-muted-fg)]">
                      {eventDetail(e.metadata) ?? '—'}
                    </TD>
                    <TD mono muted className="text-xs">
                      <span title={e.userAgent ?? undefined}>{e.ip ?? '—'}</span>
                    </TD>
                    <TD muted className="whitespace-nowrap text-xs">
                      {formatDateTime(e.createdAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </section>
      )}

      <section className="space-y-4">
        <SectionHeader
          title="Subscriptions & payments"
          action={
            <span className="text-xs text-[var(--color-muted-fg)]">
              {billing.subscriptions.length} subscription{billing.subscriptions.length === 1 ? '' : 's'} · {billing.payments.length} payment{billing.payments.length === 1 ? '' : 's'}
            </span>
          }
        />

        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">Subscriptions</h4>
          {billing.subscriptions.length === 0 ? (
            <EmptyState variant="inline" title="No subscriptions" />
          ) : (
            <Table minWidth="min-w-[44rem]">
              <THead>
                <TR>
                  <TH>Plan</TH>
                  <TH>Status</TH>
                  <TH>Provider</TH>
                  <TH>Renews</TH>
                  <TH>Started</TH>
                </TR>
              </THead>
              <TBody>
                {billing.subscriptions.map((s) => (
                  <TR key={s.id} hover>
                    <TD>
                      <span className="font-medium text-[var(--color-fg)]">{s.plan.name}</span>{' '}
                      <span className="font-mono text-xs text-[var(--color-muted-fg)]">{s.plan.slug}</span>
                      {s.beneficiaryOrgId && (
                        <Badge tone="info" className="ml-1.5">team</Badge>
                      )}
                      <div className="text-[11px] text-[var(--color-muted-fg)]">
                        {formatMoney(s.plan.amount, s.plan.currency)} / {s.plan.interval.toLowerCase()}
                      </div>
                    </TD>
                    <TD>
                      <StatusPill status={s.status} />
                    </TD>
                    <TD muted className="text-xs">{s.provider ?? '—'}</TD>
                    <TD muted className="text-xs">
                      {s.cancelAt ? `cancels ${formatDate(s.cancelAt)}` : s.currentPeriodEnd ? formatDate(s.currentPeriodEnd) : '—'}
                    </TD>
                    <TD muted className="text-xs">{formatDate(s.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">Payments</h4>
          {billing.payments.length === 0 ? (
            <EmptyState variant="inline" title="No payments recorded" />
          ) : (
            <Table minWidth="min-w-[44rem]">
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH align="right">Amount</TH>
                  <TH>Status</TH>
                  <TH>Description</TH>
                  <TH>Provider ref</TH>
                </TR>
              </THead>
              <TBody>
                {billing.payments.map((p) => (
                  <TR key={p.id} hover>
                    <TD muted className="text-xs">{formatDateTime(p.createdAt)}</TD>
                    <TD align="right" mono className="tabular-nums">{formatMoney(p.amount, p.currency)}</TD>
                    <TD>
                      <StatusPill status={p.status} />
                    </TD>
                    <TD muted className="max-w-[12rem] truncate text-xs">{p.description ?? '—'}</TD>
                    <TD muted mono className="max-w-[12rem] truncate text-[11px]">{p.providerPaymentId ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>

        {billing.licenses.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">Licenses</h4>
            <Table minWidth="min-w-[44rem]">
              <THead>
                <TR>
                  <TH>Key</TH>
                  <TH>Plan</TH>
                  <TH>Kind</TH>
                  <TH>Status</TH>
                  <TH align="right">Seats</TH>
                  <TH>Expires</TH>
                </TR>
              </THead>
              <TBody>
                {billing.licenses.map((l) => (
                  <TR key={l.id} hover>
                    <TD mono>
                      {l.keyPrefix}…
                      {l.organizationId && <Badge tone="info" className="ml-1.5">team</Badge>}
                    </TD>
                    <TD muted className="text-xs">{l.plan?.name ?? '—'}</TD>
                    <TD muted className="text-xs">{l.kind.toLowerCase()}</TD>
                    <TD>
                      <StatusPill status={l.status} />
                    </TD>
                    <TD align="right" muted className="text-xs tabular-nums">{l.seatsAllowed ?? '—'}</TD>
                    <TD muted className="text-xs">{l.expiresAt ? formatDate(l.expiresAt) : 'never'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Credits"
          description="Prepaid credit balance, spent down as the user consumes."
        />

        {credited && (
          <Banner tone="success">
            Credits updated.
          </Banner>
        )}
        {creditError && (
          <Banner tone="error">
            {CREDIT_ERR[creditError] ?? creditError}
          </Banner>
        )}

        <Card className="space-y-4">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums text-[var(--color-fg)]">{credits.balance}</span>
            <span className="text-xs text-[var(--color-muted-fg)]">credits available</span>
          </div>

          <form
            action={grantCredits.bind(null, id, euid)}
            className="grid items-end gap-2 sm:grid-cols-[6rem_8rem_1fr_auto]"
          >
            <label className="block space-y-1">
              <span className="text-xs font-medium text-[var(--color-fg)]">Amount</span>
              <input
                type="number"
                name="amount"
                step={1}
                placeholder="100"
                required
                className={`${creditInputCls} font-mono`}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-[var(--color-fg)]">Reason</span>
              <select name="reason" defaultValue="GRANT" className={creditInputCls}>
                <option value="GRANT">Grant</option>
                <option value="REFUND">Refund</option>
                <option value="ADJUST">Adjust</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-[var(--color-fg)]">Note (optional)</span>
              <input
                type="text"
                name="description"
                maxLength={200}
                placeholder="promo top-up"
                className={creditInputCls}
              />
            </label>
            <SubmitButton pendingLabel="Applying…">Apply</SubmitButton>
          </form>
          <p className="text-[11px] text-[var(--color-muted-fg)]">
            Positive adds (Grant / Refund). Negative with Adjust removes — refused if it would overdraw.
          </p>
        </Card>

        {credits.ledger.length > 0 && (
          <Table minWidth="min-w-[44rem]">
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Reason</TH>
                <TH align="right">Change</TH>
                <TH align="right">Balance</TH>
                <TH>Note</TH>
              </TR>
            </THead>
            <TBody>
              {credits.ledger.map((e) => (
                <TR key={e.id} hover>
                  <TD muted className="text-xs">{formatDateTime(e.createdAt)}</TD>
                  <TD>
                    <Badge tone={CREDIT_REASON_TONE[e.reason]} dot>{e.reason.toLowerCase()}</Badge>
                  </TD>
                  <TD align="right" mono className="tabular-nums">{e.delta > 0 ? `+${e.delta}` : e.delta}</TD>
                  <TD align="right" mono muted className="tabular-nums">{e.balanceAfter}</TD>
                  <TD muted className="max-w-[12rem] truncate text-xs">{e.description ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">Export data (JSON)</h3>
            <p className="text-xs text-[var(--color-muted-fg)]">
              OWNER / ADMIN only. Downloads everything Rekey stores about this end-user — profile,
              identities, session metadata, billing, credits, usage, security events — as a single
              JSON document. Use it to answer GDPR / CCPA data-subject access requests (DSARs).
              Credential material (password hashes, token hashes, MFA secrets) is never included.
            </p>
          </div>
          <a
            href={`/applications/${id}/end-users/${euid}/export`}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
            title="Download this end-user's stored data as JSON (GDPR/DSAR)"
          >
            Export data (JSON)
          </a>
        </div>
      </Card>

      <Card className="space-y-3 border-red-300 dark:border-red-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">Erase (GDPR)</h3>
            <p className="max-w-xl text-xs text-[var(--color-muted-fg)]">
              OWNER / ADMIN only. Permanently erases this end-user's personal data and credentials
              (email, profile, OAuth links, sessions, MFA, passkeys) and tombstones the account so
              they can never sign in again. Distinct from a plain delete: financial records
              (payments, subscriptions, licenses, credit ledger, usage) are <strong>retained but
              anonymized</strong> to meet accounting / legal-retention obligations. This cannot be
              undone.
            </p>
          </div>
          {isErased ? (
            <span
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-muted-fg)] opacity-60"
              title="This end-user has already been erased"
            >
              Already erased
            </span>
          ) : (
            <form action={eraseUser.bind(null, id, euid)} className="inline">
              <TypedConfirmButton
                expected={detail.endUser.email}
                title="Erase this end-user (GDPR)?"
                description={
                  "This permanently deletes the user's PII and credentials and tombstones the account — " +
                  'they can never sign in again. Financial records are retained but anonymized. This cannot be undone.'
                }
                triggerLabel="Erase (GDPR)"
                confirmLabel="Erase permanently"
                triggerClassName="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-red-300 dark:border-red-700 px-3 py-1.5 text-sm text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
              />
            </form>
          )}
        </div>
      </Card>

      <Card className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">Impersonate this user</h3>
          <p className="text-xs text-[var(--color-muted-fg)]">
            OWNER / ADMIN only. Mints a 5-minute access token that authenticates as this end-user
            against your customer app. Every minting is audit-logged with your operator id.
          </p>
        </div>
        <form action={impersonate.bind(null, id, euid)} className="flex items-end gap-2">
          <label className="block flex-1 space-y-1.5">
            <span className="text-sm font-medium text-[var(--color-fg)]">Reason (optional, audit-logged)</span>
            <input
              type="text"
              name="reason"
              maxLength={280}
              placeholder="debugging ticket #42"
              className={creditInputCls}
            />
          </label>
          <SubmitButton pendingLabel="Minting…">Mint impersonation token</SubmitButton>
        </form>
      </Card>

      <section className="space-y-3">
        <SectionHeader
          title="Passkeys"
          count={`(${detail.passkeys.length})`}
        />
        {detail.passkeys.length === 0 ? (
          <EmptyState variant="inline" title="No passkeys registered yet" />
        ) : (
          <Table minWidth="min-w-[40rem]">
            <THead>
              <TR>
                <TH>Device</TH>
                <TH>Credential id</TH>
                <TH>Last used</TH>
              </TR>
            </THead>
            <TBody>
              {detail.passkeys.map((p) => (
                <TR key={p.id} hover>
                  <TD className="font-medium">{p.deviceName ?? <span className="font-normal text-[var(--color-muted-fg)]">—</span>}</TD>
                  <TD mono className="max-w-[14rem] truncate">{p.credentialId}</TD>
                  <TD muted className="text-xs">
                    {p.lastUsedAt ? formatDateTime(p.lastUsedAt) : 'never'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {detail.passkeys.length > 0 && (
          <p className="text-xs text-[var(--color-muted-fg)]">
            Passkeys are managed by the end-user in your app. To remove one, the
            user deletes it there; erasing the account removes all of them.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Recent impersonations"
          count={`(${detail.recentImpersonations.length})`}
        />
        {detail.recentImpersonations.length === 0 ? (
          <EmptyState variant="inline" title="No operator has impersonated this user" />
        ) : (
          <Table minWidth="min-w-[40rem]">
            <THead>
              <TR>
                <TH>Started</TH>
                <TH>Operator</TH>
                <TH>Reason</TH>
                <TH>IP</TH>
              </TR>
            </THead>
            <TBody>
              {detail.recentImpersonations.map((r) => (
                <TR key={r.id} hover>
                  <TD className="text-xs">{formatDateTime(r.startedAt)}</TD>
                  <TD mono className="max-w-[10rem] truncate">{r.operatorUserId}</TD>
                  <TD className="text-xs">
                    {r.reason ?? <span className="text-[var(--color-muted-fg)]">—</span>}
                  </TD>
                  <TD muted className="text-xs">{r.ip ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}

const creditInputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';
