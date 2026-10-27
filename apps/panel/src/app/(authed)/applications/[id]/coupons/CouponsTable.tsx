import * as React from 'react';
import type { CouponRow } from '@/lib/api';
import { basisPointsToPercentText, coverageOf, discountText } from '@/lib/coupon-form';
import { formatDate } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { minorToMajorText } from '@/lib/money-input';
import { savedStateKey } from '@/lib/saved-state-key';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorText } from '@/components/api-error';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Modal } from '@/components/Modal';
import { SubmitButton } from '@/components/SubmitButton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { setCouponActive, updateCouponTerms } from './actions';
import { CouponLimitFields, type CouponLimitsInitial } from './CouponLimitFields';
import { CouponTermsFields, type CouponPlanOption, type CouponTermsInitial } from './CouponTermsFields';

/** What the last edit left in the URL for one coupon's dialog. */
export interface CouponEditFlash {
  code: string | undefined;
  error: string | undefined;
  detail: string | undefined;
  fix: string | undefined;
}

/** Copy for the refusals the form raises itself. An API refusal shows the API's own message and fix. */
export const COUPON_FORM_ERR: Record<string, string> = {
  code: 'Give the coupon a code.',
  percent: 'A percentage is between 0.01 and 100, with at most two decimals, such as 15 or 12.5.',
  amount:
    'One of the amounts cannot be saved. Type each the way its currency is written, such as 5.00. A currency with no decimals (JPY) takes a whole number, and so do HUF, TWD and MGA. A row you add needs both a currency and an amount.',
  currency: 'One of the currencies is not one a price can be in. Three-decimal currencies such as KWD cannot be sold in.',
  duplicate: 'A currency was given two amounts. Keep one row per currency.',
  endsAt: 'The expiry is not a date and time. Pick one, or leave it empty for a coupon that never expires.',
  limit: 'A redemption limit is a whole number of 1 or more. Leave it empty for no limit.',
  COUPON_AMOUNTS_REQUIRED:
    'A fixed-amount coupon needs an amount in at least one currency. It takes nothing off in a currency it has no amount for.',
  COUPON_CODE_TAKEN: 'A coupon with that code already exists.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage coupons.',
};

const linkButton =
  'inline-block py-1.5 cursor-pointer rounded text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';

function initialTerms(coupon: CouponRow): CouponTermsInitial {
  return {
    discountType: coupon.discountType,
    percent: coupon.basisPoints === null ? '' : basisPointsToPercentText(coupon.basisPoints),
    currencies: [...coupon.currencies],
    amounts: Object.fromEntries(
      coupon.amounts.map((amount) => [amount.currency, minorToMajorText(amount.amountOff, amount.currency) ?? '']),
    ),
    planSlugs: [...coupon.planSlugs],
  };
}

function initialLimits(coupon: CouponRow): CouponLimitsInitial {
  return { endsAt: coupon.endsAt, maxRedemptions: coupon.maxRedemptions, maxRedemptionsPerUser: coupon.maxRedemptionsPerUser };
}

/** Each currency's total on its own line. A sum across currencies would mean nothing. */
function DiscountIssued({ coupon }: { coupon: CouponRow }): React.JSX.Element {
  if (coupon.discountIssuedByCurrency.length === 0) return <>—</>;
  return (
    <>
      {coupon.discountIssuedByCurrency.map((issued) => (
        <span key={issued.currency} className="block whitespace-nowrap">
          {formatMoney(issued.amount, issued.currency)}
          <span className="ml-1 font-sans text-[var(--color-muted-fg)]">× {issued.redemptions}</span>
        </span>
      ))}
    </>
  );
}

