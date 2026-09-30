import * as React from 'react';
import Link from '@/components/Link';
import type { PlanRow } from '@/lib/api';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { RETURN_URL_NOTICE_DAYS } from './shared';

/** Checkouts that returned buyers to an origin this Application never registered. */
export function ReturnUrlNotice({
  applicationId,
  count,
  origins,
}: {
  applicationId: string;
  count: number;
  origins: string[];
}): React.JSX.Element | null {
  if (count === 0) return null;
  return (
    <Banner tone="warning">
      <p className="font-medium">
        {count === 1
          ? `One checkout in the last ${RETURN_URL_NOTICE_DAYS} days returned the buyer to an origin this Application has not registered.`
          : `${count} checkouts in the last ${RETURN_URL_NOTICE_DAYS} days returned buyers to origins this Application has not registered.`}
      </p>
      <p className="mt-1 text-xs">
        They still work today. The next minor release refuses a checkout whose success or cancel URL
        is on an unregistered origin, so{' '}
        <Link className="underline" href={`/applications/${encodeURIComponent(applicationId)}/auth`}>
          add these to the redirect URLs or set the Application URL
        </Link>{' '}
        before upgrading.
      </p>
      {origins.length > 0 && <p className="mt-1.5 font-mono text-[11px]">{origins.join(', ')}</p>}
    </Banner>
  );
}

/**
 * Live plans a buyer cannot pay for. Connecting a provider does not register
 * the plans that already exist, so the operator who just pasted a secret key
 * has every reason to think billing works when it does not.
 */
export function UnbuyablePlansNotice({
  applicationId,
  plans,
  soldExternally,
  checkoutProviderLabels,
  compact = false,
}: {
  applicationId: string;
  plans: PlanRow[];
  soldExternally: boolean;
  checkoutProviderLabels: string[];
  /** One line with a link, for tabs where the full explanation is one click away. */
  compact?: boolean;
}): React.JSX.Element | null {
  if (plans.length === 0) return null;
  if (compact) {
    if (soldExternally) return null;
    return (
      <p
        role="status"
        className="rounded-md border border-[var(--color-danger)] bg-[color-mix(in_srgb,var(--color-danger)_8%,transparent)] px-3 py-2 text-xs text-[var(--color-fg)]"
      >
        {plans.length === 1 ? 'One live plan has' : `${plans.length} live plans have`} no price at your
        payment provider, so buyers cannot pay for{' '}
        <span className="font-mono">{plans.map((p) => p.slug).join(', ')}</span>.{' '}
        <Link className="underline" href={`/applications/${encodeURIComponent(applicationId)}/plans`}>
          Register on the Plans tab
        </Link>
        .
      </p>
    );
  }
  if (soldExternally) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5 text-sm text-[var(--color-fg)]">
        <p className="font-medium">Plans are sold through your external billing system.</p>
        <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
          Rekey checkout is off for{' '}
          {plans.length === 1 ? 'the one live plan' : `all ${plans.length} live plans`}: subscriptions
          are activated by the events that system posts. Connect {checkoutProviderLabels.join(', ')}{' '}
          as well if you also want self-serve checkout here.
        </p>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="rounded-md border border-[var(--color-danger)] bg-[color-mix(in_srgb,var(--color-danger)_8%,transparent)] px-3 py-2.5 text-sm text-[var(--color-fg)]"
    >
      <p className="font-medium">
        {plans.length === 1
          ? 'One live plan is not registered with your payment provider.'
          : `${plans.length} live plans are not registered with your payment provider.`}
      </p>
      <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
        Plans register when they are created, so anything created before these credentials existed
        has no price behind it. It still lists, it is still active, and a buyer who clicks Buy is
        refused. Changing or adding a provider has the same effect on plans that were already there.{' '}
        <Link className="underline" href={`/applications/${encodeURIComponent(applicationId)}/plans`}>
          Register them on the Plans tab
        </Link>
        .
      </p>
      <p className="mt-1.5 font-mono text-[11px] text-[var(--color-muted-fg)]">
        {plans.map((p) => p.slug).join(', ')}
      </p>
    </div>
  );
}

/** What a tab shows in place of controls that only work while billing is on. */
export function BillingOffState({
  applicationId,
  what,
}: {
  applicationId: string;
  what: string;
}): React.JSX.Element {
  return (
    <EmptyState
      title="Billing is off for this application"
      description={`Turn billing on to set up ${what}.`}
      action={
        <Link
          href={`/applications/${applicationId}/billing`}
          className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2"
        >
          Go to Status
        </Link>
      }
    />
  );
}
