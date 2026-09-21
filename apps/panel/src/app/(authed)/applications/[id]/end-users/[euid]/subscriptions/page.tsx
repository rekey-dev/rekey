/**
 * End-user Subscriptions, what they are paying for, what they have paid, and
 * what has been issued to them.
 *
 * An OWNER or ADMIN can grant a subscription here, and cancel one. Granting was
 * super-admin-only until the tenant routes existed, because it is the one
 * billing write that CREATES entitlement on an assertion rather than following
 * money that demonstrably moved, so two things gate that affordance: the
 * operator's role, and `TENANT_SUBSCRIPTION_GRANTS`, which a deployment that
 * sells to the workspaces it hosts sets to `disabled`. Both are checked here
 * for the button and again by the API for the action. Cancelling is gated by
 * role only: it removes entitlement and fails safe.
 *
 * Three things this page has to say that the tables cannot:
 *
 *  - An empty list does not mean "not entitled". An Application with a default
 *    plan resolves FEATURE entitlements for users with no subscription at all,
 *    and no row exists to show for it.
 *  - A subscription carried by an inbound-only provider is managed somewhere
 *    else, and cancelling it here would be refused
 *    (`SUBSCRIPTION_MANAGED_EXTERNALLY`). Said in place of the button rather
 *    than discovered by pressing one.
 *  - Granting is not charging. "Grant subscription" reads to a support agent
 *    like "bill them for a subscription", and the two are opposite mistakes, so
 *    the dialog says outright that no money is collected.
 */

import * as React from 'react';
import Link from '@/components/Link';
import {
  apiGet,
  getApplication,
  getMe,
  getSubscriptionGrantsMode,
  readErrorFlash,
  type PlanRow,
  unlessBusy,
} from '@/lib/api';
import { errorMessage } from '@/lib/error-message';
import { ApiErrorText } from '@/components/api-error';
import { cancelEffect } from '@rekey.dev/shared-types';
import type { Page } from '@/lib/paginate';
import { formatDate, formatDateTime } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { StatusPill } from '@/components/StatusPill';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/Field';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { cancelSubscription, grantSubscription, setEntitlementOverrides } from '../actions';
import { getEndUserBilling, type SubscriptionRow } from '../shared';

/**
 * Providers that host no checkout and only receive events. A subscription on
 * one of these is authoritative somewhere else; Rekey mirrors it.
 */
const INBOUND_ONLY_PROVIDERS = new Set(['external']);

/** Statuses a cancel can still act on. */
const CANCELLABLE = new Set(['ACTIVE', 'PAST_DUE', 'TRIALING', 'PENDING']);

const GRANT_ERR: Record<string, string> = {
  PLAN_REQUIRED: 'Pick a plan.',
  NOTE_REQUIRED: 'Say why this is being granted. It goes in the audit trail.',
  PLAN_NOT_FOUND: 'That plan no longer exists in this Application.',
  BILLING_ORGANIZATION_REQUIRED:
    'This Application bills per organization, so a grant has to name one. Granting to an individual is not possible while the billing subject is “org”.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can grant a subscription.',
  APP_ACCESS_DENIED: 'Your grant on this Application does not allow billing writes.',
  TENANT_SUBSCRIPTION_GRANTS_DISABLED:
    'Operator grants are switched off on this deployment (TENANT_SUBSCRIPTION_GRANTS).',
  ORGANIZATION_NOT_FOUND: 'That organization does not belong to this Application.',
  END_USER_ERASED:
    'This end-user was erased. Nothing can be granted to a tombstone, and an erasure cannot be undone.',
  SUBSCRIPTION_PERIOD_END_IN_PAST: 'The period end has to be in the future.',
};

