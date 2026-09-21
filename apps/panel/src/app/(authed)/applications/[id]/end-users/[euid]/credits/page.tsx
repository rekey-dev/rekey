/**
 * End-user Credits, prepaid balance, the manual adjustment, and the ledger.
 *
 * Unchanged in behaviour from the single-page version; it simply has its own
 * route now. This was the ONLY write an operator could perform on an end-user
 * from the panel, which is how a credit adjustment ended up next to a GDPR
 * erasure in the same scroll.
 */

import * as React from 'react';
import { errorMessage } from '@/lib/error-message';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDateTime } from '@/lib/date';
import { grantCredits } from '../actions';
import { getEndUserCredits, type CreditLedgerRow } from '../shared';

const CREDIT_ERR: Record<string, string> = {
  AMOUNT: 'Enter a non-zero whole number of credits.',
  CREDITS_INSUFFICIENT: 'That removal would overdraw the balance.',
  CREDITS_AMOUNT_INVALID: 'Enter a non-zero whole number of credits.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can adjust credits.',
  APP_ACCESS_DENIED: 'Your grant on this Application does not allow billing writes.',
};

const CREDIT_REASON_TONE: Record<CreditLedgerRow['reason'], BadgeTone> = {
  PURCHASE: 'success',
  GRANT: 'success',
  REFUND: 'info',
  CONSUME: 'neutral',
  ADJUST: 'warning',
};

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';

export default async function EndUserCreditsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  const creditError = typeof sp.creditError === 'string' ? sp.creditError : undefined;
  const credited = sp.credited === '1';

  const credits = await getEndUserCredits(id, euid);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Credits"
        description="Prepaid credit balance, spent down as the user consumes."
      />

      {credited && <Banner tone="success">Credits updated.</Banner>}
      {creditError && <Banner tone="error">{errorMessage(CREDIT_ERR, creditError)}</Banner>}

      {/* Not "0 credits". A balance of zero is a fact about the account; a
          failed read is a fact about the request. The adjust form is withheld
          too, applying a delta to a balance nobody could read is how an
          account gets overdrawn by an operator trying to help. */}
      {credits === null ? (
        <Banner tone="error">
          The credit balance could not be read. Either the request failed, or your grant on this
          Application does not cover billing. This is <strong>not</strong> a zero balance, so
          adjustments are withheld until it loads. Reload; if it persists, check the API and your
          access.
        </Banner>
      ) : (
        <>
      <Card className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums text-[var(--color-fg)]">
            {credits.balance}
          </span>
          <span className="text-xs text-[var(--color-muted-fg)]">credits available</span>
        </div>

        <ActionForm
          action={grantCredits.bind(null, id, euid)}
          className="grid items-end gap-2 sm:grid-cols-[6rem_8rem_1fr_auto]"
        >
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[var(--color-fg)]">Amount</span>
            <input
              type="number"
              name="amount"
              step={1}
              placeholder="100"
              required
              className={`${inputCls} font-mono`}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[var(--color-fg)]">Reason</span>
            <select name="reason" defaultValue="GRANT" className={inputCls}>
              <option value="GRANT">Grant</option>
              <option value="REFUND">Refund</option>
              <option value="ADJUST">Adjust</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[var(--color-fg)]">Note (optional)</span>
            <input
              type="text"
              name="description"
              maxLength={200}
              placeholder="promo top-up"
              className={inputCls}
            />
          </label>
          <SubmitButton pendingLabel="Applying…">Apply</SubmitButton>
        </ActionForm>
        <p className="text-[11px] text-[var(--color-muted-fg)]">
          Positive adds (Grant / Refund). Negative with Adjust removes, and is refused if it would
          overdraw.
        </p>
      </Card>

      {credits.ledger.length > 0 && (
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>When</TH>
              <TH>Reason</TH>
              <TH align="right">Change</TH>
              <TH align="right">Balance</TH>
              <TH>Note</TH>
            </TR>
          </THead>
          <TBody>
            {credits.ledger.map((e) => (
              <TR key={e.id} hover>
                <TD muted className="whitespace-nowrap text-xs">
                  {formatDateTime(e.createdAt)}
                </TD>
                <TD>
                  <Badge tone={CREDIT_REASON_TONE[e.reason]} dot>
                    {e.reason.toLowerCase()}
                  </Badge>
                </TD>
                <TD align="right" mono className="tabular-nums">
                  {e.delta > 0 ? `+${e.delta}` : e.delta}
                </TD>
                <TD align="right" mono muted className="tabular-nums">
                  {e.balanceAfter}
                </TD>
                <TD muted className="max-w-[12rem] truncate text-xs">
                  {e.description ?? '—'}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
        </>
      )}
    </div>
  );
}
