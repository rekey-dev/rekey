'use client';

import * as React from 'react';
import { ActionForm } from '@/components/ActionForm';
import { dangerButtonClass } from '@/components/Button';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Field, fieldInputCls } from '@/components/Field';
import { formatMoney } from '@/lib/format';
import { minorToMajorText } from '@/lib/money-input';
import { amountRule } from '@/lib/price-currencies';
import { readRefundAmount } from '@/lib/refunds';

/**
 * The operator refund form. A client component for what it says while the
 * amount is typed: what it comes to, and that it is more than what remains,
 * before anything is sent.
 */
export function RefundForm({
  action,
  currency,
  remaining,
  providerNote,
}: {
  action: (formData: FormData) => void | Promise<void>;
  currency: string;
  /** What has not been refunded, smallest unit. */
  remaining: number;
  /** Who is asked to pay the money back, for the confirmation. */
  providerNote: string;
}): React.JSX.Element {
  const [amount, setAmount] = React.useState('');
  const [reason, setReason] = React.useState('');
  const noteId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const read = readRefundAmount(amount, currency, remaining);
  const all = formatMoney(remaining, currency);
  const invalid = read.ok ? '' : read.message;
  React.useEffect(() => {
    inputRef.current?.setCustomValidity(invalid);
  }, [invalid]);
  const sending = read.ok ? (read.amount === undefined ? all : formatMoney(read.amount, currency)) : null;

  return (
    <ActionForm action={action} className="space-y-3">
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-[var(--color-fg)]">Amount in {currency}</span>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            name="amount"
            placeholder={minorToMajorText(remaining, currency) ?? ''}
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            aria-invalid={!read.ok || undefined}
            aria-describedby={noteId}
            className={`${fieldInputCls} font-mono`}
          />
          <span
            id={noteId}
            role={read.ok ? 'status' : 'alert'}
            className={`block text-xs ${read.ok ? 'text-[var(--color-muted-fg)]' : 'text-red-600 dark:text-red-400'}`}
          >
            {!read.ok
              ? read.message
              : read.amount === undefined
                ? `Leave empty to refund everything that remains: ${all}. ${amountRule(currency) ?? ''}`
                : `Refunds ${formatMoney(read.amount, currency)} of the ${all} that remains.`}
          </span>
        </label>
        <Field label="Reason" hint="Optional. Kept on the refund, and sent to the provider where it takes one.">
          <input
            type="text"
            name="reason"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            className={fieldInputCls}
          />
        </Field>
      </div>
      <p className="text-xs text-[var(--color-muted-fg)]">
        A refund sends money back. It does not cancel a subscription and does not take back credits or
        licences: do those separately if they should go too.
      </p>
      {sending !== null ? (
        <ConfirmButton
          title={`Refund ${sending}?`}
          confirm={`${providerNote} is asked to pay ${sending} back to the buyer. This cannot be undone from here. The subscription, credits and licences are left as they are.`}
          confirmLabel={`Refund ${sending}`}
          variant="danger"
          triggerClassName={dangerButtonClass('sm')}
        >
          Refund
        </ConfirmButton>
      ) : (
        <button
          type="button"
          disabled
          aria-describedby={noteId}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] opacity-60"
        >
          Refund
        </button>
      )}
    </ActionForm>
  );
}
