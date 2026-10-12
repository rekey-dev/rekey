'use client';

/**
 * The discount and scope fields shared by the create and edit coupon forms:
 * the plans it applies to, and either a percentage with an optional currency
 * limit or one fixed amount per currency.
 *
 * Every field is held in state. React resets a form's uncontrolled fields
 * after its action runs, refused or not, and a refused save must not cost the
 * operator a row of amounts.
 */

import * as React from 'react';
import { CurrencyInput } from '@/components/CurrencyCatalog';
import { fieldInputCls } from '@/components/Field';
import {
  currenciesInScope,
  percentToBasisPoints,
  uncoveredCurrencies,
  type DiscountType,
  type PlanCurrencies,
} from '@/lib/coupon-form';
import { formatMoney } from '@/lib/format';
import { readTypedPrice } from '@/lib/money-input';
import { amountRule } from '@/lib/price-currencies';

export interface CouponPlanOption extends PlanCurrencies {
  name: string;
}

export interface CouponTermsInitial {
  discountType: DiscountType;
  /** The percentage as typed, such as "15". */
  percent: string;
  /** The currencies a percentage coupon is limited to. Empty means any. */
  currencies: string[];
  /** Typed amount per currency, such as { USD: '5', INR: '400' }. */
  amounts: Record<string, string>;
  planSlugs: string[];
}

const EMPTY: CouponTermsInitial = { discountType: 'PERCENT', percent: '', currencies: [], amounts: {}, planSlugs: [] };

const labelCls = 'text-xs font-medium text-[var(--color-fg)]';
const hintCls = 'block text-xs text-[var(--color-muted-fg)]';
const quietButton =
  'cursor-pointer rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';

function amountNote(raw: string, currency: string): { text: string; bad: boolean } {
  if (raw.trim() === '') return { text: `Empty: refused in ${currency}. ${amountRule(currency) ?? ''}`, bad: false };
  const typed = readTypedPrice(raw, currency);
  return typed.ok ? { text: `= ${formatMoney(typed.minor, currency)} off`, bad: false } : { text: typed.message, bad: true };
}

function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

