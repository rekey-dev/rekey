import * as React from 'react';
import { planLocalPricesChoices, type PlanLocalPricesRule } from '@/lib/plan-prices';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { setPlanLocalPrices } from './price-actions';

const choiceButton =
  'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60';
const chosenButton =
  'cursor-default rounded-md border border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] px-3 py-1.5 text-sm text-[var(--color-primary)]';

/**
 * Whether a buyer's country may select one of this plan's other prices: the
 * three choices, what each does, and the one in force.
 */
export function PlanLocalPricesControl({
  applicationId,
  plan,
  defaultCurrency,
}: {
  applicationId: string;
  plan: { id: string; slug: string; localPrices: PlanLocalPricesRule };
  defaultCurrency: string;
}): React.JSX.Element {
  const choices = planLocalPricesChoices(defaultCurrency);
  const ref = { id: plan.id, slug: plan.slug };
  return (
    <div className="space-y-2">
      <div>
        <h4 className="text-xs font-medium text-[var(--color-fg)]">Local prices on this plan</h4>
        <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
          Whether a buyer&rsquo;s country may select one of the prices above. A credit pack starts as verified
          country only, because every price of a pack grants the same credits. Each change is written to the
          billing log.
        </p>
      </div>
      <dl className="space-y-1.5 text-xs">
        {choices.map((choice) => (
          <div key={choice.value}>
            <dt className="font-medium text-[var(--color-fg)]">{choice.label}</dt>
            <dd className="text-[var(--color-muted-fg)]">{choice.consequence}</dd>
          </div>
        ))}
      </dl>
      <div role="group" aria-label="Local prices on this plan" className="flex flex-wrap items-center gap-2">
        {choices.map((choice) => (
          <ActionForm key={choice.value} action={setPlanLocalPrices.bind(null, applicationId, ref, choice.value)}>
            {plan.localPrices === choice.value ? (
              <button type="button" disabled aria-pressed="true" className={chosenButton}>
                {choice.label} ✓
              </button>
            ) : (
              <SubmitButton pendingLabel="Switching…" aria-pressed="false" className={choiceButton}>
                {choice.label}
              </SubmitButton>
            )}
          </ActionForm>
        ))}
      </div>
    </div>
  );
}
