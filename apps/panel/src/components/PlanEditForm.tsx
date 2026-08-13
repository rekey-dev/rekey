'use client';

/**
 * Edit an existing plan.
 *
 * The capability was everywhere except here: `plansService.update`, a REST
 * `PATCH`, and the `update_plan` MCP tool all shipped, so an AI agent could
 * correct a plan while the operator who created it could not. The plans table
 * offered only Entitlements / Archive / Reactivate, and a plan created with a
 * typo or a missing price had to be archived and re-created under a NEW slug,
 * because archiving does not release the old one. Reported as #30.
 *
 * ## Why the price fields disappear once a plan is registered
 *
 * A provider price object is immutable once minted — Stripe will not let a
 * `price` change amount, currency or interval, and neither will PayPal. The API
 * enforces this with `PLAN_PRICE_IMMUTABLE`, so rendering those inputs for a
 * registered plan would offer an edit that is refused on submit. The name and
 * metadata are ours alone and stay editable always.
 *
 * That makes this form the documented repair path for the other half of the
 * problem too: a plan whose registration FAILED is un-purchasable and still
 * unregistered, so its price is editable here — fix it, then retry Register.
 */

import * as React from 'react';
import { SubmitButton } from './SubmitButton';
import { Banner } from './Banner';

const ERR: Record<string, string> = {
  missing: 'Name cannot be empty.',
  PLAN_NOT_FOUND: 'That plan no longer exists.',
  PLAN_PRICE_IMMUTABLE:
    'This plan is registered with the payment provider, so its price can no longer change. Archive it and create a replacement at the new price.',
  PLAN_NOT_REGISTERED_WITH_PROVIDER:
    'This plan has no provider price yet, so it cannot be published. Register it first.',
  TENANT_ROLE_INSUFFICIENT: 'You do not have billing-write access to this Application.',
  APP_ACCESS_DENIED: 'You do not have billing-write access to this Application.',
};

export interface EditablePlan {
  slug: string;
  name: string;
  amount: number;
  currency: string;
  interval: 'MONTH' | 'YEAR';
  /** Price is only editable while no provider price exists. */
  priceEditable: boolean;
}

export function PlanEditForm({
  plan,
  action,
  error,
}: {
  plan: EditablePlan;
  action: (formData: FormData) => void | Promise<void>;
  error?: string | undefined;
}): React.JSX.Element {
  const label = 'block text-xs font-medium text-[var(--color-muted-fg)]';
  const input =
    'mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';

  return (
    <form action={action} className="space-y-4">
      {error && <Banner tone="error">{ERR[error] ?? 'Could not save the plan.'}</Banner>}

      <div>
        <label className={label} htmlFor="plan-edit-name">
          Display name
        </label>
        <input
          id="plan-edit-name"
          name="name"
          defaultValue={plan.name}
          required
          maxLength={120}
          className={input}
        />
        <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
          Shown on your pricing page and in the customer portal.
        </p>
      </div>

      <div>
        <span className={label}>Slug</span>
        <p className="mt-1 font-mono text-sm text-[var(--color-fg)]">{plan.slug}</p>
        <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
          Permanent. Your integration passes this to checkout and reads it back off a
          subscription, so changing it would break live callers — and archiving keeps it
          reserved for the same reason.
        </p>
      </div>

      {plan.priceEditable ? (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={label} htmlFor="plan-edit-amount">
              Amount (minor units)
            </label>
            <input
              id="plan-edit-amount"
              name="amount"
              type="number"
              min={0}
              defaultValue={plan.amount}
              className={input}
            />
          </div>
          <div>
            <label className={label} htmlFor="plan-edit-currency">
              Currency
            </label>
            <input
              id="plan-edit-currency"
              name="currency"
              defaultValue={plan.currency}
              minLength={3}
              maxLength={3}
              className={`${input} uppercase`}
            />
          </div>
          <div>
            <label className={label} htmlFor="plan-edit-interval">
              Interval
            </label>
            <select
              id="plan-edit-interval"
              name="interval"
              defaultValue={plan.interval}
              className={input}
            >
              <option value="MONTH">Monthly</option>
              <option value="YEAR">Yearly</option>
            </select>
          </div>
        </div>
      ) : (
        <div>
          <span className={label}>Price</span>
          <p className="mt-1 text-sm text-[var(--color-fg)]">
            {(plan.amount / 100).toFixed(2)} {plan.currency.toUpperCase()} /{' '}
            {plan.interval.toLowerCase()}
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
            Locked. The payment provider has minted a price for this plan and a provider
            price cannot change. To sell at a different price, archive this plan and
            create a replacement.
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      </div>
    </form>
  );
}
