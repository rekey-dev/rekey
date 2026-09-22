/**
 * Shared types and fetchers for the end-user detail tabs.
 *
 * The detail page used to be one 900-line file that fetched four endpoints on
 * every render and stacked everything it knew in one scroll. It is now a
 * layout plus six tab pages, which means two things had to move here:
 *
 *  - the DTOs, because more than one tab reads each of them;
 *  - the fetchers, because a layout and the page inside it resolve
 *    independently and would otherwise issue the same request twice.
 *
 * Every fetcher goes through `apiGet`, which is `React.cache`d per request, so
 * the header in the layout and the tab body below it share one round trip.
 * That is also why these are thin one-argument wrappers rather than inline
 * `api({...})` calls: an options object literal is a fresh cache key and would
 * memoise nothing.
 */

import { cookies } from 'next/headers';
import { apiGet, unlessBusy, type SecurityEventRow } from '@/lib/api';
import type { Page } from '@/lib/paginate';

export interface EndUserDetailDto {
  endUser: {
    id: string;
    email: string;
    emailVerified: boolean;
    role: string;
    metadata: unknown;
    /**
     * Both from the API's Redis brute-force limiter, not a column on the row.
     * `failedSignInAttempts` is the live counter while under the threshold, and
     * the threshold itself once locked (the counter is consumed setting the
     * lock, so no exact count survives).
     */
    failedSignInAttempts: number;
    /** Lock expiry, or null when not locked. */
    lockedUntil: string | null;
    /** GDPR tombstone, set once the user has been erased. */
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
    /** Resolved by the API at read time; absent from an older API. */
    operatorEmail?: string | null;
    reason: string | null;
    startedAt: string;
    endedAt: string | null;
    ip: string | null;
  }>;
}

export interface CreditLedgerRow {
  id: string;
  delta: number;
  reason: 'PURCHASE' | 'GRANT' | 'CONSUME' | 'REFUND' | 'ADJUST';
  balanceAfter: number;
  description: string | null;
  createdAt: string;
}

export interface CreditsDto {
  balance: number;
  ledger: CreditLedgerRow[];
}

export interface SubscriptionRow {
  id: string;
  status: string;
  provider: string | null;
  providerSubId: string | null;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
  beneficiaryOrgId: string | null;
  /** Sparse `KIND:key` → value map the operator has layered over the plan. Null when none. */
  entitlementOverrides: Record<string, unknown> | null;
  createdAt: string;
  plan: {
    slug: string;
    name: string;
    kind: string;
    amount: number;
    currency: string;
    interval: string | null;
  };
}

