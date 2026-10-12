import * as React from 'react';
import { BILLING_EVENT_TYPES } from '@rekey.dev/shared-types';
import Link from '@/components/Link';
import { getApplication } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { BillingLogTable } from '@/components/BillingLogTable';
import { EmptyState } from '@/components/EmptyState';
import { fieldInputCls } from '@/components/Field';
import { EVENT_COPY, EVENT_GROUP_LABEL, type EventGroup } from '@/lib/billing-events';
import { LOG_VIEWS, emptyLogState, emptyPageNeedsWholeLogRead, hasNarrowing, logHrefQuery, readLogFilters, type LogFilters } from '@/lib/billing-log';
import { billingLogHasEntries, getBillingLog } from './shared';

const GROUP_ORDER: EventGroup[] = ['money', 'refusal', 'configuration', 'diagnostic'];

const buttonCls =
  'rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';

/** What the log is narrowed to by a link from another page, which the form has no field for. */
function scopeNote(filters: LogFilters): string | null {
  if (filters.paymentId) return `Entries that name payment ${filters.paymentId}.`;
  if (filters.subscriptionId) return `Entries that name subscription ${filters.subscriptionId}.`;
  if (filters.endUserId) return `Entries about end user ${filters.endUserId}.`;
  return null;
}

export default async function BillingLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const filters = readLogFilters(await searchParams);
  const base = `/applications/${id}/billing-log`;

  const app = await getApplication(id);
  if (!app.billingConfig.enabled) return <BillingDisabledState applicationId={id} />;

  const page = await getBillingLog(id, filters);
  const scope = scopeNote(filters);
  const narrowed = hasNarrowing(filters) || filters.view !== 'activity';
  // One more read, and only for an empty page: whether the log itself is empty.
  const empty =
    page !== null && page.entries.length === 0
      ? emptyLogState(filters, emptyPageNeedsWholeLogRead(filters) ? await billingLogHasEntries(id) : null)
      : null;

  return (
    <div className="space-y-5">
      <form className="flex flex-wrap items-end gap-2" aria-label="Filter the billing log">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">Show</span>
          <select name="view" defaultValue={filters.view} className={fieldInputCls}>
            {LOG_VIEWS.map((view) => (
              <option key={view.value} value={view.value}>
                {view.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">One kind of event</span>
          <select name="type" defaultValue={filters.type ?? ''} className={fieldInputCls}>
            <option value="">Any in the view</option>
            {GROUP_ORDER.map((group) => (
              <optgroup key={group} label={EVENT_GROUP_LABEL[group]}>
                {BILLING_EVENT_TYPES.filter((type) => EVENT_COPY[type].group === group).map((type) => (
                  <option key={type} value={type}>
                    {EVENT_COPY[type].title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">Currency</span>
          <input
            name="currency"
            defaultValue={filters.currency ?? ''}
            maxLength={3}
            placeholder="Any"
            autoComplete="off"
            className={`${fieldInputCls} w-24 font-mono uppercase`}
          />
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">From</span>
          <input type="date" name="from" defaultValue={filters.from ?? ''} className={fieldInputCls} />
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">To</span>
          <input type="date" name="to" defaultValue={filters.to ?? ''} className={fieldInputCls} />
        </label>
        {filters.endUserId && <input type="hidden" name="endUserId" value={filters.endUserId} />}
        {filters.subscriptionId && <input type="hidden" name="subscriptionId" value={filters.subscriptionId} />}
        {filters.paymentId && <input type="hidden" name="paymentId" value={filters.paymentId} />}
        <button type="submit" className={buttonCls}>
          Apply
        </button>
        {narrowed && (
          <Link href={base} className="px-1 py-2 text-sm text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]">
            Clear filters
          </Link>
        )}
      </form>

      {scope && (
        <p className="text-sm text-[var(--color-muted-fg)]">
          {scope}{' '}
          <Link href={`${base}${logHrefQuery({ view: filters.view })}`} className="underline hover:text-[var(--color-fg)]">
            Show the whole log
          </Link>
        </p>
      )}

      {page === null ? (
        <EmptyState
          variant="inline"
          title="The billing log could not be read"
          description="The request failed. Reload the page to try again. Nothing in the log is changed by reading it."
        />
      ) : empty !== null ? (
        <EmptyState
          variant="inline"
          title={empty.title}
          description={empty.description}
          action={
            empty.offerEverything ? (
              <Link href={`${base}${logHrefQuery({ view: 'all' })}`} className={buttonCls}>
                Show everything
              </Link>
            ) : undefined
          }
        />
      ) : (
        <BillingLogTable entries={page.entries} actors={page.actors} applicationId={id} caption="Billing log, newest first" />
      )}

      {page !== null && (filters.cursor || page.nextCursor) && (
        <nav aria-label="Billing log pages" className="flex flex-wrap items-center gap-2">
          {filters.cursor && (
            <Link href={`${base}${logHrefQuery(filters)}`} className={buttonCls}>
              Back to newest
            </Link>
          )}
          {page.nextCursor && (
            <Link href={`${base}${logHrefQuery(filters, page.nextCursor)}`} className={buttonCls}>
              Load older
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