export function CouponTermsFields({
  plans,
  reportingCurrency,
  initial = EMPTY,
  typeLocked = false,
}: {
  plans: readonly CouponPlanOption[];
  reportingCurrency: string;
  initial?: CouponTermsInitial;
  /** A coupon keeps its kind once created, so the edit form shows it and does not offer the other. */
  typeLocked?: boolean;
}): React.JSX.Element {
  const [type, setType] = React.useState<DiscountType>(initial.discountType);
  const [percent, setPercent] = React.useState(initial.percent);
  const [planSlugs, setPlanSlugs] = React.useState<ReadonlySet<string>>(() => new Set(initial.planSlugs));
  const [limited, setLimited] = React.useState<ReadonlySet<string>>(() => new Set(initial.currencies));
  const [amounts, setAmounts] = React.useState<Record<string, string>>(initial.amounts);
  const [extras, setExtras] = React.useState<Array<{ currency: string; amount: string }>>([]);
  const ids = React.useId();
  const warningId = `${ids}-coverage`;

  const inScope = currenciesInScope(plans, [...planSlugs], reportingCurrency);
  // A currency that left the scope keeps its row while it holds an amount or
  // a tick, so narrowing the plans never discards what was typed.
  const amountRows = [...new Set([...inScope, ...Object.keys(amounts).filter((code) => (amounts[code] ?? '').trim() !== '')])];
  const limitChoices = [...new Set([...inScope, ...limited])];

  const covered =
    type === 'PERCENT'
      ? limited.size === 0
        ? null
        : [...limited]
      : [
          ...amountRows.filter((code) => (amounts[code] ?? '').trim() !== ''),
          ...extras.filter((row) => row.amount.trim() !== '').map((row) => row.currency.toUpperCase()),
        ];
  const refusedIn = uncoveredCurrencies(covered, inScope);
  const basisPoints = percentToBasisPoints(percent);

  return (
    <div className="space-y-4">
      <fieldset className="space-y-1">
        <legend className={labelCls}>Applies to plans</legend>
        {plans.length === 0 ? (
          <p className={hintCls}>This Application has no plans yet, so the coupon applies to every plan created later.</p>
        ) : (
          <>
            <ul className="grid max-h-32 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-[var(--color-border)] p-2 sm:grid-cols-2">
              {plans.map((plan) => (
                <li key={plan.slug}>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-fg)]">
                    <input
                      type="checkbox"
                      name="planSlugs"
                      value={plan.slug}
                      checked={planSlugs.has(plan.slug)}
                      onChange={() => setPlanSlugs((current) => toggled(current, plan.slug))}
                    />
                    <span className="font-mono">{plan.slug}</span>
                    <span className="truncate text-[var(--color-muted-fg)]">
                      {plan.currencies.length === 0 ? 'no price' : plan.currencies.join(', ')}
                      {!plan.active && ', archived'}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <span className={hintCls}>None ticked: the coupon applies to every plan.</span>
          </>
        )}
      </fieldset>

      {typeLocked ? (
        <input type="hidden" name="discountType" value={type} />
      ) : (
        <label className="block space-y-1">
          <span className={labelCls}>Discount</span>
          <select
            name="discountType"
            value={type}
            onChange={(e) => setType(e.currentTarget.value === 'AMOUNT' ? 'AMOUNT' : 'PERCENT')}
            className={fieldInputCls}
          >
            <option value="PERCENT">A percentage off</option>
            <option value="AMOUNT">A fixed amount off, set per currency</option>
          </select>
          <span className={hintCls}>
            A percentage works on a price in any currency. A fixed amount is stated in each currency:
            nothing is converted, because a local price may be set for what buyers there can pay.
          </span>
        </label>
      )}

      {type === 'PERCENT' ? (
        <>
          <label className="block space-y-1">
            <span className={labelCls}>
              Percent off<span className="ml-0.5 text-[var(--color-primary)]">*</span>
            </span>
            <input
              type="text"
              inputMode="decimal"
              name="percent"
              required
              placeholder="15"
              value={percent}
              onChange={(e) => setPercent(e.currentTarget.value)}
              aria-invalid={percent.trim() !== '' && basisPoints === null ? true : undefined}
              className={`${fieldInputCls} font-mono`}
            />
            <span className={hintCls} aria-live="polite">
              {percent.trim() === ''
                ? 'Typed as a percentage: 15 is 15% off, 12.5 is 12.5% off.'
                : basisPoints === null
                  ? 'A percentage is between 0.01 and 100, with at most two decimals.'
                  : `= ${percent.trim()}% off. A part of the smallest unit is rounded in the buyer's favour.`}
            </span>
          </label>
          <fieldset className="space-y-1" aria-describedby={warningId}>
            <legend className={labelCls}>Limit to currencies</legend>
            {limitChoices.length === 0 ? (
              <p className={hintCls}>The plans in scope have no prices yet, so there is no currency to limit it to.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {limitChoices.map((code) => (
                  <label key={code} className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-fg)]">
                    <input
                      type="checkbox"
                      name="currencies"
                      value={code}
                      checked={limited.has(code)}
                      onChange={() => setLimited((current) => toggled(current, code))}
                    />
                    <span className="font-mono">{code}</span>
                  </label>
                ))}
                {limited.size > 0 && (
                  <button type="button" className={quietButton} onClick={() => setLimited(new Set())}>
                    Clear, any currency
                  </button>
                )}
              </div>
            )}
            <span className={hintCls}>
              Optional. Tick the currencies the discount was written for, so it is not also taken off
              a lower local price.
            </span>
          </fieldset>
        </>
      ) : (
        <fieldset className="space-y-2" aria-describedby={warningId}>
          <legend className={labelCls}>Amount off, per currency</legend>
          {amountRows.length === 0 && extras.length === 0 && (
            <p className={hintCls}>The plans in scope have no prices yet. Add a currency below.</p>
          )}
          {amountRows.map((code) => {
            const note = amountNote(amounts[code] ?? '', code);
            const noteId = `${ids}-amount-${code}`;
            return (
              <label key={code} className="grid grid-cols-[4rem_1fr] items-start gap-x-2">
                <span className="pt-2 font-mono text-sm text-[var(--color-fg)]">{code}</span>
                <span className="space-y-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    name={`amount.${code}`}
                    placeholder="Not covered"
                    value={amounts[code] ?? ''}
                    onChange={(e) => setAmounts((current) => ({ ...current, [code]: e.currentTarget.value }))}
                    aria-label={`Amount off in ${code}`}
                    aria-invalid={note.bad || undefined}
                    aria-describedby={noteId}
                    className={`${fieldInputCls} font-mono`}
                  />
                  <span id={noteId} className={note.bad ? 'block text-xs text-red-600 dark:text-red-400' : hintCls}>
                    {note.text}
                  </span>
                </span>
              </label>
            );
          })}
          {extras.map((row, index) => {
            const known = /^[A-Z]{3}$/.test(row.currency);
            const note = known && row.amount.trim() !== '' ? amountNote(row.amount, row.currency) : null;
            const set = (patch: Partial<{ currency: string; amount: string }>): void =>
              setExtras((current) => current.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));
            return (
              // Rows are only appended or removed from the end, so the index is a stable key.
              <div key={index} className="grid grid-cols-[4rem_1fr] items-start gap-x-2">
                <span className="space-y-1">
                  <CurrencyInput
                    name="extraCurrency"
                    value={row.currency}
                    onChange={(currency) => set({ currency })}
                    className={`${fieldInputCls} px-2`}
                    placeholder="EUR"
                    aria-label="Another currency"
                    exclude={{ codes: amountRows, reason: 'That currency has a row above.' }}
                  />
                </span>
                <span className="space-y-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    name="extraAmount"
                    placeholder="5.00"
                    value={row.amount}
                    onChange={(e) => set({ amount: e.currentTarget.value })}
                    aria-label={`Amount off in ${row.currency || 'that currency'}`}
                    aria-invalid={note?.bad || undefined}
                    className={`${fieldInputCls} font-mono`}
                  />
                  {note && (
                    <span className={note.bad ? 'block text-xs text-red-600 dark:text-red-400' : hintCls}>{note.text}</span>
                  )}
                </span>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              className={quietButton}
              onClick={() => setExtras((current) => [...current, { currency: '', amount: '' }])}
            >
              + Another currency
            </button>
            {extras.length > 0 && (
              <button type="button" className={quietButton} onClick={() => setExtras((current) => current.slice(0, -1))}>
                Remove the last one
              </button>
            )}
          </div>
          <span className={hintCls}>
            One row per currency the plans in scope sell in. Type each amount the way that currency is
            written. A row left empty is a currency the coupon does not work in.
          </span>
        </fieldset>
      )}

      <p
        id={warningId}
        role="status"
        className={`rounded-md border px-3 py-2 text-xs ${
          refusedIn.length > 0
            ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'border-[var(--color-border)] text-[var(--color-muted-fg)]'
        }`}
      >
        {refusedIn.length > 0
          ? `Will be refused in ${refusedIn.join(', ')}. A buyer charged in ${
              refusedIn.length === 1 ? 'that currency' : 'one of those currencies'
            } is told the code does not work for their price, and can continue at full price.`
          : covered === null
            ? 'Works on a price in any currency.'
            : inScope.length === 0
              ? 'No plan in scope has a price yet, so there is nothing to compare the coverage with.'
              : 'Covers every currency the plans in scope sell in.'}
      </p>
    </div>
  );
}