// Codes with panel copy: the panel's own checks and the access refusals. An
// API refusal of the override itself renders the API's message and fix from
// the error flash instead, since one code covers a dozen distinct causes.
const OVERRIDE_ERR: Record<string, string> = {
  OVERRIDE_EMPTY: 'Add at least one entitlement row.',
  OVERRIDE_KEY_INVALID:
    'Pick a kind, and give the key as up to 64 letters, digits, dots, colons, dashes or underscores.',
  SUBSCRIPTION_NOT_FOUND: 'That subscription no longer exists for this end-user.',
  APP_ACCESS_DENIED: 'Your grant on this Application does not allow billing writes.',
  SCOPE_INSUFFICIENT: 'Your scopes on this workspace do not include billing writes.',
  // ENTITLEMENT_OVERRIDE_INVALID and SUBSCRIPTION_NOT_ENTITLING are deliberately
  // NOT mapped: ApiErrorText shows the API's own message and fix only for a
  // code with no panel copy, and for these two the API's words are the ones
  // that name the actual cause.
};

const CANCEL_ERR: Record<string, string> = {
  SUBSCRIPTION_NOT_FOUND: 'That subscription no longer exists for this end-user.',
  SUBSCRIPTION_MANAGED_EXTERNALLY:
    'This subscription is owned by your own billing system. Cancel it there; Rekey will mirror the event.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can cancel a subscription.',
  APP_ACCESS_DENIED: 'Your grant on this Application does not allow billing writes.',
  PROVIDER_CANCEL_FAILED:
    'The payment provider refused the cancellation. Check the provider dashboard and the Activity log.',
};

