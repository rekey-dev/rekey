/**
 * "Pay with…" radio group on the plan review page. Plain uncontrolled
 * radios so the browser submits the checked one as `provider` in the form's
 * FormData, zero client JS. The provider the API routed to is checked by
 * default when the list offers it, otherwise the first, and a hidden field
 * says which one that was so the action can tell a choice from the default.
 * Rendered only when a
 * plan has more than one provider that can charge it; with one (or none) the
 * server-side router picks automatically.
 */

import type { BillingProviderInfoDto } from '@rekey.dev/react';
import { PRESELECTED_PROVIDER_FIELD } from '@/lib/provider-capabilities';

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
  routedProvider,
  name = 'provider',
}: {
  providers: BillingProviderInfoDto[];
  /** `routedProvider` from the provider list: checked by default when offered here. */
  routedProvider?: string | null | undefined;
  name?: string;
}): React.JSX.Element {
  const checked = providers.find((p) => p.provider === routedProvider) ?? providers[0];
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-[var(--color-muted-fg)]">Pay with</legend>
      {checked !== undefined && <input type="hidden" name={PRESELECTED_PROVIDER_FIELD} value={checked.provider} />}
      <div className="space-y-1.5">
        {providers.map((p) => (
          <label
            key={p.provider}
            className="flex cursor-pointer items-center gap-2.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg)]"
          >
            <input type="radio" name={name} value={p.provider} defaultChecked={p === checked} />
            <span className="font-medium text-[var(--color-fg)]">{labelFor(p)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
