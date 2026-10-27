import * as React from 'react';
import Link from '@/components/Link';
import { formatDateTime } from '@/lib/date';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Pager, readOffset, readPageSize } from '@/components/Pager';
import { billingBase, getBillingProviders, getWebhookEvents, providerLabel, type WebhookEventRow } from '../shared';

const STATUS_TONE: Record<WebhookEventRow['status'], BadgeTone> = {
  processed: 'success',
  received: 'warning',
  error: 'danger',
};

function DetailField({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">{label}</div>
      <div className="mt-0.5 break-all text-xs text-[var(--color-fg)]">{children}</div>
    </div>
  );
}

export default async function BillingEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const pageSize = readPageSize(sp);
  const offset = readOffset(sp);
  const [providers, eventPage] = await Promise.all([
    getBillingProviders(id),
    getWebhookEvents(id, { limit: pageSize, offset }),
  ]);
  const events = eventPage.items;

  return (
    <section className="space-y-3" aria-labelledby="billing-events-heading">
      <SectionHeader
        title={<span id="billing-events-heading">Provider webhooks</span>}
        count={eventPage.page.total > 0 ? String(eventPage.page.total) : undefined}
        description={
          <>
            What your payment providers posted to Rekey, such as a subscription starting or a
            payment going through. Newest first. What Rekey did about each one, and why, is in the{' '}
            <Link href={`/applications/${id}/billing-log`} className="underline hover:text-[var(--color-fg)]">
              Billing log
            </Link>
            . The webhooks your app receives from Rekey are under{' '}
            <Link href={`/applications/${id}/webhooks`} className="underline hover:text-[var(--color-fg)]">
              Developer, Webhooks
            </Link>
            .
          </>
        }
      />
      {events.length === 0 && offset > 0 ? (
        <EmptyState variant="inline" title="Nothing on this page" description="Go back a page to see the newest events." />
      ) : events.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No provider events yet"
          description="They appear here once a provider posts to your webhook URL. Set the webhook up on the Providers tab first."
          action={
            <Link
              href={`${billingBase(id)}/providers`}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            >
              Open Providers
            </Link>
          }
        />
      ) : (
        <Table minWidth="min-w-[48rem]">
          <THead>
            <TR>
              <TH>When</TH>
              <TH>Provider</TH>
              <TH>Event</TH>
              <TH>Status</TH>
              <TH>Provider event id</TH>
            </TR>
          </THead>
          <TBody>
            {events.map((e) => (
              <React.Fragment key={e.id}>
                <TR hover className="border-b-0 align-top">
                  <TD muted className="whitespace-nowrap text-xs">{formatDateTime(e.receivedAt)}</TD>
                  <TD className="text-xs">{providerLabel(providers, e.provider)}</TD>
                  <TD mono>{e.eventType}</TD>
                  <TD>
                    <Badge tone={STATUS_TONE[e.status]} dot>{e.status}</Badge>
                    {e.processingError && (
                      <span
                        className="mt-1 block max-w-[16rem] truncate text-[11px] text-red-600 dark:text-red-400"
                        title={e.processingError}
                      >
                        {e.processingError}
                      </span>
                    )}
                  </TD>
                  <TD muted mono className="max-w-[12rem] truncate text-[11px]">{e.providerEventId}</TD>
                </TR>
                <TR className="!bg-transparent">
                  <TD colSpan={5} className="!py-0">
                    <details className="group pb-3">
                      <summary className="cursor-pointer list-none text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]">
                        <span className="inline-block w-3 transition-transform group-open:rotate-90">›</span>{' '}
                        Details
                      </summary>
                      <div className="mt-2 space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <DetailField label="Provider event id">
                            <span className="font-mono">{e.providerEventId}</span>
                          </DetailField>
                          <DetailField label="Rekey event id">
                            <span className="font-mono">{e.id}</span>
                          </DetailField>
                          <DetailField label="Received">{formatDateTime(e.receivedAt)}</DetailField>
                          <DetailField label="Processed">
                            {e.processedAt === null ? 'Not yet' : formatDateTime(e.processedAt)}
                          </DetailField>
                        </div>
                        {e.processingError && (
                          <DetailField label="Error">
                            <span className="font-mono text-red-700 dark:text-red-400">{e.processingError}</span>
                          </DetailField>
                        )}
                      </div>
                    </details>
                  </TD>
                </TR>
              </React.Fragment>
            ))}
          </TBody>
        </Table>
      )}
      <Pager
        basePath={`${billingBase(id)}/events`}
        offset={offset}
        pageSize={pageSize}
        count={events.length}
        hasMore={eventPage.page.hasMore}
      />
    </section>
  );
}
