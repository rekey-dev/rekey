/**
 * End-user Overview, the triage tab.
 *
 * The question this screen answers is "what is going on with this account",
 * asked by someone holding a support ticket. So it is four numbers and a
 * timeline, each linking to the tab where you can act on it, rather than a wall
 * of every field Rekey stores. The detail lives one click away in the tab it
 * belongs to.
 *
 * The tiles are the four things a ticket is ever about: what they are paying
 * for, how many machines they are on, what they have left to spend, and whether
 * they can get in.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { getApplication } from '@/lib/api';
import { actorLabel, humanizeEventType } from '@/lib/security-events';
import { formatDate, formatDateTime } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { Card, SectionHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';
import { SupportFeedback } from './support-feedback';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/Field';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import {
  releaseAllDevices,
  revokeAllSessions,
  sendPasswordReset,
  sendVerification,
  unlockAccount,
} from './actions';
import {
  getEndUserBilling,
  getEndUserCredits,
  getEndUserDetail,
  getEndUserDeviceCounts,
  getEndUserEvents,
  provenanceFrom,
  readSupportFlash,
  LOGIN_LOCK_THRESHOLD,
  LOGIN_LOCK_MINUTES,
} from './shared';

/** Statuses that mean "this subscriber is entitled right now". */
const LIVE_SUBSCRIPTION = new Set(['ACTIVE', 'PAST_DUE', 'TRIALING']);

const OVERVIEW_EVENTS_SHOWN = 5;