export function CouponsTable({
  rows,
  applicationId,
  plans,
  reportingCurrency,
  flash,
}: {
  rows: CouponRow[];
  applicationId: string;
  plans: readonly CouponPlanOption[];
  reportingCurrency: string;
  flash: CouponEditFlash;
}): React.JSX.Element {
  return (
    <Table minWidth="min-w-[68rem]">
      <THead>
        <TR>
          <TH>Code</TH>
          <TH align="right">Discount</TH>
          <TH>Coverage</TH>
          <TH align="right">Used</TH>
          <TH align="right">Discount issued</TH>
          <TH>Plans</TH>
          <TH>Expires</TH>
          <TH>Status</TH>
          <TH align="right">
            <span className="sr-only">Actions</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((c) => {
          const coverage = coverageOf(c, plans, reportingCurrency);
          const noAmount = c.discountType === 'AMOUNT' && c.amounts.length === 0;
          const editing = flash.code?.toLowerCase() === c.code.toLowerCase();
          return (
            <TR key={c.id} hover>
              <TD>
                <Badge tone="neutral" mono className="uppercase">{c.code}</Badge>
              </TD>
              <TD align="right" mono>{discountText(c)}</TD>
              <TD className="max-w-[14rem] text-xs">
                <span className="font-mono text-[var(--color-fg)]">{coverage.label}</span>
                {coverage.refusedIn.length > 0 && (
                  <span className="mt-0.5 block text-amber-700 dark:text-amber-400">
                    Refused in {coverage.refusedIn.join(', ')}
                  </span>
                )}
              </TD>
              <TD align="right" mono className="text-xs">
                {c.redemptionCount}
                {c.maxRedemptions !== null && <span className="text-[var(--color-muted-fg)]"> / {c.maxRedemptions}</span>}
              </TD>
              <TD align="right" mono className="text-xs">
                <DiscountIssued coupon={c} />
              </TD>
              <TD muted className="text-xs">{c.planSlugs.length === 0 ? 'all' : c.planSlugs.join(', ')}</TD>
              <TD muted className="text-xs">{c.endsAt ? formatDate(c.endsAt) : '—'}</TD>
              <TD>
                {c.active && noAmount ? (
                  <Badge tone="warning" dot>no amount, refused at checkout</Badge>
                ) : c.active ? (
                  <Badge tone="success" dot>active</Badge>
                ) : (
                  <Badge tone="neutral" dot>inactive</Badge>
                )}
              </TD>
              <TD align="right">
                <div className="flex items-center justify-end gap-3">
                  <Modal
                    modalKey="editCoupon"
                    modalValue={c.code}
                    size="lg"
                    title={`Edit coupon: ${c.code.toUpperCase()}`}
                    description="Change what the coupon takes off, the currencies it works in, the plans it applies to, when it expires and how often it may be redeemed. A checkout that is already open keeps the discount it was opened with."
                    trigger="Edit"
                    triggerClassName={linkButton}
                  >
                    <ActionForm
                      key={savedStateKey([initialTerms(c), initialLimits(c)])}
                      action={updateCouponTerms.bind(null, applicationId, { code: c.code, discountType: c.discountType })}
                      className="space-y-4"
                    >
                      {editing && flash.error && (
                        <Banner tone="error">
                          <ApiErrorText
                            code={flash.error}
                            detail={flash.detail}
                            fix={flash.fix}
                            map={COUPON_FORM_ERR}
                            fallback="The coupon could not be saved."
                          />
                        </Banner>
                      )}
                      <p className="text-xs text-[var(--color-muted-fg)]">
                        {c.discountType === 'PERCENT' ? 'A percentage coupon.' : 'A fixed-amount coupon.'} A coupon
                        keeps its kind and its code. To change one of those, deactivate it and create another.
                      </p>
                      <CouponTermsFields
                        plans={plans}
                        reportingCurrency={reportingCurrency}
                        initial={initialTerms(c)}
                        typeLocked
                      />
                      <CouponLimitFields initial={initialLimits(c)} held={c.redemptionCount} />
                      <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
                    </ActionForm>
                  </Modal>
                  <ActionForm action={setCouponActive.bind(null, applicationId, c.code, !c.active)} className="inline">
                    {c.active ? (
                      <ConfirmButton title="Deactivate coupon?" confirm={`Deactivate coupon "${c.code}"? It can no longer be redeemed at checkout.`}>
                        Deactivate
                      </ConfirmButton>
                    ) : (
                      <SubmitButton
                        pendingLabel="Reactivating…"
                        className="inline-block py-1.5 rounded text-xs font-medium text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                      >
                        Reactivate
                      </SubmitButton>
                    )}
                  </ActionForm>
                </div>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
