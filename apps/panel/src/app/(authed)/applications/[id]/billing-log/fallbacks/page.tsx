import * as React from 'react';
import Link from '@/components/Link';
import { getApplication, unlessBusy } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { readPeriod } from '@/lib/billing-log';
import { formatDateTime } from '@/lib/date';
import { currencyChoice, unchargeableReason } from '@/lib/price-currencies';
import { getBillingProviders } from '../../billing/shared';
import { PeriodForm } from '../PeriodForm';
import { getPriceFallbacks } from '../shared';

export default async function PriceFallbacksPage({
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

  const [answer, providers] = await Promise.all([
    period.ok ? getPriceFallbacks(id, period.query) : null,
    getBillingProviders(id).catch(unlessBusy(() => [])),
  ]);
  const providersHref = `/applications/${id}/billing/providers`;
  const plansHref = `/applications/${id}/plans`;

  return (
    <div className="space-y-5">
      <p className="max-w-prose text-sm text-[var(--color-muted-fg)]">
        A buyer here was selected a price in their own currency, no enabled provider could charge
        it, and they were charged the plan&rsquo;s default price instead. They were told before
        paying. Each row is a buyer who may have paid more or less than you priced for their
        country.
      </p>
      <PeriodForm from={period.from} to={period.to} refusal={period.ok ? null : period.reason} />

      {answer === null ? null : !answer.ok ? (
        <Banner tone="error">
          {answer.message}
          {answer.fix && <span className="mt-1 block opacity-90">{answer.fix}</span>}
        </Banner>
      ) : answer.data.groups.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No buyer was charged the default price in this period"
          description="Every price selected for a buyer could be charged by an enabled provider."
        />
      ) : (
        <>
          <p className="text-sm text-[var(--color-fg)]">
            {answer.data.total} {answer.data.total === 1 ? 'checkout' : 'checkouts'} fell back to the default price.
          </p>
          <Table minWidth="min-w-[64rem]">
            <caption className="sr-only">Checkouts charged the default price, most frequent first</caption>
            <THead>
              <TR>
                <TH>Plan</TH>
                <TH>Currency wanted</TH>
                <TH>Currency charged</TH>
                <TH>Country</TH>
                <TH align="right">Checkouts</TH>
                <TH>Last seen</TH>
                <TH>To stop it</TH>
              </TR>
            </THead>
            <TBody>
              {answer.data.groups.map((group) => {
                const wanted = group.requestedCurrency;
                const reason = wanted === null ? null : unchargeableReason(currencyChoice(wanted, providers));
                return (
                  <TR
                    key={`${group.planSlug}-${wanted}-${group.chargedCurrency}-${group.country}`}
                    className="align-top"
                  >
                    <TD mono>{group.planSlug ?? 'unknown'}</TD>
                    <TD mono>{wanted ?? 'unknown'}</TD>
                    <TD mono>{group.chargedCurrency ?? 'unknown'}</TD>
                    <TD mono>{group.country ?? 'not known'}</TD>
                    <TD align="right" mono>{group.count}</TD>
                    <TD muted className="whitespace-nowrap text-xs">{formatDateTime(group.lastOccurredAt)}</TD>
                    <TD className="max-w-[22rem] text-xs">
                      {wanted === null ? (
                        'The currency wanted was not recorded.'
                      ) : reason === null ? (
                        <>
                          {wanted} can be charged now, so this should not recur. If it does, check that the
                          provider is enabled in the mode buyers check out in.
                        </>
                      ) : (
                        <>
                          {reason}{' '}
                          <Link href={providersHref} className="underline hover:text-[var(--color-fg)]">
                            Open Providers
                          </Link>
                          . If you do not mean to sell in {wanted}, remove that price from{' '}
                          <Link href={plansHref} className="underline hover:text-[var(--color-fg)]">
                            the plan
                          </Link>
                          , or give those countries a price in a currency a provider can charge, so
                          buyers are shown what they will pay from the start.
                        </>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </>
      )}
    </div>
  );
}
