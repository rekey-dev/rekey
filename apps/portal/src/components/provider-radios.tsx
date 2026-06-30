/**
 * "Pay with…" radio group for the checkout confirm dialog. Plain uncontrolled
 * radios so the browser submits the checked one as `provider` in the form's
 * FormData — zero client JS. The first provider (the geo router's top pick) is
 * checked by default. Rendered only when an app has more than one provider; with
 * one (or none) the server-side router picks automatically.
 */

import type { BillingProviderInfoDto } from '@relipay/react';

const LABELS: Record<string, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  razorpay: 'Razorpay',
};

export function ProviderRadios({
  providers,
  name = 'provider',
}: {
  providers: BillingProviderInfoDto[];
  name?: string;
}): React.JSX.Element {
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-[var(--color-muted-fg)]">Pay with</legend>
      <div className="space-y-1.5">
        {providers.map((p, i) => (
          <label
            key={p.provider}
            className="flex cursor-pointer items-center gap-2.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg)]"
          >
            <input type="radio" name={name} value={p.provider} defaultChecked={i === 0} />
            <span className="font-medium text-[var(--color-fg)]">{LABELS[p.provider] ?? p.provider}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