export default async function EndUserSubscriptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  const granted = typeof sp.granted === 'string' ? sp.granted : undefined;
  const canceled = typeof sp.canceled === 'string' ? sp.canceled : undefined;
  const grantError = typeof sp.grantError === 'string' ? sp.grantError : undefined;
  const cancelError = typeof sp.cancelError === 'string' ? sp.cancelError : undefined;
  const overridesApplied = typeof sp.overrides === 'string' ? Number(sp.overrides) : null;
  const overridesChanged = sp.changed !== '0';
  const overrideSub = typeof sp.sub === 'string' ? sp.sub : undefined;
  // The overrides dialog is the only form on this page that redirects with
  // `?error=`, and `sub` names the row whose dialog reopens (see Modal).
  const overrideError = overrideSub !== undefined && typeof sp.error === 'string' ? sp.error : undefined;
  const overrideFlash = await readErrorFlash(overrideError);

  const [billing, application, me, grantsMode] = await Promise.all([
    getEndUserBilling(id, euid),
    getApplication(id),
    getMe(),
    getSubscriptionGrantsMode(),
  ]);

  // Both, not either: hiding the affordance is a usability choice, and the API
  // enforces the same floor on its own.
  //
  // Cancel is NOT gated by `grantsMode`. That switch is about the write which
  // creates entitlement; cancelling removes it and fails safe, and the API
  // leaves the cancel route open when the switch is off. Hiding Cancel here
  // would leave a `disabled` deployment unable to cancel from the panel while
  // the operator MCP tool still could.
  const isOperatorAdmin = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  const canGrant = grantsMode === 'enabled' && isOperatorAdmin;
  const canCancel = isOperatorAdmin;
  // Overrides are a billing write with no role floor: OWNER/ADMIN, or a MEMBER
  // holding APP_ADMIN or APP_BILLING on this Application. The panel has no
  // per-application grant helper, so every member sees the control; a viewer's
  // attempt is refused by the API with a mapped message. Hiding it from members
  // would strand the billing role this route exists for.
  const canAdjust = isOperatorAdmin || me.activeRole === 'MEMBER';

  // Only fetched when there is a form to fill. The picker offers active plans;
  // the API accepts withdrawn ones too, but offering the whole historical
  // catalogue in a dropdown is how the wrong one gets picked.
  const plans = canGrant
    ? await apiGet<Page<PlanRow>>(
        `/api/v1/tenant/applications/${encodeURIComponent(id)}/plans?limit=100`,
        { interruptOnAccessError: false },
      )
        .then((p) => p.items.filter((pl) => pl.active))
        .catch(unlessBusy(() => [] as PlanRow[]))
    : [];

  if (billing === null) {
    // Every table on this tab is a claim about what the customer has bought.
    // Rendering three empty ones because the request failed says they have
    // bought nothing, to an operator holding a ticket about a payment.
    return (
      <div className="space-y-4">
        <SectionHeader title="Subscriptions" />
        <Banner tone="error">
          Billing could not be read for this end-user. Either the request failed, or your grant on this
          Application does not cover billing. This is <strong>not</strong> an empty billing history.
          Reload; if it persists, check the API and your access.
        </Banner>
      </div>
    );
  }

  const defaultPlanSlug = application.billingConfig.defaultPlanSlug ?? null;
  const hasExternal = billing.subscriptions.some(
    (s) => s.provider !== null && INBOUND_ONLY_PROVIDERS.has(s.provider),
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeader
          title="Subscriptions"
          count={`(${billing.subscriptions.length})`}
          description="Most recent 100, newest first."
          action={
            canGrant ? (
              <GrantForm
                applicationId={id}
                euid={euid}
                plans={plans}
                error={grantError}
                keptPlanSlug={typeof sp.planSlug === 'string' ? sp.planSlug : undefined}
                keptPeriodEnd={typeof sp.periodEnd === 'string' ? sp.periodEnd : undefined}
              />
            ) : undefined
          }
        />

        {granted === '1' && (
          <Banner tone="success">
            Subscription granted. The plan&apos;s entitlements are live and{' '}
            <code className="font-mono">subscription.activated</code> has been announced to your
            webhook endpoints.
          </Banner>
        )}
        {granted === 'already' && (
          <Banner tone="info">
            Nothing to do: this end-user was already entitled on that plan. Granting again does not
            extend a live period; to move it to a new term, cancel it and grant again.
          </Banner>
        )}
        {canceled === 'period-end' && (
          <Banner tone="success">
            Cancellation scheduled. The subscription keeps entitling until the end of the paid
            period.
          </Banner>
        )}
        {canceled === 'now' && (
          <Banner tone="success">Subscription cancelled immediately. Entitlements are gone.</Banner>
        )}
        {/* `grantError` renders inside the modal, which reopens on it, showing
            it here as well put the same message twice, one copy behind the
            backdrop. */}
        {cancelError && <Banner tone="error">{errorMessage(CANCEL_ERR, cancelError)}</Banner>}
        {overridesApplied !== null && !Number.isNaN(overridesApplied) && overridesChanged && (
          <Banner tone="success">
            {overridesApplied === 1 ? 'One entitlement' : `${overridesApplied} entitlements`} adjusted for
            this subscription. Feature and usage values apply on the next resolve; a credit allowance
            applies at the next renewal, and an already-issued licence keeps its seat count.
          </Banner>
        )}
        {overridesApplied !== null && !Number.isNaN(overridesApplied) && !overridesChanged && (
          <Banner tone="info">
            Nothing changed. The values sent match what this subscription already resolves, or removed
            overrides that were not set.
          </Banner>
        )}
        {/* `overrideError` renders inside the row's dialog, which reopens on it. */}

        {hasExternal && (
          <Banner tone="info">
            One or more of these is carried by an inbound-only provider: your billing system owns it
            and posts events here. Rekey mirrors the status and refuses to cancel it locally.
            Cancel it where it lives.
          </Banner>
        )}

        {billing.subscriptions.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No subscriptions"
            description={
              defaultPlanSlug
                ? `This user still resolves entitlements from the application's default plan (${defaultPlanSlug}). A default plan is read-time only, so there is no row here for it.`
                : 'This user has no subscription, and the application has no default plan, so they resolve no plan entitlements.'
            }
          />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>Plan</TH>
                <TH>Status</TH>
                <TH>Provider</TH>
                <TH>Renews</TH>
                <TH>Started</TH>
                {(canCancel || canAdjust) && <TH align="right"> </TH>}
              </TR>
            </THead>
            <TBody>
              {billing.subscriptions.map((s) => (
                <TR key={s.id} hover>
                  <TD>
                    <span className="font-medium text-[var(--color-fg)]">{s.plan.name}</span>{' '}
                    <span className="font-mono text-xs text-[var(--color-muted-fg)]">
                      {s.plan.slug}
                    </span>
                    {s.beneficiaryOrgId && (
                      <Badge tone="info" className="ml-1.5">
                        team
                      </Badge>
                    )}
                    <div className="text-[11px] text-[var(--color-muted-fg)]">
                      {formatMoney(s.plan.amount, s.plan.currency)}
                      {s.plan.interval ? ` / ${s.plan.interval.toLowerCase()}` : ''}
                    </div>
                    <OverrideChips overrides={s.entitlementOverrides} />
                  </TD>
                  <TD>
                    <StatusPill status={s.status} />
                  </TD>
                  <TD muted className="text-xs">
                    {s.provider ?? '—'}
                    {s.provider !== null && INBOUND_ONLY_PROVIDERS.has(s.provider) && (
                      <div className="text-[11px]">managed externally</div>
                    )}
                  </TD>
                  <TD muted className="text-xs">
                    {s.cancelAt
                      ? `cancels ${formatDate(s.cancelAt)}`
                      : s.currentPeriodEnd
                        ? formatDate(s.currentPeriodEnd)
                        : '—'}
                  </TD>
                  <TD muted className="text-xs">
                    {formatDate(s.createdAt)}
                  </TD>
                  {(canCancel || canAdjust) && (
                    <TD align="right">
                      <div className="flex items-center justify-end gap-2">
                        {canAdjust && (
                          <OverridesForm
                            applicationId={id}
                            euid={euid}
                            subscription={s}
                            error={overrideSub === s.id ? overrideError : undefined}
                            detail={overrideSub === s.id ? overrideFlash.detail : undefined}
                            fix={overrideSub === s.id ? overrideFlash.fix : undefined}
                          />
                        )}
                        {canCancel && <CancelAction applicationId={id} euid={euid} subscription={s} />}
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Payments"
          count={`(${billing.payments.length})`}
          description="Most recent 50, newest first."
        />
        {billing.payments.length === 0 ? (
          <EmptyState variant="inline" title="No payments recorded" />
        ) : (
          <Table minWidth="min-w-[48rem]">
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
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(p.createdAt)}
                  </TD>
                  <TD align="right" mono className="tabular-nums">
                    {formatMoney(p.amount, p.currency)}
                  </TD>
                  <TD>
                    <StatusPill status={p.status} />
                  </TD>
                  <TD muted className="max-w-[12rem] truncate text-xs">
                    {p.description ?? '—'}
                  </TD>
                  <TD muted mono className="max-w-[12rem] truncate text-[11px]">
                    {p.providerPaymentId ?? '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Licenses"
          count={`(${billing.licenses.length})`}
          description="Keys issued to this end-user. Their per-machine activations are a separate capacity pool from devices."
          action={
            billing.licenses.length > 0 ? (
              <Link
                href={`/applications/${id}/licenses`}
                className="text-xs text-[var(--color-muted-fg)] underline underline-offset-2 hover:text-[var(--color-fg)]"
              >
                Activations →
              </Link>
            ) : undefined
          }
        />
        {billing.licenses.length === 0 ? (
          <EmptyState variant="inline" title="No licenses issued" />
        ) : (
          <Table minWidth="min-w-[48rem]">
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
                    {l.organizationId && (
                      <Badge tone="info" className="ml-1.5">
                        team
                      </Badge>
                    )}
                  </TD>
                  <TD muted className="text-xs">
                    {l.plan?.name ?? '—'}
                  </TD>
                  <TD muted className="text-xs">
                    {l.kind.toLowerCase()}
                  </TD>
                  <TD>
                    <StatusPill status={l.status} />
                  </TD>
                  <TD align="right" muted className="text-xs tabular-nums">
                    {l.seatsAllowed ?? '—'}
                  </TD>
                  <TD muted className="text-xs">
                    {l.expiresAt ? formatDate(l.expiresAt) : 'never'}
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

/**
 * Grant a subscription with nothing behind it but the operator's word.
 *
 * The confirmation copy says what it is NOT, no money is collected, nothing is
 * charged, because "grant subscription" reads to a support agent like
 * "charge them for a subscription", and the two are opposite mistakes.
 */
function GrantForm({
  applicationId,
  euid,
  plans,
  error,
  keptPlanSlug,
  keptPeriodEnd,
}: {
  applicationId: string;
  euid: string;
  plans: PlanRow[];
  error?: string | undefined;
  /** Echoed back on a refusal so the form is not lost. The note is not, see `grantSubscription`. */
  keptPlanSlug?: string | undefined;
  keptPeriodEnd?: string | undefined;
}): React.JSX.Element {
  if (plans.length === 0) {
    return (
      <span className="text-xs text-[var(--color-muted-fg)]">
        No active plans to grant.{' '}
        <Link
          href={`/applications/${applicationId}/plans`}
          className="underline underline-offset-2 hover:text-[var(--color-fg)]"
        >
          Create one
        </Link>
      </span>
    );
  }
  return (
    <Modal
      modalKey="grant"
      title="Grant a subscription"
      description="Activates a subscription against a plan with no payment provider behind it: an invoiced sale, a bank transfer, a comped account, a migration off a previous billing system. No money is collected and nothing is charged."
      trigger="Grant subscription"
    >
      <ActionForm action={grantSubscription.bind(null, applicationId, euid)} className="space-y-3">
        {error && <Banner tone="error">{errorMessage(GRANT_ERR, error)}</Banner>}
        <Field label="Plan" required hint="Active plans only. Withdrawn plans can still be granted through the API.">
          <select name="planSlug" required defaultValue={keptPlanSlug ?? ""} className={inputCls}>
            <option value="" disabled>
              Pick a plan…
            </option>
            {plans.map((p) => (
              <option key={p.id} value={p.slug}>
                {p.name} ({formatMoney(p.amount, p.currency)} / {p.interval.toLowerCase()})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Reason"
          required
          hint="Recorded on the subscription and in the security log. Required here even though the API allows it to be omitted: a comped subscription with no stated reason is unauditable six months later."
        >
          <input
            type="text"
            name="note"
            required
            maxLength={500}
            placeholder="paid by bank transfer, INV-4012"
            className={inputCls}
          />
        </Field>
        <Field
          label="Period ends"
          hint="Optional, and open-ended if you leave it blank. A grant does not renew and nothing expires it, so “comp this account” means comped until somebody cancels. Set a date to time-box it. Note that cancelling an open-ended grant takes effect immediately, because there is no paid period left to run out."
        >
          <input
            type="date"
            name="currentPeriodEnd"
            defaultValue={keptPeriodEnd ?? ""}
            min={new Date().toISOString().slice(0, 10)}
            className={inputCls}
          />
        </Field>
        <SubmitButton pendingLabel="Granting…">Grant subscription</SubmitButton>
      </ActionForm>
    </Modal>
  );
}

/** Current overrides as compact chips under the plan name. */
function OverrideChips({ overrides }: { overrides: Record<string, unknown> | null }): React.JSX.Element | null {
  const entries = Object.entries(overrides ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <Badge key={k} tone="warning" className="font-mono text-[10px] font-normal" title="Overrides the plan for this subscription only">
          {k} = {typeof v === 'object' ? JSON.stringify(v) : String(v)}
        </Badge>
      ))}
    </div>
  );
}

const OVERRIDE_ROWS = 3;

/**
 * Adjust what one subscription grants without minting a private plan.
 *
 * The dialog carries the two facts an operator gets wrong: the map is sparse,
 * so only the rows sent change; and already-materialised grants are not
 * retroactive, so a raised credit allowance lands at the next renewal, not now.
 */
function OverridesForm({
  applicationId,
  euid,
  subscription,
  error,
  detail,
  fix,
}: {
  applicationId: string;
  euid: string;
  subscription: SubscriptionRow;
  error?: string | undefined;
  /** The API's own message and fix for `error`, from the error flash. */
  detail?: string | undefined;
  fix?: string | undefined;
}): React.JSX.Element {
  const existing = Object.entries(subscription.entitlementOverrides ?? {});
  return (
    <Modal
      modalKey="sub"
      modalValue={subscription.id}
      title="Adjust entitlements"
      description="Deviate from the plan for this one subscription. Each row names an entitlement the plan already defines and the value this customer gets instead; leave the value empty to remove an override. Feature and usage values apply immediately; a credit allowance applies at the next renewal; an issued licence keeps its seat count."
      trigger="Adjust"
    >
      <ActionForm action={setEntitlementOverrides.bind(null, applicationId, euid, subscription.id)} className="space-y-3">
        {error && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={detail} fix={fix} map={OVERRIDE_ERR} fallback="The API refused the change." />
          </Banner>
        )}
        {existing.length > 0 && (
          <div className="text-xs text-[var(--color-muted-fg)]">
            Currently overridden:{' '}
            {existing.map(([k, v]) => (
              <code key={k} className="mr-1.5 font-mono">
                {k}={String(v)}
              </code>
            ))}
          </div>
        )}
        {Array.from({ length: OVERRIDE_ROWS }).map((_, i) => (
          <div key={i} className="grid grid-cols-[7rem_1fr_1fr] gap-2">
            <select name="kind" defaultValue={i === 0 ? 'FEATURE' : ''} className={inputCls} aria-label="Kind">
              <option value="">kind…</option>
              <option value="FEATURE">FEATURE</option>
              <option value="CREDIT">CREDIT</option>
              <option value="LICENSE">LICENSE</option>
              <option value="USAGE">USAGE</option>
            </select>
            <input type="text" name="key" placeholder="max_devices" className={inputCls} aria-label="Entitlement key" />
            <input type="text" name="value" placeholder="value, or empty to remove" className={inputCls} aria-label="Value" />
          </div>
        ))}
        <p className="text-[11px] text-[var(--color-muted-fg)]">
          Values: a number, <code className="font-mono">true</code>/<code className="font-mono">false</code>, or text; the literal words true, false and null cannot be stored as text. Keys may contain colons. Rows with no key are ignored.
        </p>
        <SubmitButton pendingLabel="Applying…">Apply overrides</SubmitButton>
      </ActionForm>
    </Modal>
  );
}

/**
 * Cancel one subscription.
 *
 * The dialog has to say which cancel it is. A provider-backed subscription is
 * cancelled at the provider; a granted one ends locally; one carried by an
 * inbound-only provider cannot be cancelled here at all, and saying so beats
 * letting the operator discover it from a 409.
 */
function CancelAction({
  applicationId,
  euid,
  subscription,
}: {
  applicationId: string;
  euid: string;
  subscription: SubscriptionRow;
}): React.JSX.Element | null {
  if (!CANCELLABLE.has(subscription.status)) return null;

  if (subscription.provider !== null && INBOUND_ONLY_PROVIDERS.has(subscription.provider)) {
    return (
      <span
        className="text-xs text-[var(--color-muted-fg)]"
        title="Your billing system owns this subscription. Cancel it there and Rekey will mirror the event."
      >
        managed externally
      </span>
    );
  }

  // `cancelEffect` is exported from shared-types for exactly this: one rule,
  // read by the server that applies it and by the UI that has to describe it
  // BEFORE the call is made. Guessing here is how the copy and the behaviour
  // drift apart, and they would have, immediately: a granted subscription is
  // open-ended by default, so `currentPeriodEnd` is null and cancelling it
  // stops access on the spot. "Cancels at the end of the paid period" would
  // have been a promise the button breaks the moment it is pressed.
  const effect = cancelEffect(subscription);
  const timing =
    effect === 'period-end'
      ? `It keeps entitling until ${
          subscription.currentPeriodEnd ? formatDate(subscription.currentPeriodEnd) : 'the end of the paid period'
        }, which is what the end-user's own self-service cancel does to the same row.`
      : 'There is no paid period left to run out, so access stops immediately. Entitlements are revoked the moment you confirm.';
  const where =
    subscription.provider === null
      ? 'No payment provider is behind this subscription, so it ends locally.'
      : `This subscription is carried by ${subscription.provider}, so it is cancelled there too.`;

  return (
    <ActionForm action={cancelSubscription.bind(null, applicationId, euid, subscription.id)}>
      <ConfirmButton
        title={effect === 'period-end' ? 'Cancel at the end of the period?' : 'Cancel immediately?'}
        confirm={`${where} ${timing}`}
        confirmLabel={effect === 'period-end' ? 'Cancel at period end' : 'Cancel now'}
      >
        Cancel
      </ConfirmButton>
    </ActionForm>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';
