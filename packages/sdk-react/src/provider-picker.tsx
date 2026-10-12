'use client';

/**
 * `<ProviderPicker>`, a "Pay with…" radio-card group, Clerk-shaped.
 *
 * ── Why the provider list is a PROP (read this) ──
 *
 * An Application can enable up to 3 billing providers (`stripe` / `paypal` /
 * `razorpay`). Checkout takes an optional `provider`; when omitted, a server-side
 * geo router auto-picks from the enabled set. `<ProviderPicker>` lets the end-user
 * override that pick. The list is a PROP (not fetched here) so the component stays
 * presentational and composes with both server- and client-rendered flows, fetch
 * it with the browser client's `listBillingProviders()` (publishable key, like
 * `getPlans()`) or the node SDK's `billing.getProviders()` and pass it in, the same
 * posture as `<PricingTable plans>`.
 *
 * ── Form-field model ──
 *
 * The picker is a radio group whose selected value posts as `provider` in
 * FormData, so it composes with the existing checkout `<form action={…}>` with
 * ZERO client JS in uncontrolled mode (the browser submits the checked radio).
 * For richer UIs it also supports a controlled `value` + `onChange` pair.
 *
 * This file carries the `'use client'` boundary because the controlled mode and
 * the interactive `<PricingTable providers>` variant use React state. The plain
 * (no-providers) `<PricingTable>` stays a server component, it never imports
 * this module's stateful paths at render time.
 */

import * as React from 'react';
import { Themed, useCx, type AppearanceProp } from './theme.js';
import {
  PricingGrid,
  providerCanCharge,
  providerCanChargePlan,
  type PricingGridProps,
} from './pricing-shared.js';
import type { BillingProvider, BillingProviderInfoDto } from '@rekey.dev/shared-types';

/**
 * One selectable provider, a genuine slice of `BillingProviderInfoDto` (the
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
   * fallback map when present, so a provider added server-side renders its
   * proper label without an SDK update.
   */
  label?: BillingProviderInfoDto['label'] | undefined;
  /**
   * The currencies this provider account charges, as the API returned them.
   * An empty list charges nothing. Leave the field out when you have no list
   * and the provider is treated as able to charge. A provider is not posted
   * with a plan it cannot charge.
   */
  currencies?: BillingProviderInfoDto['currencies'] | undefined;
};

/** `routed` when the list still offers it, otherwise the first entry. */
function initialProvider(
  providers: readonly ProviderOption[],
  routed: string | null | undefined,
): BillingProvider | undefined {
  const match = routed ? providers.find((opt) => opt.provider === routed) : undefined;
  return (match ?? providers[0])?.provider;
}

