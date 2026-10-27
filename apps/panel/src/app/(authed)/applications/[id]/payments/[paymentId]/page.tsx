import * as React from 'react';
import Link from '@/components/Link';
import { getApplication, readErrorFlash } from '@/lib/api';
import { ApiErrorText } from '@/components/api-error';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { RecordHeader } from '@/components/RecordHeader';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { BillingLogTable } from '@/components/BillingLogTable';
import { Card, SectionHeader } from '@/components/Card';
import { CopyButton } from '@/components/CopyButton';
import { EmptyState } from '@/components/EmptyState';
import { SavedBanner } from '@/components/SavedBanner';
import { StatusPill } from '@/components/StatusPill';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { formatDateTime } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { hasScope } from '@/lib/operator-scopes';
import { refundable, refundRefusal, VERIFICATION_COPY } from '@/lib/refunds';
import { getBillingTrail } from '../../billing-log/shared';
import { refundPayment } from '../actions';
import { getPayment, getRefunds } from '../shared';
import { RefundForm } from './RefundForm';

/** Copy for what the form refuses itself. An API refusal shows the API's own message and fix. */
const REFUND_ERR: Record<string, string> = {
  refundAmount:
    'Type the refund the way the currency is written, such as 19.99, with no more decimals than the currency has. Nothing was refunded.',
  refundExceeds: 'That is more than what has not been refunded on this payment. Nothing was refunded.',
};

const REFUND_STATUS_TONE = { succeeded: 'success', pending: 'warning', failed: 'danger' } as const;
const INITIATED_BY = { operator: 'An operator, from Rekey', provider: 'The provider', system: 'Rekey' } as const;

