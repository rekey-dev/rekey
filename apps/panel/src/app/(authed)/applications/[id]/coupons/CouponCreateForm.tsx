'use client';

import * as React from 'react';
import { ActionForm } from '@/components/ActionForm';
import { Field, fieldInputCls } from '@/components/Field';
import { SubmitButton } from '@/components/SubmitButton';
import { CouponLimitFields } from './CouponLimitFields';
import { CouponTermsFields, type CouponPlanOption } from './CouponTermsFields';

/**
 * The new-coupon form. A client component so that a refused save keeps every
 * field: React resets uncontrolled fields after a form's action runs. The
 * page remounts it after a successful create, which is what empties it.
 */
export function CouponCreateForm({
  action,
  plans,
  reportingCurrency,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  plans: readonly CouponPlanOption[];
  reportingCurrency: string;
  /** The error banner for the last refused save. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const [code, setCode] = React.useState('');

  return (
    <ActionForm action={action} className="space-y-4">
      {children}
      <Field label="Code" required hint="What a buyer types at checkout. Not case-sensitive.">
        <input
          type="text"
          name="code"
          required
          placeholder="LAUNCH50"
          maxLength={40}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
          className={`${fieldInputCls} font-mono uppercase`}
        />
      </Field>
      <CouponTermsFields plans={plans} reportingCurrency={reportingCurrency} />
      <CouponLimitFields />
      <p className="text-xs text-[var(--color-muted-fg)]">
        Everything here except the code and the kind of discount can be edited later.
      </p>
      <SubmitButton pendingLabel="Adding coupon…">Add coupon</SubmitButton>
    </ActionForm>
  );
}
