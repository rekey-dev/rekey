import * as React from 'react';
import Link from '@/components/Link';
import { formatDateTime } from '@/lib/date';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { billingBase, getBillingProviders, getWebhookEvents, providerLabel, type WebhookEventRow } from '../shared';

const STATUS_TONE: Record<WebhookEventRow['status'], BadgeTone> = {
  processed: 'success',
  received: 'warning',
  error: 'danger',
};

export default async function BillingEventsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const [providers, eventPage] = await Promise.all([getBillingProviders(id), getWebhookEvents(id)]);
  const events = eventPage.items;

  return (
    <section className="space-y-3" aria-labelledby="billing-events-heading">
      <SectionHeader
        title={<span id="billing-events-heading">Provider events</span>}
        count={events.length > 0 ? `latest ${events.length}` : undefined}
        description={
          <>
            What your payment providers posted to Rekey, such as a subscription starting or a
            payment going through. Newest first. The webhooks your app receives from Rekey are under{' '}
            <Link href={`/applications/${id}/webhooks`} className="underline hover:text-[var(--color-fg)]">
              Developer, Webhooks
            </Link>
            .
          </>
        }
      />
      {events.length === 0 ? (
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
              <TR key={e.id} hover className="align-top">
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
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}
