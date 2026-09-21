/**
 * End-user Security, can they get in, who has been in, and who has acted as
 * them.
 *
 * The activity table here is the one that changed most in the split. It used to
 * scan `actorType=end_user` only, which meant everything an OPERATOR did to
 * this person (block a device, unblock it, release one on their behalf, erase
 * them) and everything the SYSTEM did (create them from a billing event) was
 * recorded and then shown nowhere on their page. `getEndUserEvents` now asks
 * the API for events ABOUT this user (`?endUserId=`), which covers all three
 * actor types in one indexed read.
 */

import * as React from 'react';
import { cookies } from 'next/headers';
import { errorMessage } from '@/lib/error-message';
import { humanizeEventType } from '@/lib/security-events';
import { formatDateTime } from '@/lib/date';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { CopyButton } from '@/components/CopyButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import Link from '@/components/Link';
import { ConfirmButton } from '@/components/ConfirmButton';
import { endImpersonations, impersonate, revokeAllSessions, revokeSession, unlockAccount } from '../actions';
import { SupportFeedback } from '../support-feedback';
import {
  getEndUserDetail,
  getEndUserEvents,
  getEndUserSessions,
  AUTH_EVENTS_SHOWN,
  IMPERSONATE_COOKIE,
  LOGIN_LOCK_MINUTES,
  LOGIN_LOCK_THRESHOLD,
} from '../shared';

const IMPERSONATE_ERR: Record<string, string> = {
  END_USER_NOT_FOUND: 'That end-user no longer exists in this Application.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can impersonate end-users.',
};

/**
 * Readable one-liner from an event's `metadata`. The shape varies by type
 * (`{via}` on sign-in, `{reason}` where the API records one, `{deviceId}` and
 * `{sessionsRevoked}` on the device events), so pick the keys worth surfacing
 * and fall back to a compact render of whatever is there.
 */