export default async function EndUserOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  // The URL first, then the cookie the action left behind. The support forms
  // below do not rely on the action's redirect committing (rekey issue #569):
  // the page re-renders in place, and that render may carry no query to read.
  const flash = await readSupportFlash();
  const done = typeof sp.support === 'string' ? sp.support : flash.done;
  const supportError = typeof sp.supportError === 'string' ? sp.supportError : flash.error;
  const [detail, application, billing, credits, devices, events] = await Promise.all([
    getEndUserDetail(id, euid),
    getApplication(id),
    getEndUserBilling(id, euid),
    getEndUserCredits(id, euid),
    getEndUserDeviceCounts(id, euid),
    getEndUserEvents(id, euid),
  ]);

  const base = `/applications/${id}/end-users/${euid}`;
  const provenance = provenanceFrom(events);

  const lockedUntil = detail.endUser.lockedUntil ? new Date(detail.endUser.lockedUntil) : null;
  const lockedNow = lockedUntil !== null && lockedUntil > new Date();

  const live = billing?.subscriptions.find((s) => LIVE_SUBSCRIPTION.has(s.status));
  /**
   * Free-tier fallback: the plan whose FEATURE entitlements apply to a user
   * with no subscription. Read-time only, no Subscription row stands behind
   * it, which is exactly why an operator looking at an empty subscriptions list
   * needs telling that the user is nonetheless on a plan.
   *
   * This is the plan, not the resolved entitlement set: per-subscription
   * overrides are not in this response and are not reflected here.
   */
  const defaultPlanSlug = application.billingConfig.defaultPlanSlug ?? null;

  const planValue = billing === null ? '—' : live ? live.plan.name : (defaultPlanSlug ?? 'None');
  const planFooter = live
    ? `${formatMoney(live.plan.amount, live.plan.currency)}${
        live.plan.interval ? ` / ${live.plan.interval.toLowerCase()}` : ''
      } · ${live.status.toLowerCase()}`
    : billing === null
      ? 'billing could not be read'
      : defaultPlanSlug
        ? "the application's default plan, no subscription"
        : 'no subscription and no default plan';

  return (
    <div className="space-y-5">
      <Card className="space-y-3">
        <SectionHeader
          title="Profile"
          action={
            <span className="text-xs text-[var(--color-muted-fg)]">
              Joined {formatDate(detail.endUser.createdAt)}
            </span>
          }
        />
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-[var(--color-muted-fg)]">Email</dt>
            <dd className="flex items-center gap-2 text-[var(--color-fg)]">
              <span className="truncate">{detail.endUser.email}</span>
              {detail.endUser.emailVerified ? (
                <Badge tone="success" dot>
                  verified
                </Badge>
              ) : (
                <Badge tone="warning">unverified</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Role</dt>
            <dd>
              <Badge tone="neutral" mono>
                {detail.endUser.role}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Origin</dt>
            <dd>
              {/* A hit is a fact. A miss is NOT "signed up": `provenanceFrom`
                  returns null just as readily because the operator is a MEMBER
                  and cannot read security events at all, or because the
                  creation fell outside the scanned window on a busy
                  application. Asserting "sign-up" there would state the exact
                  thing this field exists to stop somebody assuming, and would
                  do it every single time for a MEMBER. */}
              {provenance ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Badge tone="info">billing event</Badge>
                  <span className="text-xs text-[var(--color-muted-fg)]">
                    {provenance.provider ? `${provenance.provider}, ` : ''}
                    {formatDate(provenance.at)}
                  </span>
                </span>
              ) : (
                <span
                  className="text-xs text-[var(--color-muted-fg)]"
                  title={
                    events === null
                      ? 'Listing security events requires the OWNER or ADMIN workspace role, so this cannot be determined for your role.'
                      : "No creation event for this end-user in the application's most recent events. That is not evidence they signed up: the record may simply be older than the scanned window."
                  }
                >
                  {events === null ? 'not visible to your role' : 'not in the scanned window'}
                </span>
              )}
            </dd>
          </div>
        </dl>
        {provenance && (
          <p className="text-[11px] text-[var(--color-muted-fg)]">
            Created from a billing event rather than a sign-up, so it may carry no password and an
            address verified on the provider&apos;s word. That is expected, not a broken
            registration.
          </p>
        )}
      </Card>

      <SupportBar
        applicationId={id}
        euid={euid}
        erased={detail.endUser.erasedAt !== null}
        emailVerified={detail.endUser.emailVerified}
        done={done}
        error={supportError}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile title="Plan" value={planValue} footer={planFooter} href={`${base}/subscriptions`} />
        {/* A tile shows a dash rather than "0" when the read failed. Zero is a
            statement about the account; the request having failed is not. */}
        <StatTile
          title="Devices"
          value={devices === null ? '—' : String(devices.active)}
          footer={
            devices === null
              ? 'device list could not be read'
              : devices.total === devices.active
                ? plural(devices.active, 'active device')
                : `${devices.active} active of ${devices.total} known${
                    devices.blocked > 0 ? ` · ${devices.blocked} blocked` : ''
                  }`
          }
          href={`${base}/devices`}
          tone={devices !== null && devices.blocked > 0 ? 'warn' : undefined}
        />
        <StatTile
          title="Credits"
          value={credits === null ? '—' : String(credits.balance)}
          footer={
            credits === null
              ? 'credit balance could not be read'
              : plural(credits.ledger.length, 'recent entry', 'recent entries')
          }
          href={`${base}/credits`}
        />
        <StatTile
          title="Sign-in"
          value={lockedNow ? 'Locked' : 'OK'}
          footer={
            lockedNow
              ? `locked until ${formatDateTime(lockedUntil)}`
              : detail.endUser.failedSignInAttempts > 0
                ? `${detail.endUser.failedSignInAttempts} of ${LOGIN_LOCK_THRESHOLD} failures this window`
                : `no failures · ${LOGIN_LOCK_THRESHOLD} locks it for ${LOGIN_LOCK_MINUTES} min`
          }
          href={`${base}/security`}
          tone={lockedNow ? 'warn' : undefined}
        />
      </div>

      <section className="space-y-3">
        <SectionHeader
          title="Recent activity"
          description="Newest first, across events this user caused and events an operator caused on them."
          action={
            <Link
              href={`${base}/security`}
              className="text-xs text-[var(--color-muted-fg)] underline underline-offset-2 hover:text-[var(--color-fg)]"
            >
              All activity →
            </Link>
          }
        />
        {events === null ? (
          <EmptyState
            variant="inline"
            title="Activity is not visible to your role"
            description="Listing security events requires the OWNER or ADMIN workspace role."
          />
        ) : events.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No recorded events"
            description="Nothing for this user in the application's most recent events. Failed sign-ins are counted in Redis and never written as events, so they cannot appear here."
          />
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-[var(--color-border)]">
              {events.slice(0, OVERVIEW_EVENTS_SHOWN).map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate text-sm text-[var(--color-fg)]">
                    {humanizeEventType(e.type)}
                    {/* Who, when it was not this user: operators by email. */}
                    {e.actorType !== 'end_user' || e.actorId !== euid ? (
                      <span className="ml-2 text-xs text-[var(--color-muted-fg)]" title={e.actorId ?? undefined}>
                        {actorLabel(e, euid)}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-xs text-[var(--color-muted-fg)]">
                    {formatDateTime(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

/** Compact metric tile, same pattern as the Revenue and app Overview tiles. */
function StatTile({
  title,
  value,
  footer,
  href,
  tone,
}: {
  title: string;
  value: string;
  footer: string;
  href: string;
  tone?: 'warn' | undefined;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-neutral-400 dark:hover:border-neutral-600"
    >
      <span className="text-xs text-neutral-600 dark:text-neutral-500">{title}</span>
      <span
        className={`truncate text-2xl font-semibold tabular-nums ${
          tone === 'warn' ? 'text-amber-600 dark:text-amber-500' : ''
        }`}
        title={value}
      >
        {value}
      </span>
      <span className="text-xs leading-snug text-[var(--color-muted-fg)]">{footer}</span>
    </Link>
  );
}

/**
 * The support bar: one row of controls, each one API call.
 *
 * This is the part that was missing entirely. Before it, an operator holding
 * "I cannot sign in" could read a lockout counter and a device list and act on
 * neither: every actual remedy needed a developer with an API client.
 *
 * The two that put mail in somebody's inbox are dialogs rather than bare
 * buttons, and the reset asks for a reason, because at the recipient's end an
 * unrequested reset mail and an attacker who reached the panel look the same.
 */
function SupportBar({
  applicationId,
  euid,
  erased,
  emailVerified,
  done,
  error,
}: {
  applicationId: string;
  euid: string;
  erased: boolean;
  emailVerified: boolean;
  done?: string | undefined;
  error?: string | undefined;
}): React.JSX.Element | null {
  // Every one of these is refused on a tombstone by the API. Rendering them
  // would offer an operator a row of buttons that all answer 410.
  if (erased) return null;

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">Support actions</h3>
        <p className="text-xs text-[var(--color-muted-fg)]">
          The common remedies, applied to this end-user. Each one is recorded in the activity trail
          with your operator id.
        </p>
      </div>

      <SupportFeedback done={done} error={error} />

      <div className="flex flex-wrap items-center gap-2">
        <ActionForm action={unlockAccount.bind(null, applicationId, euid)}>
          <SubmitButton className={supportBtnCls} pendingLabel="Unlocking…">
            Unlock account
          </SubmitButton>
        </ActionForm>

        {!emailVerified && (
          <Modal
            title="Re-send the verification email"
            description="Mints a fresh verification token and sends the email again, through this Application's configured transport."
            trigger="Resend verification"
            triggerClassName={supportBtnCls}
          >
            <ActionForm
              action={sendVerification.bind(null, applicationId, euid)}
              className="space-y-3"
            >
              <Field label="Reason" hint="Optional, recorded in the activity trail.">
                <input
                  type="text"
                  name="reason"
                  maxLength={280}
                  placeholder="customer says it never arrived"
                  className={supportInputCls}
                />
              </Field>
              <SubmitButton pendingLabel="Sending…">Send verification email</SubmitButton>
            </ActionForm>
          </Modal>
        )}

        <Modal
          title="Send a password-reset email"
          description="Starts the same reset the end-user's own forgot-password link starts. The token goes to them, never to you."
          trigger="Send password reset"
          triggerClassName={supportBtnCls}
        >
          <ActionForm
            action={sendPasswordReset.bind(null, applicationId, euid)}
            className="space-y-3"
          >
            <Banner tone="warning">
              They did not ask for this. At their inbox it is indistinguishable from someone who got
              into your panel, so the reason below is recorded against your operator id.
            </Banner>
            <Field label="Reason" required hint="Recorded in the activity trail.">
              <input
                type="text"
                name="reason"
                required
                maxLength={280}
                placeholder="locked out, identity verified on call"
                className={supportInputCls}
              />
            </Field>
            <SubmitButton pendingLabel="Sending…">Send reset email</SubmitButton>
          </ActionForm>
        </Modal>

        <ActionForm action={releaseAllDevices.bind(null, applicationId, euid)}>
          <ConfirmButton
            variant="subtle"
            title="Release every device?"
            confirm="Frees every active device slot and signs them out on those machines, so their next sign-in from any machine is admitted. Blocked devices are left blocked."
            confirmLabel="Release all devices"
          >
            Reset devices
          </ConfirmButton>
        </ActionForm>

        <ActionForm action={revokeAllSessions.bind(null, applicationId, euid)}>
          <ConfirmButton
            variant="subtle"
            title="Sign out everywhere?"
            confirm="Revokes every live session. Access tokens already issued keep working until they expire. This stops new ones being obtained."
            confirmLabel="Sign out everywhere"
          >
            Sign out everywhere
          </ConfirmButton>
        </ActionForm>
      </div>
    </Card>
  );
}

const supportBtnCls =
  'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

const supportInputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';
