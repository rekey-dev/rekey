'use client';

/**
 * `<ProviderPicker>` — a "Pay with…" radio-card group, Clerk-shaped.
 *
 * ── Why the provider list is a PROP (read this) ──
 *
 * An Application can enable up to 3 billing providers (`stripe` / `paypal` /
 * `razorpay`). Checkout takes an optional `provider`; when omitted, a server-side
 * geo router auto-picks from the enabled set. `<ProviderPicker>` lets the end-user
 * override that pick. The list is a PROP (not fetched here) so the component stays
 * presentational and composes with both server- and client-rendered flows — fetch
 * it with the browser client's `listBillingProviders()` (publishable key, like
 * `getPlans()`) or the node SDK's `billing.getProviders()` and pass it in, the same
 * posture as `<PricingTable plans>`.
 *
 * ── Form-field model ──
 *
 * The picker is a radio group whose selected value posts as `provider` in
 * FormData — so it composes with the existing checkout `<form action={…}>` with
 * ZERO client JS in uncontrolled mode (the browser submits the checked radio).
 * For richer UIs it also supports a controlled `value` + `onChange` pair.
 *
 * This file carries the `'use client'` boundary because the controlled mode and
 * the interactive `<PricingTable providers>` variant use React state. The plain
 * (no-providers) `<PricingTable>` stays a server component — it never imports
 * this module's stateful paths at render time.
 */

import * as React from 'react';
import { Themed, useCx, type AppearanceProp } from './theme.js';
import { PricingGrid, type PricingGridProps } from './pricing-shared.js';
import type { BillingProvider, BillingProviderInfoDto } from '@rekey.dev/shared-types';

/**
 * One selectable provider — a genuine slice of `BillingProviderInfoDto` (the
 * shape `billing.getProviders()` / `listBillingProviders()` return) rather than
 * a look-alike interface, so field drift in shared-types is a compile error
 * here. Only `provider` is required, so callers can pass a bare
 * `[{ provider: 'stripe' }]` when they don't have routing data.
 */
export type ProviderOption = Pick<BillingProviderInfoDto, 'provider'> & {
  /** The geo router's preference rank (lower = preferred). Display-only. */
  priority?: BillingProviderInfoDto['priority'] | undefined;
  /** ISO 3166-1 alpha-2 countries this provider is routed for. Display-only. */
  countries?: BillingProviderInfoDto['countries'] | undefined;
  /**
   * Server-provided display name (P4 discovery). Preferred over the built-in
   * fallback map when present — so a provider added server-side renders its
   * proper label without an SDK update.
   */
  label?: BillingProviderInfoDto['label'] | undefined;
};

/**
 * Built-in fallback labels for the three bundled providers. The server's
 * `label` (P4 discovery) wins when present; an unknown provider from a newer
 * server degrades to a capitalized name — never a broken flow.
 */
const PROVIDER_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  razorpay: 'Razorpay',
};

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function providerLabel(opt: ProviderOption): string {
  return opt.label ?? PROVIDER_LABELS[opt.provider] ?? capitalize(opt.provider);
}

export interface ProviderPickerProps {
  /**
   * Providers to offer — fetch with `listBillingProviders()` (browser, publishable
   * key) or `billing.getProviders()` (node SDK) and pass here. The first entry is
   * the geo router's top pick and is selected by default.
   */
  providers: ProviderOption[];
  /**
   * Form field name the selected provider posts under. Default `"provider"` so it
   * threads straight into `billing.createCheckout`'s `provider`.
   */
  name?: string;
  /**
   * Uncontrolled initial selection. Defaults to the first provider in the list
   * (the geo router's top pick). Ignored when `value` is supplied.
   */
  defaultValue?: BillingProvider;
  /** Controlled selection. Pass with `onChange` for a controlled radio group. */
  value?: BillingProvider;
  /** Fired with the newly-selected provider in controlled mode. */
  onChange?: (provider: BillingProvider) => void;
  /** Group heading. Default `"Pay with"`. Pass `null` to omit. */
  label?: React.ReactNode;
  appearance?: AppearanceProp;
  className?: string;
}

