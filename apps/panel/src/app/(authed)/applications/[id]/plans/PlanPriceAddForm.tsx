'use client';

import * as React from 'react';
import { ActionForm } from '@/components/ActionForm';
import { CurrencyInput } from '@/components/CurrencyCatalog';
import { Field, fieldInputCls } from '@/components/Field';
import { SubmitButton } from '@/components/SubmitButton';
import { isNewAdd, priceAmountPreview } from '@/lib/plan-prices';
import { amountRule } from '@/lib/price-currencies';

/**
 * Add a price in another currency. A client component for what it says while
 * the operator types: whether the currency can be sold in and charged, and
 * the price exactly as it will be saved.
 *
 * The amount is typed the way the currency is written (1499 or 19.99), like
 * every amount field in the panel.
 *
 * Every field is held in state, because React resets a form's uncontrolled
 * fields after its action runs, refused or not: a refused save would lose
 * what was typed. Only a successful add empties the fields. A save elsewhere
 * in the dialog (another price's countries, a removal) leaves a half-typed
 * price alone.
 */
export function PlanPriceAddForm({
  action,
  taken,
  addedToken,
}: {
  action: (formData: FormData) => void | Promise<void>;
  /** The currencies the plan already has a price in, the default included. */
  taken: readonly string[];
  /** Present on the render that follows a successful add, different for each one. */
  addedToken: string | undefined;
}): React.JSX.Element {
  const [currency, setCurrency] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [countries, setCountries] = React.useState('');
  const [seenToken, setSeenToken] = React.useState(addedToken);
  if (addedToken !== seenToken) {
    setSeenToken(addedToken);
    if (isNewAdd(seenToken, addedToken)) {
      setCurrency('');
      setAmount('');
      setCountries('');
    }
  }
  const preview = priceAmountPreview(amount, currency);
  const rule = /^[A-Za-z]{3}$/.test(currency) ? amountRule(currency) : null;

  return (
    <ActionForm action={action} className="space-y-3">
      <h4 className="text-xs font-medium text-[var(--color-fg)]">Add a price in another currency</h4>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="Currency" required>
          <CurrencyInput
            name="currency"
            required
            placeholder="INR"
            value={currency}
            onChange={setCurrency}
            className={fieldInputCls}
            exclude={{
              codes: taken,
              reason: 'This plan already has a price in that currency. Change it in the list above.',
            }}
          />
        </Field>
        <Field label="Amount" required hint={preview ?? rule ?? 'As the currency is written, such as 1499 or 19.99.'}>
          <input
            name="amount"
            type="text"
            inputMode="decimal"
            required
            placeholder="1499"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            className={`${fieldInputCls} font-mono`}
          />
        </Field>
      </div>
      <Field
        label="Countries"
        hint="Optional. Two-letter codes separated by commas, such as IN, NP. Leave empty to offer this price wherever the currency is the local one."
      >
        <input
          name="countries"
          placeholder="IN, NP"
          autoComplete="off"
          value={countries}
          onChange={(e) => setCountries(e.currentTarget.value)}
          className={`${fieldInputCls} font-mono uppercase`}
        />
      </Field>
      <SubmitButton pendingLabel="Saving…">Add price</SubmitButton>
    </ActionForm>
  );
}
