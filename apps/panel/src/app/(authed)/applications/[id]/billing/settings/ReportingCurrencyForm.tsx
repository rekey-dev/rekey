'use client';

import * as React from 'react';
import { ActionForm } from '@/components/ActionForm';
import { CurrencyInput } from '@/components/CurrencyCatalog';
import { Field, FieldRowAction, fieldInputCls, fieldRowCls } from '@/components/Field';
import { SubmitButton } from '@/components/SubmitButton';

/**
 * The reporting currency picker. The code is held in state so a refused save
 * keeps what was typed; the page remounts the form when the saved value
 * changes.
 */
export function ReportingCurrencyForm({
  action,
  current,
  currentName,
  writeRefusal,
}: {
  action: (formData: FormData) => void | Promise<void>;
  current: string;
  currentName: string;
  /** Why this operator cannot change it, or null when they can. */
  writeRefusal: string | null;
}): React.JSX.Element {
  const [currency, setCurrency] = React.useState(current);
  const refusalId = React.useId();

  if (writeRefusal !== null) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-[var(--color-fg)]">
          <span className="font-mono">{current}</span> {currentName}
        </p>
        <button
          type="button"
          disabled
          aria-describedby={refusalId}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] opacity-60"
        >
          Change
        </button>
        <p id={refusalId} className="text-xs text-[var(--color-muted-fg)]">
          {writeRefusal}
        </p>
      </div>
    );
  }

  return (
    <ActionForm action={action} className={`${fieldRowCls} max-w-md sm:grid-cols-[1fr_auto]`}>
      <Field label="Reporting currency" hint={`Now ${current}, ${currentName}. Any currency a plan can be priced in.`}>
        <CurrencyInput name="reportingCurrency" value={currency} onChange={setCurrency} required className={fieldInputCls} />
      </Field>
      <FieldRowAction>
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </FieldRowAction>
    </ActionForm>
  );
}
