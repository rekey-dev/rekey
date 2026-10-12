'use client';

import * as React from 'react';
import { Field, fieldInputCls } from '@/components/Field';
import { grantCurrencyControl, grantRestriction, type GrantPlanOption, type HeldSubscription } from '@/lib/grant-currencies';

/**
 * The plan and currency pickers of the grant dialog. A client component
 * because the currencies on offer are the chosen plan's, less the ones the
 * end-user's existing subscription to it switches off.
 *
 * Both selects are held in state. React resets a form's uncontrolled fields
 * after its action runs, and a select does not take a new default without a
 * remount, so a refused grant would otherwise lose the choice.
 */
export function GrantPlanFields({
  plans,
  held,
  keptPlanSlug,
  keptCurrency,
}: {
  plans: GrantPlanOption[];
  /** What this end-user already holds, so a grant the API would refuse is said before it is sent. */
  held: readonly HeldSubscription[];
  /** Echoed back on a refusal so the choice is not lost. */
  keptPlanSlug: string | undefined;
  keptCurrency: string | undefined;
}): React.JSX.Element {
  const [planSlug, setPlanSlug] = React.useState(
    plans.some((plan) => plan.slug === keptPlanSlug) ? (keptPlanSlug ?? '') : '',
  );
  const [currency, setCurrency] = React.useState(keptCurrency ?? '');
  const prices = plans.find((plan) => plan.slug === planSlug)?.prices ?? [];
  const restriction = grantRestriction(held, planSlug);
  const restrictionId = React.useId();
  const control = grantCurrencyControl(prices, restriction, currency);

  return (
    <>
      <Field label="Plan" required hint="Active plans only. Withdrawn plans can still be granted through the API.">
        <select
          name="planSlug"
          required
          value={planSlug}
          onChange={(e) => {
            setPlanSlug(e.currentTarget.value);
            setCurrency('');
          }}
          className={fieldInputCls}
        >
          <option value="" disabled>
            Pick a plan…
          </option>
          {plans.map((plan) => (
            <option key={plan.slug} value={plan.slug}>
              {plan.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Billed in"
        hint="What this subscriber pays, which is what MRR and subscription events report. Plan default takes the plan’s default price. A subscriber keeps their currency for the life of the subscription."
      >
        <select
          name="currency"
          value={control.value}
          onChange={(e) => setCurrency(e.currentTarget.value)}
          aria-describedby={restriction.kind === 'none' ? undefined : restrictionId}
          title={restriction.kind === 'none' ? undefined : restriction.reason}
          className={fieldInputCls}
        >
          {control.choices.map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </select>
      </Field>
      {restriction.kind !== 'none' && (
        <p
          id={restrictionId}
          role="status"
          className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {restriction.reason}
        </p>
      )}
    </>
  );
}