export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; paymentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, paymentId } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const refunded = typeof sp.refunded === 'string' && /^\d+$/.test(sp.refunded) ? Number(sp.refunded) : null;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const back = `/applications/${id}/payments`;

  const app = await getApplication(id);
  if (!app.billingConfig.enabled) return <BillingDisabledState applicationId={id} />;

  const [paymentRead, refundsRead, trail] = await Promise.all([
    getPayment(id, paymentId),
    getRefunds(id, paymentId),
    getBillingTrail(id, { paymentId }, 100),
  ]);

  if (!paymentRead.ok && paymentRead.notFound) {
    return (
      <div className="space-y-5">
        <SectionHeader title="Payment" />
        <EmptyState
          title="No such payment in this Application"
          description="The id in the address does not belong to a payment here. It may have been copied from another Application."
          action={
            <Link href={back} className="underline hover:text-[var(--color-fg)]">
              Back to payments
            </Link>
          }
        />
      </div>
    );
  }

  const payment = paymentRead.ok ? paymentRead.payment : null;
  const entries = trail?.entries ?? [];
  const verification = payment ? VERIFICATION_COPY[payment.verification] : null;
  const canWrite = hasScope(app.access.scopes, 'billing:write');
  const refusal = payment ? refundRefusal(payment, canWrite) : null;
  const refusalId = 'refund-refusal';

  return (
    <div className="space-y-6">
      <RecordHeader
        crumbs={[{ label: 'Payments', href: back }, { label: paymentId }]}
        title={payment ? `Payment of ${formatMoney(payment.amount, payment.currency)}` : 'Payment'}
        action={<CopyButton value={paymentId} label="Copy payment ID" />}
      />
      {refunded !== null && payment && (
        <SavedBanner params={['refunded']} message={`Refunded ${formatMoney(refunded, payment.currency)}.`} />
      )}

      <section className="space-y-3">
        {payment && verification ? (
          <Card>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_1fr]">
              <dt className="text-xs text-[var(--color-muted-fg)]">Status</dt>
              <dd>
                <StatusPill status={payment.status} />
              </dd>
              <dt className="text-xs text-[var(--color-muted-fg)]">Verification</dt>
              <dd>
                <Badge tone={verification.tone} dot>
                  {verification.label}
                </Badge>
                <span className="mt-1 block max-w-prose text-xs text-[var(--color-muted-fg)]">
                  {verification.meaning}
                  {verification.label === 'unverified' && (
                    <>
                      {' '}
                      <Link href={`/applications/${id}/unapplied-payments`} className="underline hover:text-[var(--color-fg)]">
                        Open unapplied payments
                      </Link>
                    </>
                  )}
                </span>
              </dd>
              <dt className="text-xs text-[var(--color-muted-fg)]">Amount</dt>
              <dd className="font-mono">{formatMoney(payment.amount, payment.currency)}</dd>
              <dt className="text-xs text-[var(--color-muted-fg)]">Refunded</dt>
              <dd className="font-mono">
                {formatMoney(payment.refundedAmount, payment.currency)}
                <span className="ml-2 font-sans text-xs text-[var(--color-muted-fg)]">
                  {formatMoney(refundable(payment), payment.currency)} not refunded
                </span>
              </dd>
              <dt className="text-xs text-[var(--color-muted-fg)]">When</dt>
              <dd>{formatDateTime(payment.createdAt)}</dd>
              <dt className="text-xs text-[var(--color-muted-fg)]">End-user</dt>
              <dd>
                {payment.endUserId ? (
                  <Link
                    href={`/applications/${id}/end-users/${payment.endUserId}/subscriptions`}
                    className="underline decoration-[var(--color-border)] underline-offset-2 hover:decoration-[var(--color-fg)]"
                  >
                    {payment.endUserEmail ?? payment.endUserId}
                  </Link>
                ) : (
                  <span className="text-[var(--color-muted-fg)]">Not attributed to an end-user</span>
                )}
              </dd>
              <dt className="text-xs text-[var(--color-muted-fg)]">Provider</dt>
              <dd>{payment.provider ?? <span className="text-[var(--color-muted-fg)]">Not recorded</span>}</dd>
              <dt className="text-xs text-[var(--color-muted-fg)]">Subscription</dt>
              <dd>
                {payment.subscriptionId ? (
                  <Link
                    href={`/applications/${id}/billing-log?view=all&subscriptionId=${encodeURIComponent(payment.subscriptionId)}`}
                    className="font-mono text-xs underline decoration-[var(--color-border)] underline-offset-2 hover:decoration-[var(--color-fg)]"
                  >
                    {payment.subscriptionId}
                  </Link>
                ) : (
                  <span className="text-[var(--color-muted-fg)]">Linked to none</span>
                )}
              </dd>
              {payment.description && (
                <>
                  <dt className="text-xs text-[var(--color-muted-fg)]">Description</dt>
                  <dd>{payment.description}</dd>
                </>
              )}
              {payment.providerPaymentId && (
                <>
                  <dt className="text-xs text-[var(--color-muted-fg)]">Provider reference</dt>
                  <dd>
                    <CopyButton value={payment.providerPaymentId} label="Copy provider reference" />
                  </dd>
                </>
              )}
            </dl>
          </Card>
        ) : (
          <EmptyState
            variant="inline"
            title="The payment could not be read"
            description="The request failed. Reload to try again. Its refunds and its history are below."
          />
        )}
      </section>

      <section className="space-y-3" aria-labelledby="refunds-heading">
        <SectionHeader
          title={<span id="refunds-heading">Refunds</span>}
          count={refundsRead.ok ? `(${refundsRead.refunds.length})` : undefined}
          description="Every refund recorded against this payment, oldest first: those the provider reported and those issued from here. A failed refund counts for nothing in the refunded total."
        />
        {!refundsRead.ok ? (
          <EmptyState
            variant="inline"
            title="The refunds could not be read"
            description="The request failed. This is not an empty list. Reload to try again."
          />
        ) : refundsRead.refunds.length === 0 ? (
          <EmptyState variant="inline" title="No refunds" description="Nothing has been refunded on this payment." />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <caption className="sr-only">Refunds of this payment, oldest first</caption>
            <THead>
              <TR>
                <TH>When</TH>
                <TH align="right">Amount</TH>
                <TH>Status</TH>
                <TH>Started by</TH>
                <TH>Reason</TH>
                <TH>Provider refund id</TH>
              </TR>
            </THead>
            <TBody>
              {refundsRead.refunds.map((refund) => (
                <TR key={refund.id}>
                  <TD muted className="whitespace-nowrap text-xs">{formatDateTime(refund.createdAt)}</TD>
                  <TD align="right" mono>{formatMoney(refund.amount, refund.currency)}</TD>
                  <TD>
                    <Badge tone={REFUND_STATUS_TONE[refund.status]} dot>
                      {refund.status}
                    </Badge>
                  </TD>
                  <TD className="text-xs">{INITIATED_BY[refund.initiatedBy]}</TD>
                  <TD muted className="max-w-[16rem] text-xs">{refund.reason ?? ''}</TD>
                  <TD muted mono className="max-w-[12rem] truncate text-[11px]" title={refund.providerRefundId ?? undefined}>
                    {refund.providerRefundId ?? ''}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {payment && (
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">Refund this payment</h3>
            {error && (
              <Banner tone="error">
                <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={REFUND_ERR} fallback="The refund was not issued." />
              </Banner>
            )}
            {refusal !== null ? (
              <div className="space-y-2">
                <button
                  type="button"
                  disabled
                  aria-describedby={refusalId}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] opacity-60"
                >
                  Refund
                </button>
                <p id={refusalId} className="max-w-prose text-sm text-[var(--color-muted-fg)]">
                  {refusal}
                </p>
              </div>
            ) : (
              <>
                <p className="max-w-prose text-sm text-[var(--color-muted-fg)]">
                  <span className="font-mono text-[var(--color-fg)]">{formatMoney(refundable(payment), payment.currency)}</span>{' '}
                  of this payment has not been refunded. A refund can be for all of it or a part, and a payment can
                  be refunded more than once, up to its amount.
                </p>
                <RefundForm
                  key={payment.refundedAmount}
                  action={refundPayment.bind(null, id, {
                    id: payment.id,
                    currency: payment.currency,
                    remaining: refundable(payment),
                  })}
                  currency={payment.currency}
                  remaining={refundable(payment)}
                  providerNote="The provider that took this payment"
                />
              </>
            )}
          </Card>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="payment-history-heading">
        <SectionHeader
          title={<span id="payment-history-heading">History</span>}
          description="Every billing log entry that names this payment, newest first: how it was recorded, whether it was applied, and each refund."
        />
        {trail === null ? (
          <EmptyState
            variant="inline"
            title="The history could not be read"
            description="The request failed. This is not an empty history. Reload to try again."
          />
        ) : entries.length === 0 ? (
          <EmptyState
            variant="inline"
            title="Nothing in the billing log names this payment"
            description="A payment made before the log existed has no entries."
          />
        ) : (
          <BillingLogTable entries={entries} actors={trail.actors} applicationId={id} caption="Billing history of this payment, newest first" />
        )}
      </section>
    </div>
  );
}
