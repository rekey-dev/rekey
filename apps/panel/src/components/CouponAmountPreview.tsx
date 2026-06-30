'use client';

/**
 * Live preview for the coupon "Amount" field — formats the cents/percent
 * value as the operator types so the cents-vs-dollars ambiguity is
 * removed (UX-AUDIT MEDIUM #20).
 *
 * Wraps the inputs as a controlled trio so we can render the preview
 * underneath. Same input semantics as before: `amountOff` is the number
 * value the form posts to the server; `discountType` + `currency` are
 * the standard selects.
 */

import * as React from 'react';

export function CouponAmountPreview({
  inputClassName,
}: {
  inputClassName: string;
}): React.JSX.Element {
  const [type, setType] = React.useState('PERCENT');
  const [amount, setAmount] = React.useState('');
  const [currency, setCurrency] = React.useState('');
  const n = Number(amount);
  const showPreview = Number.isFinite(n) && n > 0;

  let preview: string | null = null;
  if (showPreview) {
    if (type === 'PERCENT') {
      if (n <= 100) preview = `= ${n}% off`;
      else preview = '× percent must be 1–100';
    } else {
      const major = (n / 100).toFixed(n % 100 === 0 ? 0 : 2);
      const cur = currency.trim().toUpperCase() || 'USD';
      preview = `= ${cur} ${major}`;
    }
  }

  return (
    <>
      <div className="contents">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-[var(--color-fg)]">Type</span>
          <select
            name="discountType"
            value={type}
            onChange={(e) => setType(e.currentTarget.value)}
            className={inputClassName}
          >
            <option value="PERCENT">Percent off</option>
            <option value="AMOUNT">Fixed amount off</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-[var(--color-fg)]">
            Amount
            <span className="text-[var(--color-primary)] ml-0.5">*</span>
          </span>
          <input
            type="number"
            name="amountOff"
            required
            min={1}
            step={1}
            placeholder={type === 'PERCENT' ? '15' : '500'}
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            className={`${inputClassName} font-mono`}
            aria-describedby="coupon-amount-preview"
          />
          <span
            id="coupon-amount-preview"
            aria-live="polite"
            className="block text-xs text-[var(--color-muted-fg)]"
          >
            {preview ??
              (type === 'PERCENT'
                ? 'Percent: 1–100 (e.g. 15).'
                : 'Fixed: cents (e.g. 500 = $5.00).')}
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-[var(--color-fg)]">
            Currency
            {type === 'AMOUNT' && <span className="text-[var(--color-primary)] ml-0.5">*</span>}
          </span>
          <input
            type="text"
            name="currency"
            maxLength={3}
            minLength={type === 'AMOUNT' ? 3 : 0}
            placeholder="USD"
            value={currency}
            onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
            className={`${inputClassName} font-mono`}
            required={type === 'AMOUNT'}
          />
          <span className="block text-xs text-[var(--color-muted-fg)]">
            Required for fixed-amount coupons (ISO 4217).
          </span>
        </label>
      </div>
    </>
  );
}
