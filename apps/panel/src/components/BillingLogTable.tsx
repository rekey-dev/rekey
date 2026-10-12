import * as React from 'react';
import type { BillingLogEntry } from '@rekey.dev/shared-types';
import Link from '@/components/Link';
import { Badge } from '@/components/Badge';
import { Modal } from '@/components/Modal';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { actorLabel, EVENT_COPY, eventFields, eventMoney, eventSentence } from '@/lib/billing-events';
import { actorPerson, customerLabel, type LogActors, type ReadEntry } from '@/lib/billing-log';
import { formatDateTime } from '@/lib/date';

const linkCls =
  'rounded text-[var(--color-fg)] underline decoration-[var(--color-border)] underline-offset-2 hover:decoration-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';
const detailsTrigger =
  'cursor-pointer rounded text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';

/** The records an entry names, as links to where each one is shown. */
function linkedRecords(entry: BillingLogEntry, applicationId: string): Array<{ label: string; href: string; id: string }> {
  const base = `/applications/${applicationId}`;
  const links: Array<{ label: string; href: string; id: string }> = [];
  if (entry.endUserId) links.push({ label: 'End user', href: `${base}/end-users/${entry.endUserId}/subscriptions`, id: entry.endUserId });
  if (entry.paymentId) links.push({ label: 'Payment', href: `${base}/payments/${entry.paymentId}`, id: entry.paymentId });
  if (entry.subscriptionId) {
    links.push({
      label: 'Subscription history',
      href: `${base}/billing-log?view=all&subscriptionId=${encodeURIComponent(entry.subscriptionId)}`,
      id: entry.subscriptionId,
    });
  }
  if (entry.couponId) links.push({ label: 'Coupons', href: `${base}/coupons`, id: entry.couponId });
  if (entry.planId) links.push({ label: 'Plans', href: `${base}/plans`, id: entry.planId });
  return links;
}