/** The inner radio group. Assumes it's already inside a `<Themed>` scope. */
function ProviderPickerBody({
  providers,
  name = 'provider',
  defaultValue,
  value,
  onChange,
  label = 'Pay with',
}: ProviderPickerProps): React.JSX.Element | null {
  const cx = useCx();
  // A stable id so the visual label associates with the radiogroup for a11y.
  const groupId = React.useId();

  // The default selection is the first provider (geo router's top pick) unless
  // the caller pins one via `defaultValue`.
  const first = providers[0]?.provider;
  const controlled = value !== undefined;
  const [uncontrolled, setUncontrolled] = React.useState<BillingProvider | undefined>(
    defaultValue ?? first,
  );
  const selected = controlled ? value : uncontrolled;

  if (providers.length === 0) return null;

  function select(next: BillingProvider): void {
    if (!controlled) setUncontrolled(next);
    onChange?.(next);
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={label != null ? `${groupId}-label` : undefined}
      className={cx('rekey-provider-group', 'card')}
    >
      {label != null && (
        <div id={`${groupId}-label`} className={cx('rekey-label', 'label')}>
          {label}
        </div>
      )}
      <div className="rekey-provider-list">
        {providers.map((opt) => {
          const isSelected = selected === opt.provider;
          return (
            <label
              key={opt.provider}
              className={`rekey-provider-option${isSelected ? ' rekey-provider-option-selected' : ''}`}
            >
              <input
                type="radio"
                className="rekey-provider-radio"
                name={name}
                value={opt.provider}
                checked={isSelected}
                onChange={() => select(opt.provider)}
              />
              <span className="rekey-provider-dot" aria-hidden="true" />
              <span className="rekey-provider-name">{providerLabel(opt)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A themed "Pay with…" radio-card group — one option per enabled billing
 * provider. The selected value posts as `provider` in the surrounding form's
 * FormData (uncontrolled, zero-JS) or drives a controlled `value`/`onChange`
 * pair. Friendly names (Stripe / PayPal / Razorpay), a labelled radiogroup, and
 * keyboard navigation come built in.
 *
 * The provider list is passed in (fetch it with `listBillingProviders()` or the
 * node SDK's `billing.getProviders()`). The first provider is the geo router's
 * top pick and is selected by default.
 *
 * @example
 * ```tsx
 * // Server: const { providers } = await rekey.billing.getProviders(country);
 * // The picker posts the selected provider as `provider` in this form's FormData.
 * <form action={checkoutAction}>
 *   <input type="hidden" name="planSlug" value="pro_monthly" />
 *   <ProviderPicker providers={providers} />
 *   <button type="submit">Continue</button>
 * </form>
 * ```
 */
export function ProviderPicker(props: ProviderPickerProps): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className}>
      <ProviderPickerBody {...props} />
    </Themed>
  );
}

// ---------------------------------------------------------------------------
// <PricingTableInteractive> — the provider-aware <PricingTable> variant
// ---------------------------------------------------------------------------

/** Props the interactive pricing table needs (the grid props + the provider list). */
export interface PricingTableInteractiveProps extends PricingGridProps {
  /** Providers to offer above the grid. The first is the default selection. */
  providers: ProviderOption[];
  appearance?: AppearanceProp;
  className?: string;
}

/**
 * The interactive `<PricingTable>` body used ONLY when a `providers` list is
 * passed. It holds the selected provider in client state, renders a controlled
 * `<ProviderPicker>` above the grid, and threads the chosen provider into EACH
 * plan's checkout form via `hiddenFields={{ ...hiddenFields, provider }}` — so
 * whichever plan the user buys carries their provider choice into
 * `billing.createCheckout`.
 *
 * This is a separate client component so the plain (no-providers)
 * `<PricingTable>` can stay a Server Component; the dispatcher in
 * `billing-components.tsx` only reaches for this when `providers?.length`.
 */
export function PricingTableInteractive({
  providers, appearance, className, hiddenFields, orgGateBlocking, ...gridProps
}: PricingTableInteractiveProps): React.JSX.Element {
  const first = providers[0]?.provider;
  const [provider, setProvider] = React.useState<BillingProvider | undefined>(first);

  // Merge the chosen provider into the per-form hidden fields (string map). When
  // nothing is selected (empty list — shouldn't happen here) we leave it off.
  const mergedHidden: Record<string, string> = {
    ...(hiddenFields ?? {}),
    ...(provider ? { provider } : {}),
  };

  return (
    <Themed appearance={appearance} className={className}>
      {/* Hide the picker behind the org gate — there's nothing to pay with yet. */}
      {!orgGateBlocking && providers.length > 0 && (
        <ProviderPickerBody
          providers={providers}
          value={provider ?? providers[0]!.provider}
          onChange={setProvider}
        />
      )}
      <PricingGrid
        {...gridProps}
        {...(orgGateBlocking ? { orgGateBlocking } : {})}
        hiddenFields={mergedHidden}
      />
    </Themed>
  );
}
