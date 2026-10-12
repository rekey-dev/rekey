import * as React from 'react';
import { RECONCILIATION_FINDING_KINDS, type ReconciliationFinding } from '@rekey.dev/shared-types';
import Link from '@/components/Link';
import { getApplication } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { Banner } from '@/components/Banner';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { eventMoney, FINDING_COPY } from '@/lib/billing-events';
import { readPeriod } from '@/lib/billing-log';
import { formatDateTime } from '@/lib/date';
import { PeriodForm } from '../PeriodForm';
import { getReconciliation } from '../shared';

function FindingRecord({ finding, applicationId }: { finding: ReconciliationFinding; applicationId: string }): React.JSX.Element {
  const base = `/applications/${applicationId}`;
  const linkCls = 'font-mono underline hover:text-[var(--color-fg)]';
  if (finding.paymentId && finding.kind !== 'event_without_payment') {
    return (
      <Link href={`${base}/payments/${finding.paymentId}`} className={linkCls}>
        payment {finding.paymentId}
      </Link>
    );
  }
  if (finding.paymentId) return <span className="font-mono">payment {finding.paymentId}, not on record</span>;
  if (finding.subscriptionId) {
    return (
      <Link href={`${base}/billing-log?view=all&subscriptionId=${encodeURIComponent(finding.subscriptionId)}`} className={linkCls}>
        subscription {finding.subscriptionId}
      </Link>
    );
  }
  return <span className="font-mono">log entry {finding.eventSeq ?? 'unknown'}</span>;
}

export default async function ReconciliationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const period = readPeriod(await searchParams);
  const app = await getApplication(id);
  if (!app.billingConfig.enabled) return <BillingDisabledState applicationId={id} />;

  const answer = period.ok ? await getReconciliation(id, period.query) : null;
  const report = answer?.ok ? answer.data : null;
  const total = report === null ? 0 : RECONCILIATION_FINDING_KINDS.reduce((sum, kind) => sum + report.counts[kind], 0);

  return (
    <div className="space-y-5">
      <p className="max-w-prose text-sm text-[var(--color-muted-fg)]">
        Compares the billing log with this Application&rsquo;s payments, refunds and subscriptions
        for one period, and lists where they disagree. It reads only and changes nothing. It
        compares Rekey&rsquo;s own records with each other, not with your provider&rsquo;s list of
        charges. The same comparison runs every hour.
      </p>
      <PeriodForm from={period.from} to={period.to} refusal={period.ok ? null : period.reason} />

      {answer !== null && !answer.ok && (
        <Banner tone="error">
          {answer.message}
          {answer.fix && <span className="mt-1 block opacity-90">{answer.fix}</span>}
        </Banner>
      )}

      {report !== null && (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {(
              [
                ['Payments checked', report.checked.payments],
                ['Refunds checked', report.checked.refunds],
                ['Subscriptions checked', report.checked.subscriptions],
                ['Log entries checked', report.checked.events],
              ] as const
            ).map(([label, count]) => (
              <div key={label} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                <dt className="text-xs text-[var(--color-muted-fg)]">{label}</dt>
                <dd className="font-mono text-[var(--color-fg)]">{count.toLocaleString('en-US')}</dd>
              </div>
            ))}
          </dl>
          <p className="max-w-prose text-xs text-[var(--color-muted-fg)]">
            {report.paymentsLoggedSince === null
              ? 'The log holds no payment entry yet, so payments were not checked.'
              : `Payments are checked from ${formatDateTime(report.paymentsLoggedSince)}, when the log first recorded one.`}{' '}
            {report.subscriptionsLoggedSince === null
              ? 'It holds no subscription entry yet, so subscriptions were not checked.'
              : `Subscriptions are checked from ${formatDateTime(report.subscriptionsLoggedSince)}.`}{' '}
            Anything older was never logged and is not reported as missing.
          </p>

          {total === 0 ? (
            <EmptyState
              variant="inline"
              title="The log and the records agree for this period"
              description="Every payment, refund and subscription checked has the entries it should, and every entry names a record that exists."
            />
          ) : (
            RECONCILIATION_FINDING_KINDS.map((kind) => {
              const findings = report.findings.filter((finding) => finding.kind === kind);
              const count = report.counts[kind];
              if (count === 0) return null;
              return (
                <section key={kind} className="space-y-2" aria-labelledby={`finding-${kind}`}>
                  <h3 id={`finding-${kind}`} className="flex items-center gap-2 text-sm font-medium text-[var(--color-fg)]">
                    {FINDING_COPY[kind].title}
                    <Badge tone="warning">
                      {count}
                      {report.truncated && findings.length < count ? ' or more' : ''}
                    </Badge>
                  </h3>
                  <p className="max-w-prose text-xs text-[var(--color-muted-fg)]">{FINDING_COPY[kind].meaning}</p>
                  <Table minWidth="min-w-[48rem]">
                    <caption className="sr-only">{FINDING_COPY[kind].title}, oldest first</caption>
                    <THead>
                      <TR>
                        <TH>When</TH>
                        <TH>Record</TH>
                        <TH align="right">Amount</TH>
                        {kind === 'refund_mismatch' && (
                          <>
                            <TH align="right">On the payment</TH>
                            <TH align="right">Refund records</TH>
                            <TH align="right">Log entries</TH>
                          </>
                        )}
                      </TR>
                    </THead>
                    <TBody>
                      {findings.map((finding) => (
                        <TR key={`${finding.paymentId}-${finding.subscriptionId}-${finding.eventSeq}-${finding.at}`}>
                          <TD muted className="whitespace-nowrap text-xs">{formatDateTime(finding.at)}</TD>
                          <TD className="text-xs">
                            <FindingRecord finding={finding} applicationId={id} />
                          </TD>
                          <TD align="right" mono>{eventMoney(finding.amount, finding.currency) ?? ''}</TD>
                          {kind === 'refund_mismatch' && (
                            <>
                              <TD align="right" mono>{eventMoney(finding.refundedOnPayment, finding.currency) ?? ''}</TD>
                              <TD align="right" mono>{eventMoney(finding.refundRowsTotal, finding.currency) ?? ''}</TD>
                              <TD align="right" mono>{eventMoney(finding.refundEventsTotal, finding.currency) ?? ''}</TD>
                            </>
                          )}
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </section>
              );
            })
          )}
          {report.truncated && (
            <p className="text-xs text-[var(--color-muted-fg)]">
              At most 200 findings of each kind are listed. Shorten the period to see the rest.
            </p>
          )}
        </>
      )}
    </div>
  );
}
