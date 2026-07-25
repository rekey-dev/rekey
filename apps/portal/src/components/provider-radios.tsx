/**
 * "Pay with…" radio group for the checkout confirm dialog. Plain uncontrolled
 * radios so the browser submits the checked one as `provider` in the form's
 * FormData — zero client JS. The first provider (the geo router's top pick) is
 * checked by default. Rendered only when an app has more than one provider; with
 * one (or none) the server-side router picks automatically.
 */

import type { BillingProviderInfoDto } from '@relipay/react';

/**
 * Built-in fallback labels for the three bundled providers. The server's
 * `label` (P4 discovery, carried on the already-fetched providers list) wins
 * when present; an unknown provider degrades to a capitalized name.
 */
const LABELS: Record<string, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  razorpay: 'Razorpay',
};

function labelFor(p: BillingProviderInfoDto): string {
  return (
    p.label ??
    LABELS[p.provider] ??
    (p.provider.length === 0 ? p.provider : p.provider[0]!.toUpperCase() + p.provider.slice(1))
  );
}

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
            <span className="font-medium text-[var(--color-fg)]">{labelFor(p)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