function eventDetail(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parts: string[] = [];
  for (const key of [
    'via',
    'reason',
    'deviceName',
    'provider',
    'releasedBy',
    'sessionsRevoked',
    'count',
  ] as const) {
    const v = metadata[key];
    if (typeof v === 'string' && v !== '') parts.push(`${key}: ${v.replace(/_/g, ' ')}`);
    else if (typeof v === 'number') parts.push(`${key}: ${v}`);
  }
  if (parts.length > 0) return parts.join(' · ');
  const keys = Object.keys(metadata);
  return keys.length === 0 ? null : keys.slice(0, 3).join(', ');
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';

export default async function EndUserSecurityPage({
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
  // Three of the six support actions land HERE, not on Overview: clearing a
  // lockout, revoking one session, and signing every session out. Without
  // these two lines their outcome, success and refusal alike, was never
  // rendered anywhere, so a refused action looked exactly like a successful
  // one.
  const supportDone = typeof sp.support === 'string' ? sp.support : undefined;
  const supportError = typeof sp.supportError === 'string' ? sp.supportError : undefined;

  const [detail, events, sessions] = await Promise.all([
    getEndUserDetail(id, euid),
    getEndUserEvents(id, euid),
    getEndUserSessions(id, euid),
  ]);

  type Reveal = { accessToken: string; accessTokenExpiresAt: string };
  let reveal: Reveal | null = null;
  if (impersonated) {
    const jar = await cookies();
    const raw = jar.get(IMPERSONATE_COOKIE)?.value;
    if (raw) {
      try {
        reveal = JSON.parse(raw) as Reveal;
      } catch {
        /* stale */
      }
    }
  }

  const lockedUntil = detail.endUser.lockedUntil ? new Date(detail.endUser.lockedUntil) : null;
  const lockedNow = lockedUntil !== null && lockedUntil > new Date();
  const shown = events?.slice(0, AUTH_EVENTS_SHOWN) ?? [];

  return (
    <div className="space-y-6">
      <SupportFeedback done={supportDone} error={supportError} />
      {impersonated && reveal && (
        <div
          aria-live="polite"
          className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950"
        >
          <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Impersonation token minted, shown once
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Expires {formatDateTime(reveal.accessTokenExpiresAt)}. Use as{' '}
            <code className="font-mono">X-Rekey-User-Token</code> against your customer app&apos;s
            Rekey-backed endpoints. Rekey records this in{' '}
            <code className="font-mono">impersonation_audits</code> with your operator id.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded border border-amber-200 bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-fg)] dark:border-amber-800">
              {reveal.accessToken}
            </code>
            <CopyButton value={reveal.accessToken} label="Copy" />
          </div>
        </div>
      )}
      {impError && <Banner tone="error">{errorMessage(IMPERSONATE_ERR, impError)}</Banner>}

      <Card className="space-y-3">
        <SectionHeader
          title="Sign-in health"
          description="Lockout state from the API's brute-force limiter. It lives in Redis, not on the end-user row."
        />
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
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
                  {LOGIN_LOCK_THRESHOLD - detail.endUser.failedSignInAttempts} more locks the account
                  for {LOGIN_LOCK_MINUTES} minutes
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Lockout</dt>
            <dd>
              {lockedNow ? (
                <Badge tone="danger" dot>
                  locked until {formatDateTime(lockedUntil)}
                </Badge>
              ) : (
                <span className="text-[var(--color-muted-fg)]">none</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <ActionForm action={unlockAccount.bind(null, id, euid)}>
            <SubmitButton
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
              pendingLabel="Unlocking…"
            >
              Clear lockout
            </SubmitButton>
          </ActionForm>
          <span className="text-[11px] text-[var(--color-muted-fg)]">
            {lockedNow
              ? 'The lock also expires on its own; this just ends it now.'
              : 'Nothing is locked. Clearing anyway also resets the failure counter, which is harmless.'}
          </span>
        </div>
      </Card>

      <section className="space-y-3">
        <SectionHeader
          title="Sessions"
          count={sessions ? `(${sessions.page.total})` : undefined}
          description="Live refresh tokens, newest first. A session is not a device: releasing a device revokes its sessions, but a session can exist with no device when the Application does not use device binding."
          action={
            sessions && sessions.items.length > 0 ? (
              <ActionForm action={revokeAllSessions.bind(null, id, euid)}>
                <ConfirmButton
                  variant="subtle"
                  title="Sign out everywhere?"
                  confirm="Revokes every live session. Access tokens already issued keep working until they expire. This stops new ones being obtained."
                  confirmLabel="Sign out everywhere"
                >
                  Sign out everywhere
                </ConfirmButton>
              </ActionForm>
            ) : undefined
          }
        />
        {sessions === null ? (
          <Banner tone="error">
            Sessions could not be read. Either the request failed, or your access does not cover it. This
            is <strong>not</strong> an empty session list.
          </Banner>
        ) : sessions.items.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No live sessions"
            description="Nobody is signed in on this account right now, or every session has expired."
          />
        ) : (
          <Table minWidth="min-w-[44rem]">
            <THead>
              <TR>
                <TH>Started</TH>
                <TH>Expires</TH>
                <TH>IP</TH>
                <TH>Device</TH>
                <TH align="right"> </TH>
              </TR>
            </THead>
            <TBody>
              {sessions.items.map((s) => (
                <TR key={s.id} hover>
                  <TD muted className="whitespace-nowrap text-xs">
                    <span title={s.userAgent ?? undefined}>{formatDateTime(s.createdAt)}</span>
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(s.expiresAt)}
                  </TD>
                  <TD mono muted className="text-xs">
                    {s.ip ?? '—'}
                  </TD>
                  <TD muted className="text-xs">
                    {s.deviceId ? (
                      <Link
                        href={`/applications/${id}/end-users/${euid}/devices`}
                        className="font-mono underline underline-offset-2"
                      >
                        {s.deviceId.slice(0, 10)}…
                      </Link>
                    ) : (
                      <span title="This session was created without a device fingerprint.">
                        unbound
                      </span>
                    )}
                  </TD>
                  <TD align="right">
                    <ActionForm action={revokeSession.bind(null, id, euid, s.id)}>
                      <ConfirmButton
                        variant="subtle"
                        title="Revoke this session?"
                        confirm="Ends this one session. Any access token already issued from it keeps working until it expires."
                        confirmLabel="Revoke"
                      >
                        Revoke
                      </ConfirmButton>
                    </ActionForm>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Activity"
          count={`(${shown.length})`}
          description={`Last ${AUTH_EVENTS_SHOWN} recorded events for this end-user, newest first: theirs, an operator's on them, and the system's.`}
        />

        <Banner tone="info">
          Sign-ins, credential changes and operator actions, including{' '}
          <strong>failed</strong> sign-ins and lockouts for this end-user. Attempts against an
          address that was never registered are deliberately not recorded, so credential stuffing
          shows in the request log rather than here. The counter above is the live lockout state
          and it resets on a successful sign-in.
        </Banner>

        {events === null ? (
          <EmptyState
            variant="inline"
            title="Activity is not visible to your role"
            description="Listing security events requires the OWNER or ADMIN workspace role."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No recorded events"
            description="Nothing has been recorded for this user yet."
          />
        ) : (
          <Table minWidth="min-w-[44rem]">
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>Actor</TH>
                <TH>Detail</TH>
                <TH>IP</TH>
                <TH>When</TH>
              </TR>
            </THead>
            <TBody>
              {shown.map((e) => (
                <TR key={e.id} hover>
                  <TD>
                    <div className="font-medium text-[var(--color-fg)]">
                      {humanizeEventType(e.type)}
                    </div>
                    <div className="font-mono text-xs text-[var(--color-muted-fg)]">{e.type}</div>
                  </TD>
                  <TD muted className="text-xs">
                    {e.actorType === 'end_user'
                      ? 'this user'
                      : e.actorType === 'operator'
                        ? 'operator'
                        : 'system'}
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

      <Card className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">Impersonate this user</h3>
          <p className="text-xs text-[var(--color-muted-fg)]">
            OWNER / ADMIN only. Mints a 5-minute access token that authenticates as this end-user
            against your customer app. Every minting is audit-logged with your operator id.
          </p>
        </div>
        <ActionForm action={impersonate.bind(null, id, euid)} className="flex items-end gap-2">
          <label className="block flex-1 space-y-1.5">
            <span className="text-sm font-medium text-[var(--color-fg)]">
              Reason (optional, audit-logged)
            </span>
            <input
              type="text"
              name="reason"
              maxLength={280}
              placeholder="debugging ticket #42"
              className={inputCls}
            />
          </label>
          <SubmitButton pendingLabel="Minting…">Mint impersonation token</SubmitButton>
        </ActionForm>
      </Card>

      <section className="space-y-3">
        <SectionHeader title="Passkeys" count={`(${detail.passkeys.length})`} />
        {detail.passkeys.length === 0 ? (
          <EmptyState variant="inline" title="No passkeys registered yet" />
        ) : (
          <>
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
                    <TD className="font-medium">
                      {p.deviceName ?? (
                        <span className="font-normal text-[var(--color-muted-fg)]">—</span>
                      )}
                    </TD>
                    <TD mono className="max-w-[14rem] truncate">
                      {p.credentialId}
                    </TD>
                    <TD muted className="text-xs">
                      {p.lastUsedAt ? formatDateTime(p.lastUsedAt) : 'never'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Passkeys are managed by the end-user in your app. To remove one, the user deletes it
              there; erasing the account removes all of them. A passkey is not a device: it is a
              credential, and it takes no device slot.
            </p>
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Recent impersonations"
          count={`(${detail.recentImpersonations.length})`}
          action={
            detail.recentImpersonations.some((r) => r.endedAt === null) ? (
              <ActionForm action={endImpersonations.bind(null, id, euid)}>
                <ConfirmButton
                  title="End every live impersonation?"
                  confirm="Every open impersonation of this end-user ends now, whoever minted it, and the tokens they issued stop working immediately. The audit rows stay."
                  confirmLabel="End impersonations"
                >
                  End live impersonations
                </ConfirmButton>
              </ActionForm>
            ) : undefined
          }
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
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(r.startedAt)}</TD>
                  <TD mono className="max-w-[10rem] truncate">
                    {r.operatorUserId}
                  </TD>
                  <TD className="text-xs">
                    {r.reason ?? <span className="text-[var(--color-muted-fg)]">—</span>}
                  </TD>
                  <TD muted className="text-xs">
                    {r.ip ?? '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