export interface BillingDto {
  subscriptions: SubscriptionRow[];
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

export type DeviceStatus = 'ACTIVE' | 'RELEASED' | 'BLOCKED';

/**
 * `DeviceDtoSchema` in `@rekey.dev/shared-types`. The operator shape, which
 * carries `lastSeenIp` and `blockedReason`, the end-user's own view of the
 * same row omits both.
 */
export interface DeviceRow {
  id: string;
  applicationId: string;
  endUserId: string;
  fingerprint: string;
  label: string | null;
  status: DeviceStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSeenIp: string | null;
  releasedAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

function base(applicationId: string, euid: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}`;
}

/**
 * The end-user row itself. Deliberately keeps the default
 * `interruptOnAccessError`, so an id that is not in this Application renders
 * the not-found page rather than throwing through the layout.
 */
export function getEndUserDetail(applicationId: string, euid: string): Promise<EndUserDetailDto> {
  return apiGet<EndUserDetailDto>(base(applicationId, euid));
}

/**
 * Credits, billing and devices degrade instead of interrupting: a MEMBER whose
 * grant does not cover them, or an application with billing off, must still get
 * the profile. `interruptOnAccessError: false` turns the 403/404 into a thrown
 * `PanelApiError` that the `.catch` absorbs.
 *
 * They resolve to **null on failure, not to an empty value**. The difference is
 * the whole point: an empty result renders "no subscriptions" or "this
 * end-user has never signed in with a device fingerprint", which are claims
 * about the account. A 500, a timeout, or a missing grant is a claim about the
 * request, and stating the first when the second happened tells an operator
 * something false about a customer while they are on a ticket about it.
 *
 * A busy API (429 / 503) is the exception, and is rethrown (`unlessBusy`): it
 * has a better answer than "could not be read", which is "retry in a few
 * seconds", and the error boundary gives it that with an automatic retry.
 */
export function getEndUserCredits(applicationId: string, euid: string): Promise<CreditsDto | null> {
  return apiGet<CreditsDto>(`${base(applicationId, euid)}/credits`, {
    interruptOnAccessError: false,
  }).catch(unlessBusy(() => null));
}

export function getEndUserBilling(applicationId: string, euid: string): Promise<BillingDto | null> {
  return apiGet<BillingDto>(`${base(applicationId, euid)}/billing`, {
    interruptOnAccessError: false,
  }).catch(unlessBusy(() => null));
}

export function getEndUserDevices(
  applicationId: string,
  euid: string,
  opts: { status?: DeviceStatus; limit: number; offset?: number },
): Promise<Page<DeviceRow> | null> {
  const q = new URLSearchParams({
    limit: String(opts.limit),
    offset: String(opts.offset ?? 0),
  });
  if (opts.status) q.set('status', opts.status);
  return apiGet<Page<DeviceRow>>(`${base(applicationId, euid)}/devices?${q.toString()}`, {
    interruptOnAccessError: false,
  }).catch(unlessBusy(() => null));
}

/** One live refresh token, as the operator sessions route returns it. */
export interface SessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  deviceId: string | null;
}

/**
 * Live sessions for one end-user. Null on failure, for the same reason the
 * others are: "no open sessions" is a claim about the account and a failed read
 * is not.
 */
export function getEndUserSessions(
  applicationId: string,
  euid: string,
): Promise<Page<SessionRow> | null> {
  return apiGet<Page<SessionRow>>(`${base(applicationId, euid)}/sessions?limit=50`, {
    interruptOnAccessError: false,
  }).catch(unlessBusy(() => null));
}

/**
 * Just the counts, for the Overview tiles. Asks for one row and reads
 * `page.total`, which is the count matching the filter rather than the count
 * returned, so this stays exact for a user with more devices than a page.
 *
 * Null if any of the three failed: three tiles disagreeing about whether the
 * device list is reachable is worse than one tile saying it is not.
 */
export async function getEndUserDeviceCounts(
  applicationId: string,
  euid: string,
): Promise<{ active: number; total: number; blocked: number } | null> {
  const [all, active, blocked] = await Promise.all([
    getEndUserDevices(applicationId, euid, { limit: 1 }),
    getEndUserDevices(applicationId, euid, { status: 'ACTIVE', limit: 1 }),
    getEndUserDevices(applicationId, euid, { status: 'BLOCKED', limit: 1 }),
  ]);
  if (all === null || active === null || blocked === null) return null;
  return { total: all.page.total, active: active.page.total, blocked: blocked.page.total };
}

/**
 * What the last Overview support action did, in a short-lived cookie rather
 * than the URL.
 *
 * "Send password reset" reported nothing at all: the action ran, recorded
 * `end_user.password_reset_sent` and redirected to `?support=reset-sent`, and
 * on a production build that navigation is never committed, so the render
 * that would have shown the banner never happened (rekey issue #569, still
 * open). The dialog just sat there. Carrying the outcome in a cookie means the
 * banner does not depend on that navigation: the page re-renders in place
 * after the action (ActionForm retries that render until it commits) and the
 * result is waiting for it.
 *
 * Only the Overview actions write it, because only Overview reads it. An
 * action that redirects to another tab would otherwise leave a flash here that
 * the operator meets later, attached to nothing they just did.
 */
export const SUPPORT_FLASH_COOKIE = 'rekey_support_flash';
/**
 * Long enough to outlive the re-render that reads it, short enough that a
 * refresh a moment later is not told about it again. A Server Component may
 * read cookies but not write them, so it cannot be cleared on read and the
 * TTL is the whole mechanism.
 */
export const SUPPORT_FLASH_MAX_AGE = 20;

/** The outcome of the last Overview support action, if this render follows one. */
export async function readSupportFlash(): Promise<{ done?: string; error?: string }> {
  const raw = (await cookies()).get(SUPPORT_FLASH_COOKIE)?.value;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { done, error } = parsed as Record<string, unknown>;
    return {
      ...(typeof done === 'string' && done !== '' ? { done } : {}),
      ...(typeof error === 'string' && error !== '' ? { error } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Brute-force policy the API applies to end-user password sign-in
 * (`LOGIN_POLICY` in `apps/api/src/lib/brute-force.ts`): 10 failures in a
 * 15-minute window → a 15-minute lock. Mirrored here purely so the counter has
 * a denominator, "Failed sign-in attempts: 7" is unanswerable without knowing
 * what trips the lock.
 */
export const LOGIN_LOCK_THRESHOLD = 10;
export const LOGIN_LOCK_MINUTES = 15;

/**
 * How many of one end-user's events a page reads.
 *
 * 200 is the API's `limit` ceiling. Since `?endUserId=` these are 200 of THIS
 * user's events, newest first, not 200 of the whole application's, which is
 * what the three-scan workaround below this used to read.
 */
export const AUTH_EVENT_SCAN = 200;
export const AUTH_EVENTS_SHOWN = 20;

/**
 * A fingerprint is opaque to Rekey: it is whatever the customer's client
 * computed, stored verbatim, and never parsed or compared piecewise. It is also
 * frequently a 64-character hash, which is unreadable in a table cell and
 * useless truncated in the middle. Show the leading run, which is what an
 * operator matches against a support ticket, and keep the full value in a
 * `title` and behind a copy button.
 */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.length <= 20 ? fingerprint : `${fingerprint.slice(0, 20)}…`;
}

/**
 * Every recorded event about ONE end-user, from any actor.
 *
 * An end-user's own events name them as the actor; everything an operator or
 * the system does TO them names them in `metadata.endUserId` instead. The API
 * derives one `subject_end_user_id` from those at write time and filters on it
 * with `?endUserId=`, so this is one indexed read.
 *
 * It replaces three reads of the application's latest 200 events, one per
 * actor type, because filtering on `actorType=end_user` alone silently dropped
 * every operator action taken on the person, matched in memory. That was 600
 * rows fetched to render twenty on every view of the end-user screen, and it
 * missed a quiet user's history entirely on a busy application.
 *
 * Still capped at the API's 200, newest first, so an empty result means
 * "nothing in this user's latest 200", which on a single user is effectively
 * everything; the pages no longer need to caveat it.
 *
 * The endpoint is OWNER/ADMIN-only, so a MEMBER gets 403 and this degrades to
 * no timeline rather than a 403 page.
 */
export async function getEndUserEvents(
  applicationId: string,
  euid: string,
): Promise<SecurityEventRow[] | null> {
  const q = new URLSearchParams({
    applicationId,
    endUserId: euid,
    limit: String(AUTH_EVENT_SCAN),
  });
  const page = await apiGet<Page<SecurityEventRow>>(
    `/api/v1/tenant/security-events?${q.toString()}`,
    { interruptOnAccessError: false },
  ).catch(unlessBusy(() => null));
  // Newest first is the API's default order; nothing to merge or dedupe.
  return page?.items ?? null;
}

/**
 * Was this account created by a billing event rather than a sign-up?
 *
 * `billing/subscriber.service.ts` creates an end-user when an event names a
 * buyer Rekey has never seen, so a sale can land before the person ever signs
 * in. The row it writes has no password and an email it marks verified on the
 * provider's word, which on screen is indistinguishable from an abandoned
 * sign-up.
 *
 * The row itself carries nothing to read, `endUser.create` there sets no
 * `metadata`, but the creation is recorded as a security event, so that is
 * what this reads, out of the timeline that has already been fetched. A hit is
 * a fact; a miss means "not in the scanned window", which is why the caller
 * renders nothing rather than asserting "signed up".
 */
export interface Provenance {
  provider: string | null;
  at: string;
}

export function provenanceFrom(events: SecurityEventRow[] | null): Provenance | null {
  const hit = events?.find((e) => e.type === 'end_user.created_by_billing_webhook');
  if (!hit) return null;
  return {
    provider: typeof hit.metadata.provider === 'string' ? hit.metadata.provider : null,
    at: hit.createdAt,
  };
}