function EntryDetail({
  entry,
  applicationId,
  actors,
}: {
  entry: BillingLogEntry;
  applicationId: string;
  actors: LogActors;
}): React.JSX.Element {
  const person = actorPerson(actors, entry.actor);
  const copy = EVENT_COPY[entry.type];
  const fields = eventFields(entry);
  const links = linkedRecords(entry, applicationId);
  const ids: Array<[string, string | null]> = [
    ['Provider', entry.provider],
    ['Provider event id', entry.providerEventId],
    ['Checkout session id', entry.checkoutSessionId],
    ['Refund id', entry.refundId],
    ['Price id', entry.planPriceId],
  ];
  return (
    <div className="space-y-4 text-sm">
      <p className="text-[var(--color-fg)]">{eventSentence(entry)}.</p>
      <p className="text-xs text-[var(--color-muted-fg)]">
        <span className="font-medium text-[var(--color-fg)]">{copy.title}.</span> {copy.description}
      </p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
        <dt className="text-xs text-[var(--color-muted-fg)]">When it happened</dt>
        <dd>{formatDateTime(entry.occurredAt)}</dd>
        <dt className="text-xs text-[var(--color-muted-fg)]">Caused by</dt>
        <dd>
          {actorLabel(entry.actor)}
          {person && (
            <span className="ml-1.5">
              {person.name}
              {person.email && <span className="ml-1.5 text-xs text-[var(--color-muted-fg)]">{person.email}</span>}
            </span>
          )}
          {entry.actor.id && <span className="ml-1.5 font-mono text-xs text-[var(--color-muted-fg)]">{entry.actor.id}</span>}
        </dd>
        {entry.endUserId && (
          <>
            <dt className="text-xs text-[var(--color-muted-fg)]">Customer</dt>
            <dd>{customerLabel(actors, entry.endUserId).text}</dd>
          </>
        )}
        {entry.amount !== null && (
          <>
            <dt className="text-xs text-[var(--color-muted-fg)]">Amount</dt>
            <dd className="font-mono">{eventMoney(entry.amount, entry.currency)}</dd>
          </>
        )}
        {fields.map((item) => (
          <React.Fragment key={item.label}>
            <dt className="text-xs text-[var(--color-muted-fg)]">{item.label}</dt>
            <dd className="break-words">{item.value}</dd>
          </React.Fragment>
        ))}
        {ids.map(([label, value]) =>
          value ? (
            <React.Fragment key={label}>
              <dt className="text-xs text-[var(--color-muted-fg)]">{label}</dt>
              <dd className="break-all font-mono text-xs">{value}</dd>
            </React.Fragment>
          ) : null,
        )}
      </dl>
      {links.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-[var(--color-fg)]">Linked records</h3>
          <ul className="mt-1 space-y-1">
            {links.map((link) => (
              <li key={link.label}>
                <Link href={link.href} className={linkCls}>
                  {link.label}
                </Link>
                <span className="ml-1.5 font-mono text-xs text-[var(--color-muted-fg)]">{link.id}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]">
          Raw entry ({entry.type}, sequence {entry.seq}, kept{' '}
          {entry.tier === 'PERMANENT' ? 'for the life of the Application' : 'for 90 days'})
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-xs">
          {JSON.stringify(entry, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * Billing log entries as a table, newest first: when, what happened in a
 * sentence, who it was about, the amount, and who caused it. Each row opens
 * the entry's detail. Used by the log itself and by the trails embedded on
 * the payment and end-user pages.
 *
 * The customer and the operator are written by email and name where the page
 * resolved them, and by id where it did not.
 */
export function BillingLogTable({
  entries,
  actors,
  applicationId,
  caption,
  showCustomer = true,
}: {
  entries: readonly ReadEntry[];
  /** Who the ids on the page are, from the same read as `entries`. */
  actors: LogActors;
  applicationId: string;
  /** Read out for the table, such as "Billing history of this payment". */
  caption: string;
  /** Off on a page that is already about one end user. */
  showCustomer?: boolean;
}): React.JSX.Element {
  return (
    <Table minWidth={showCustomer ? 'min-w-[60rem]' : 'min-w-[48rem]'}>
      <caption className="sr-only">{caption}</caption>
      <THead>
        <TR>
          <TH>When</TH>
          <TH>What happened</TH>
          {showCustomer && <TH>Customer</TH>}
          <TH align="right">Amount</TH>
          <TH>By</TH>
          <TH align="right">
            <span className="sr-only">Details</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {entries.map((read) => {
          if (!read.known) {
            return (
              <TR key={`unknown-${read.seq}`} className="align-top">
                <TD muted className="whitespace-nowrap text-xs">{read.occurredAt ? formatDateTime(read.occurredAt) : ''}</TD>
                <TD colSpan={showCustomer ? 4 : 3} className="text-sm">
                  An entry of a kind this panel cannot describe yet: <code className="font-mono text-xs">{read.type}</code>
                </TD>
                <TD align="right">
                  <Modal size="lg" title="Raw entry" trigger="Details" triggerClassName={detailsTrigger}>
                    <pre className="max-h-96 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-xs">
                      {JSON.stringify(read.raw, null, 2)}
                    </pre>
                  </Modal>
                </TD>
              </TR>
            );
          }
          const customer = read.entry.endUserId ? customerLabel(actors, read.entry.endUserId) : null;
          const person = actorPerson(actors, read.entry.actor);
          return (
            <TR key={read.entry.seq} hover className="align-top">
              <TD muted className="whitespace-nowrap text-xs">{formatDateTime(read.entry.occurredAt)}</TD>
              <TD>
                <span className="block max-w-[28rem] text-sm">{eventSentence(read.entry)}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted-fg)]">
                  {EVENT_COPY[read.entry.type].title}
                  {EVENT_COPY[read.entry.type].group === 'refusal' && <Badge tone="warning">refusal</Badge>}
                  {read.entry.type === 'checkout.price_fallback' && <Badge tone="warning">default price used</Badge>}
                </span>
              </TD>
              {showCustomer && (
                <TD className="text-xs">
                  {read.entry.endUserId && customer ? (
                    <Link
                      href={`/applications/${applicationId}/end-users/${read.entry.endUserId}/subscriptions`}
                      className={`${linkCls} ${customer.isId ? 'font-mono' : 'break-all'}`}
                      title={read.entry.endUserId}
                    >
                      {customer.text}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-muted-fg)]">none</span>
                  )}
                </TD>
              )}
              <TD align="right" mono>{eventMoney(read.entry.amount, read.entry.currency) ?? ''}</TD>
              <TD className="text-xs">
                {person ? (
                  <span title={read.entry.actor.id ?? undefined}>
                    {person.name}
                    <span className="block text-[11px] text-[var(--color-muted-fg)]">{person.email ?? actorLabel(read.entry.actor)}</span>
                  </span>
                ) : (
                  <>
                    {actorLabel(read.entry.actor)}
                    {read.entry.actor.id && (read.entry.actor.type === 'operator' || read.entry.actor.type === 'end_user') && (
                      <span className="block font-mono text-[11px] text-[var(--color-muted-fg)]" title={read.entry.actor.id}>
                        {read.entry.actor.id}
                      </span>
                    )}
                  </>
                )}
                {read.entry.provider && (
                  <span className="block text-[11px] text-[var(--color-muted-fg)]">{read.entry.provider}</span>
                )}
              </TD>
              <TD align="right">
                <Modal
                  size="lg"
                  title={EVENT_COPY[read.entry.type].title}
                  trigger={
                    <>
                      Details<span className="sr-only">: {eventSentence(read.entry)}</span>
                    </>
                  }
                  triggerClassName={detailsTrigger}
                >
                  <EntryDetail entry={read.entry} applicationId={applicationId} actors={actors} />
                </Modal>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