/**
 * Built-in fallback labels for the three bundled providers. The server's
 * `label` (P4 discovery) wins when present; an unknown provider from a newer
 * server degrades to a capitalized name, never a broken flow.
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
   * Providers to offer, fetch with `listBillingProviders()` (browser, publishable
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
   * Uncontrolled initial selection. Defaults to `routedProvider`, then to the
   * first provider in the list. Ignored when `value` is supplied.
   */
  defaultValue?: BillingProvider;
  /**
   * `routedProvider` from the provider list response: the provider a checkout
   * that names none is sent to. Selected by default when the list offers it.
   */
  routedProvider?: string | null | undefined;
  /**
   * The currency (ISO 4217) of the one plan this picker is for. Providers
   * that cannot charge it are left out. Not needed when the list was fetched
   * with that plan's `planSlug`, which filters it on the server.
   */
  currency?: string | undefined;
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
  providers: allProviders,
  name = 'provider',
  defaultValue,
  routedProvider,
  currency,
  value,
  onChange,
  label = 'Pay with',
}: ProviderPickerProps): React.JSX.Element | null {
  const cx = useCx();
  // A stable id so the visual label associates with the radiogroup for a11y.
  const groupId = React.useId();

  const providers = currency
    ? allProviders.filter((opt) => providerCanCharge(opt, currency))
    : allProviders;
  const controlled = value !== undefined;
  const [uncontrolled, setUncontrolled] = React.useState<BillingProvider | undefined>(
    defaultValue ?? initialProvider(providers, routedProvider),
  );
  const chosen = controlled ? value : uncontrolled;
  // A choice the list does not offer (its currency filter dropped it) falls
  // back, so the form never posts a provider that is not on screen.
  const selected = providers.some((opt) => opt.provider === chosen)
    ? chosen
    : initialProvider(providers, routedProvider);

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
 * A themed "Pay with…" radio-card group, one option per enabled billing
 * provider. The selected value posts as `provider` in the surrounding form's
 * FormData (uncontrolled, zero-JS) or drives a controlled `value`/`onChange`
 * pair. Friendly names (Stripe / PayPal / Razorpay), a labelled radiogroup, and
 * keyboard navigation come built in.
 *
 * The provider list is passed in (fetch it with `listBillingProviders()` or the
 * node SDK's `billing.getProviders()`). Pass the response's `routedProvider`
 * too and it is selected by default; otherwise the first provider is.
 *
 * @example
 * ```tsx
 * // Server: const { providers, routedProvider } =
 * //   await rekey.billing.getProviders(country, { planSlug: 'pro_monthly' });
 * // The picker posts the selected provider as `provider` in this form's FormData.
 * <form action={checkoutAction}>
 *   <input type="hidden" name="planSlug" value="pro_monthly" />
 *   <ProviderPicker providers={providers} routedProvider={routedProvider} />
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
// <PricingTableInteractive>, the provider-aware <PricingTable> variant
// ---------------------------------------------------------------------------

/** Props the interactive pricing table needs (the grid props + the provider list). */
export interface PricingTableInteractiveProps extends PricingGridProps {
  /** Providers to offer above the grid. */
  providers: ProviderOption[];
  /** `routedProvider` from the provider list response. Selected by default; otherwise the first is. */
  routedProvider?: string | null | undefined;
  appearance?: AppearanceProp;
  className?: string;
}

/**
 * The interactive `<PricingTable>` body used ONLY when a `providers` list is
 * passed. It holds the selected provider in client state, renders a controlled
 * `<ProviderPicker>` above the grid, and threads the selected provider into
 * the checkout form of each plan it can charge, so the plan the user buys
 * carries their provider choice into `billing.createCheckout`.
 *
 * Two kinds of plan post no `provider`, and the API routes them. A plan none
 * of whose prices the selected provider can charge, which says so on its
 * card. And a plan with more than one price while the picker still shows the
 * provider it preselected: that selection is not the buyer's choice, and
 * posting it would let it decide which of the plan's prices they pay.
 *
 * This is a separate client component so the plain (no-providers)
 * `<PricingTable>` can stay a Server Component; the dispatcher in
 * `billing-components.tsx` only reaches for this when `providers?.length`.
 */
export function PricingTableInteractive({
  providers, routedProvider, appearance, className, hiddenFields, orgGateBlocking, ...gridProps
}: PricingTableInteractiveProps): React.JSX.Element {
  // A provider that can charge none of the plans on show, at any of their
  // prices, is not worth offering.
  const paidPlans = gridProps.plans.filter((plan) => !plan.isFree && plan.prices.length > 0);
  const offered =
    paidPlans.length === 0
      ? providers
      : providers.filter((opt) => paidPlans.some((plan) => providerCanChargePlan(opt, plan)));
  const preselected = initialProvider(offered, routedProvider);
  // Undefined until the buyer touches the picker.
  const [picked, setPicked] = React.useState<BillingProvider | undefined>(undefined);
  const selected =
    offered.find((opt) => opt.provider === picked) ?? offered.find((opt) => opt.provider === preselected);

  return (
    <Themed appearance={appearance} className={className}>
      {/* Hide the picker behind the org gate, there's nothing to pay with yet. */}
      {!orgGateBlocking && selected !== undefined && (
        <ProviderPickerBody
          providers={offered}
          value={selected.provider}
          onChange={setPicked}
        />
      )}
      <PricingGrid
        {...gridProps}
        {...(orgGateBlocking ? { orgGateBlocking } : {})}
        {...(hiddenFields ? { hiddenFields } : {})}
        {...(selected !== undefined
          ? {
              selectedProvider: {
                provider: selected.provider,
                currencies: selected.currencies,
                label: providerLabel(selected),
                chosen: selected.provider !== preselected,
              },
            }
          : {})}
      />
    </Themed>
  );
}
